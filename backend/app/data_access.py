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

    def public(self) -> dict:
        d = asdict(self)
        d.pop("access_url")
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
