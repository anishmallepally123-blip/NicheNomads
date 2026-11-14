"""Data access: everything that talks to IRSA lives in this file.

Two jobs:
  1. search_frames()  - ask IRSA which SPHEREx exposures cover a sky position
  2. fetch_cutout()   - download a small FITS cutout of one exposure

Both keep results on disk so repeated requests are fast. Searches expire after
SEARCH_TTL_SECONDS, so new SPHEREx data is picked up without code changes
(any new IRSA collection, for example the next quick release, is included
automatically because we search by instrument, not by collection name).
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import time
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx
import numpy as np
from astropy.io.votable import parse_single_table
from astropy.time import Time

from . import config


class DataSourceError(RuntimeError):
    """IRSA could not be reached or answered with an error."""


@dataclass
class Frame:
    """One SPHEREx exposure on one detector."""

    id: str               # e.g. "2025W19_1B_0116_1-D3"
    obs_id: str
    detector: int         # 1..6
    mjd: float            # start of exposure
    date: str             # ISO UTC
    exptime: float        # seconds
    wave_min: float       # detector wavelength range, microns
    wave_max: float
    collection: str       # IRSA collection, e.g. "spherex_dr1"
    release_date: str
    access_url: str       # full-frame FITS on IRSA
    cloud_url: str = ""   # same file on NASA's public AWS S3 bucket (allows partial reads)

    def public(self) -> dict:
        d = asdict(self)
        d.pop("access_url")
        d.pop("cloud_url")
        return d


_client: httpx.AsyncClient | None = None
_download_slots: asyncio.Semaphore | None = None
_frame_registry: dict[str, Frame] = {}
_state = {"last_search_utc": None, "collections": {}}


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=config.HTTP_TIMEOUT_SECONDS, follow_redirects=True)
    return _client


def _slots() -> asyncio.Semaphore:
    global _download_slots
    if _download_slots is None:
        _download_slots = asyncio.Semaphore(config.MAX_PARALLEL_DOWNLOADS)
    return _download_slots


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _cache_path(kind: str, key: str, suffix: str) -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()[:20]
    folder = config.CACHE_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{digest}{suffix}"


# ---------------------------------------------------------------- search

def _cloud_url(row) -> str:
    """HTTPS address of the file in the public S3 bucket, if the archive lists one."""
    try:
        aws = json.loads(str(row["cloud_access"]))["aws"]
        return f"https://{aws['bucket_name']}.s3.amazonaws.com/{aws['key']}"
    except Exception:
        return ""

def _parse_sia(votable_bytes: bytes) -> list[Frame]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table = parse_single_table(io.BytesIO(votable_bytes)).to_table(use_names_over_ids=True)

    best: dict[str, Frame] = {}
    for row in table:
        if str(row["dataproduct_type"]) != "image" or int(row["calib_level"]) != 2:
            continue  # skip cubes, calibration files, etc.
        band = str(row["energy_bandpassname"])  # "SPHEREx-D3"
        if "-D" not in band:
            continue
        detector = int(band.rsplit("-D", 1)[1])
        obs_id = str(row["obs_id"])
        mjd = float(row["t_min"])
        frame = Frame(
            id=f"{obs_id}-D{detector}",
            obs_id=obs_id,
            detector=detector,
            mjd=mjd,
            date=Time(mjd, format="mjd").isot,
            exptime=float(row["t_exptime"]),
            wave_min=round(float(row["em_min"]) * 1e6, 4),
            wave_max=round(float(row["em_max"]) * 1e6, 4),
            collection=str(row["obs_collection"]),
            release_date=str(row["obs_release_date"]),
            access_url=str(row["access_url"]),
            cloud_url=_cloud_url(row),
        )
        # The same exposure can appear in more than one release. Keep the newest.
        old = best.get(frame.id)
        if old is None or frame.release_date > old.release_date:
            best[frame.id] = frame
    return sorted(best.values(), key=lambda f: (f.mjd, f.detector))


async def search_frames(ra: float, dec: float, *, refresh: bool = False) -> list[Frame]:
    """All SPHEREx exposures whose footprint contains (ra, dec), oldest first."""
    key = f"{ra:.5f},{dec:.5f}"
    path = _cache_path("search", key, ".json")
    fresh = path.exists() and (time.time() - path.stat().st_mtime) < config.SEARCH_TTL_SECONDS
    if fresh and not refresh:
        frames = [Frame(**d) for d in json.loads(path.read_text())]
    else:
        params = {
            "POS": f"circle {ra:.6f} {dec:.6f} 0.0003",
            "INSTRUMENT": "SPHEREx",
            "RESPONSEFORMAT": "VOTABLE",
        }
        try:
            resp = await _http().get(config.IRSA_SIA_URL, params=params)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            if path.exists():  # IRSA is down: fall back to the stale answer
                return [Frame(**d) for d in json.loads(path.read_text())]
            raise DataSourceError(f"IRSA image search failed: {exc}") from exc
        frames = _parse_sia(resp.content)
        path.write_text(json.dumps([asdict(f) for f in frames]))
        _state["last_search_utc"] = Time.now().isot

    for f in frames:
        _frame_registry[f.id] = f
        seen = _state["collections"].setdefault(f.collection, f.date)
        if f.date > seen:
            _state["collections"][f.collection] = f.date
    return frames


async def get_frame(frame_id: str, ra: float, dec: float) -> Frame | None:
    """Look up one frame by id (searching IRSA again if we have not seen it)."""
    if frame_id not in _frame_registry:
        await search_frames(ra, dec)
    return _frame_registry.get(frame_id)


# ---------------------------------------------------------------- cutouts

async def fetch_cutout(frame: Frame, ra: float, dec: float, size_deg: float) -> Path:
    """Download a FITS cutout (all extensions) and return the local file path.

    IRSA cuts the image on its side, so we download a few MB instead of the
    65 MB full frame. Files are cached forever: a released exposure never changes.
    """
    key = f"{frame.collection}/{frame.id}/{ra:.5f},{dec:.5f}/{size_deg:.4f}"
    path = _cache_path("cutouts", key, ".fits")
    if path.exists() and path.stat().st_size > 0:
        return path
    params = {"center": f"{ra:.6f},{dec:.6f}deg", "size": f"{size_deg:.5f}deg"}
    async with _slots():
        if path.exists() and path.stat().st_size > 0:
            return path
        resp = None
        # IRSA answers "503 Server busy" when it gets many requests at once,
        # so wait a little and try again before giving up.
        for attempt in range(config.DOWNLOAD_RETRIES + 1):
            try:
                resp = await _http().get(frame.access_url, params=params)
                if resp.status_code in (429, 502, 503, 504) and attempt < config.DOWNLOAD_RETRIES:
                    await asyncio.sleep(min(8.0, 0.75 * 2 ** attempt))
                    continue
                resp.raise_for_status()
                break
            except httpx.HTTPError as exc:
                if attempt >= config.DOWNLOAD_RETRIES or isinstance(exc, httpx.HTTPStatusError):
                    raise DataSourceError(f"IRSA cutout failed for {frame.id}: {exc}") from exc
                await asyncio.sleep(min(8.0, 0.75 * 2 ** attempt))
        tmp = path.with_suffix(".part")
        tmp.write_bytes(resp.content)
        tmp.replace(path)
    return path


# ---------------------------------------------------------------- stamps (for spectra)

STAMP_HALF = 8  # pixels each side of the target: a 17 x 17 pixel (105 arcsec) stamp
_stamp_slots: asyncio.Semaphore | None = None
_epsf_tables: dict[str, object] = {}


def _stamp_sem() -> asyncio.Semaphore:
    global _stamp_slots
    if _stamp_slots is None:
        _stamp_slots = asyncio.Semaphore(config.MAX_PARALLEL_S3)
    return _stamp_slots


def _read_stamp_from_s3(frame: Frame, ra: float, dec: float, path: Path) -> Path:
    """Read only the pixels around (ra, dec) from the full exposure on S3.

    The exposures in NASA's public bucket support HTTP range requests, so
    astropy reads the headers and a 17 x 17 pixel box from each extension
    (about 1.5 s) instead of the 65 MB file or a 4 s IRSA cutout. The result
    is saved as a small FITS file with the same extensions as an IRSA cutout,
    keeping the full-frame headers so every WCS stays exact, plus STAMPX0 and
    STAMPY0 telling where the box starts.
    """
    from astropy.io import fits

    from .cutouts import alt_wcs

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hdul = fits.open(frame.cloud_url, use_fsspec=True, lazy_load_hdus=True,
                         fsspec_kwargs={"block_size": 64 * 1024, "cache_type": "blockcache"})
        with hdul:
            from astropy.wcs import WCS
            header = hdul["IMAGE"].header
            ny, nx = header["NAXIS2"], header["NAXIS1"]
            x, y = WCS(header).world_to_pixel_values(ra, dec)
            xi, yi = int(round(float(x))), int(round(float(y)))
            if not (0 <= xi < nx and 0 <= yi < ny):
                raise DataSourceError(f"{frame.id} does not cover this position")
            x0, x1 = max(0, xi - STAMP_HALF), min(nx, xi + STAMP_HALF + 1)
            y0, y1 = max(0, yi - STAMP_HALF), min(ny, yi + STAMP_HALF + 1)
            out = [fits.PrimaryHDU()]
            for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
                hdu = hdul[name]
                hdr = hdu.header.copy()
                for k in ("ZIMAGE", "ZBITPIX", "ZNAXIS", "ZNAXIS1", "ZNAXIS2", "ZTILE1", "ZTILE2",
                          "ZCMPTYPE", "ZNAME1", "ZVAL1", "ZNAME2", "ZVAL2", "ZTENSION",
                          "ZPCOUNT", "ZGCOUNT", "TFIELDS", "TTYPE1", "TFORM1"):
                    hdr.remove(k, ignore_missing=True)
                hdr["STAMPX0"] = (x0, "0-based column of stamp pixel 0 in the exposure")
                hdr["STAMPY0"] = (y0, "0-based row of stamp pixel 0 in the exposure")
                out.append(fits.ImageHDU(np.asarray(hdu.section[y0:y1, x0:x1]), header=hdr, name=name))
            out.append(fits.BinTableHDU(hdul["WCS-WAVE"].data, header=hdul["WCS-WAVE"].header,
                                        name="WCS-WAVE"))

            # The ePSF grid is a calibration product shared by every exposure
            # of a detector, so the 4 MB table is read once and kept.
            epsf_hdu = hdul["EPSF"]
            history = " ".join(str(h) for h in epsf_hdu.header.get("HISTORY", []))
            key = f"{frame.detector}|{epsf_hdu.header.get('NAXIS2')}|{history}"
            table = _epsf_tables.get(key)
            if table is None:
                table = epsf_hdu.data.copy()
                _epsf_tables[key] = table
            dx, dy = alt_wcs(header, "A").pixel_to_world_values(float(x), float(y))
            dist = (np.asarray(table["XCENTER"]) - dx) ** 2 + (np.asarray(table["YCENTER"]) - dy) ** 2
            row = table[int(np.argmin(dist))]
            psf_hdr = fits.Header()
            for k in ("OVSMPX", "OVSMPY"):
                psf_hdr[k] = epsf_hdu.header.get(k, 5)
            psf_hdr["CWAVE"] = float(row["CWAVE"])
            out.append(fits.ImageHDU(np.asarray(row["EPSF"], dtype=np.float64), header=psf_hdr, name="EPSF"))
    tmp = path.with_suffix(".part")
    fits.HDUList(out).writeto(tmp, overwrite=True)
    tmp.replace(path)
    return path


async def fetch_stamp(frame: Frame, ra: float, dec: float) -> Path:
    """Small FITS stamp around (ra, dec) for photometry. Cached forever.

    Uses partial reads from S3 when the archive lists an S3 copy, otherwise
    (or if S3 fails) a small IRSA cutout, which has the same layout.
    """
    key = f"{frame.collection}/{frame.id}/{ra:.6f},{dec:.6f}/stamp{STAMP_HALF}"
    path = _cache_path("stamps", key, ".fits")
    if path.exists() and path.stat().st_size > 0:
        return path
    if frame.cloud_url:
        async with _stamp_sem():
            for attempt in range(3):
                try:
                    return await asyncio.to_thread(_read_stamp_from_s3, frame, ra, dec, path)
                except DataSourceError:
                    raise
                except Exception:
                    await asyncio.sleep(0.5 * 2 ** attempt)
    size_deg = (2 * STAMP_HALF + 1) * 6.2 / 3600
    return await fetch_cutout(frame, ra, dec, size_deg)


def clear_search_cache() -> int:
    folder = config.CACHE_DIR / "search"
    n = 0
    if folder.exists():
        for p in folder.glob("*.json"):
            p.unlink()
            n += 1
    return n


def status() -> dict:
    return {
        "source": "NASA/IPAC Infrared Science Archive (IRSA)",
        "search_url": config.IRSA_SIA_URL,
        "search_ttl_seconds": config.SEARCH_TTL_SECONDS,
        "last_search_utc": _state["last_search_utc"],
        # newest observation we have seen so far, per IRSA collection
        "collections": dict(_state["collections"]),
    }
