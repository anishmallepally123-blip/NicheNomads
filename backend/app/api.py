"""HTTP API. Thin layer: validates input, calls data_access / cutouts / render."""
from __future__ import annotations

import asyncio
import io
from collections import Counter

from fastapi import APIRouter, HTTPException, Query, Response

import time

import numpy as np

from . import bands, config, cutouts, data_access, quality, render, spectra, targets

router = APIRouter(prefix="/api")

Ra = Query(..., ge=0, le=360, description="Right ascension, degrees (ICRS)")
Dec = Query(..., ge=-90, le=90, description="Declination, degrees (ICRS)")


@router.get("/health")
async def health():
    return {"ok": True}


@router.get("/targets")
async def list_targets():
    return {"targets": targets.TARGETS}


@router.get("/resolve")
async def resolve(q: str = Query(..., min_length=1, max_length=100)):
    """Turn what the user typed (a target name or coordinates) into RA/Dec."""
    known = targets.find_target(q)
    if known:
        return {"ra": known["ra"], "dec": known["dec"], "name": known["name"]}
    try:
        ra, dec = targets.parse_coordinates(q)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"ra": round(ra, 6), "dec": round(dec, 6), "name": None}


@router.get("/frames")
async def frames(ra: float = Ra, dec: float = Dec,
                 band: int | None = Query(None, ge=1, le=6, description="Detector 1-6"),
                 refresh: bool = False):
    """Time-ordered list of SPHEREx exposures covering this position."""
    try:
        found = await data_access.search_frames(ra, dec, refresh=refresh)
    except data_access.DataSourceError as exc:
        raise HTTPException(502, str(exc)) from exc

    per_band = Counter(f.detector for f in found)
    ranges = {f.detector: (f.wave_min, f.wave_max) for f in found}
    bands = [
        {"detector": d, "count": per_band[d], "wave_min": ranges[d][0], "wave_max": ranges[d][1]}
        for d in sorted(per_band)
    ]
    selected = [f for f in found if band is None or f.detector == band]
    latest = max(found, key=lambda f: f.mjd, default=None)
    return {
        "ra": ra, "dec": dec, "band": band,
        "count": len(selected),
        "total": len(found),
        "bands": bands,
        "latest": latest.public() if latest else None,
        "frames": [f.public() for f in selected],
    }


@router.get("/frames/{frame_id}/image")
async def frame_image(
    frame_id: str,
    ra: float = Ra, dec: float = Dec,
    fov: float = Query(config.DEFAULT_FOV_ARCMIN, ge=config.MIN_FOV_ARCMIN,
                       le=config.MAX_FOV_ARCMIN, description="Field of view, arcmin"),
    size: int = Query(config.DEFAULT_IMAGE_SIZE, ge=32, le=config.MAX_IMAGE_SIZE),
    zodi: bool = Query(True, description="Subtract the zodiacal light model"),
    stretch: str = Query("asinh", pattern="^(asinh|sqrt|linear)$"),
    format: str = Query("png", pattern="^(png|fits)$"),
):
    """One aligned, north-up picture of the patch from one exposure."""
    try:
        frame = await data_access.get_frame(frame_id, ra, dec)
        if frame is None:
            raise HTTPException(404, f"Unknown frame {frame_id} at this position")
        fov_deg = fov / 60.0
        path = await data_access.fetch_cutout(frame, ra, dec, cutouts.cutout_size_deg(fov_deg))
    except data_access.DataSourceError as exc:
        raise HTTPException(502, str(exc)) from exc

    try:
        aligned = await asyncio.to_thread(
            cutouts.align_cutout, path, ra, dec, fov_deg, size, subtract_zodi=zodi)
    except Exception as exc:
        raise HTTPException(500, f"Could not process {frame_id}: {exc}") from exc

    headers = {
        "Cache-Control": "public, max-age=86400",
        "X-Coverage": f"{aligned.coverage:.3f}",
        "X-Flagged-Fraction": f"{aligned.flagged_fraction:.3f}",
        "X-Filled-Fraction": f"{float(np.mean(aligned.filled)) if aligned.filled is not None else 0:.3f}",
    }
    if aligned.wavelength_um is not None:
        headers["X-Wavelength-Um"] = f"{aligned.wavelength_um:.4f}"
    if aligned.bandwidth_um is not None:
        headers["X-Bandwidth-Um"] = f"{aligned.bandwidth_um:.4f}"

    if format == "fits":
        # Science download: flagged pixels stay NaN here, never filled in.
        if aligned.science is not None:
            aligned.data = aligned.science
        buf = io.BytesIO()
        aligned.to_fits().writeto(buf)
        headers["Content-Disposition"] = f'attachment; filename="{frame_id}.fits"'
        return Response(buf.getvalue(), media_type="application/fits", headers=headers)
    return Response(render.to_png(aligned.data, mode=stretch), media_type="image/png",
                    headers=headers)


@router.get("/status")
async def status():
    """Where the data comes from and how fresh it is."""
    return data_access.status()


@router.post("/refresh")
async def refresh():
    """Forget cached searches so the next request asks IRSA for new data."""
    return {"cleared": data_access.clear_search_cache()}


# ---------------------------------------------------------------- data and bands

FovQ = Query(config.DEFAULT_FOV_ARCMIN, ge=config.MIN_FOV_ARCMIN, le=config.MAX_FOV_ARCMIN,
             description="Field of view, arcmin")


@router.get("/bands")
async def list_bands():
    """The 6 detectors and their 102 spectral channels."""
    return {
        "bands": [{"band": b, "wave_min": lo, "wave_max": hi, "resolving_power": r}
                  for b, (lo, hi, r) in bands.BANDS.items()],
        "channels": bands.all_channels(),
        "bad_flags": list(quality.BAD_FLAGS),
    }


async def _aligned(frame, ra, dec, fov_deg, size):
    path = await data_access.fetch_cutout(frame, ra, dec, cutouts.cutout_size_deg(fov_deg))
    return await asyncio.to_thread(cutouts.align_cutout, path, ra, dec, fov_deg, size)


@router.get("/frames/{frame_id}/meta")
async def frame_meta(frame_id: str, ra: float = Ra, dec: float = Dec, fov: float = FovQ):
    """Metadata and quality flags of one exposure at this position.

    Uses the same cutout as the picture, so it is instant once the frame is shown.
    """
    try:
        frame = await data_access.get_frame(frame_id, ra, dec)
        if frame is None:
            raise HTTPException(404, f"Unknown frame {frame_id} at this position")
        path = await data_access.fetch_cutout(frame, ra, dec, cutouts.cutout_size_deg(fov / 60))
    except data_access.DataSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
    return await asyncio.to_thread(_meta_from_cutout, frame, path, ra, dec)


def _meta_from_cutout(frame, path, ra, dec) -> dict:
    import warnings

    from astropy.io import fits
    from astropy.wcs import WCS

    with fits.open(path) as hdul:
        h = hdul["IMAGE"].header
        flags = np.asarray(hdul["FLAGS"].data)
        fh = hdul["FLAGS"].header
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            x, y = (float(v) for v in WCS(h).world_to_pixel_values(ra, dec))
        wave, width = cutouts.wavelength_at(hdul, h, x, y)
        ci, cj = int(round(y)), int(round(x))
        inside = 0 <= ci < flags.shape[0] and 0 <= cj < flags.shape[1]
        zodi = float(hdul["ZODI"].data[ci, cj]) if inside and "ZODI" in hdul else None
        var = float(hdul["VARIANCE"].data[ci, cj]) if inside and "VARIANCE" in hdul else None

    def get(key):
        v = h.get(key)
        return v if isinstance(v, (int, float, str, bool)) else None

    channel = bands.channel_of(frame.detector, wave)
    return {
        "frame": frame.public(),
        "wavelength": wave, "bandwidth": width,
        "channel": channel,
        "channel_index": bands.global_index(frame.detector, channel) if channel else None,
        "target_pixel": {
            "flags": quality.names_in(flags[ci, cj], fh) if inside else [],
            "bad": bool(quality.bad_pixels(flags[ci, cj], fh)) if inside else None,
            "zodi_mjy_sr": round(zodi, 4) if zodi is not None else None,
            "noise_mjy_sr": round(var ** 0.5, 4) if var and var > 0 else None,
        },
        "flags": quality.summarize(flags, fh),
        "bad_fraction": round(float(np.mean(quality.bad_pixels(flags, fh))), 4),
        "header": {
            "date_obs": get("DATE-OBS"), "exposure_s": get("XPOSURE"),
            "l1_quality": get("L1DQAFLG"),
            "fine_astrometry_ok": get("FINAST") == 0 if get("FINAST") is not None else None,
            "astrometry_stars": get("MATCH_NSTARS"),
            "source_pixel_percent": get("PXSRCMSK"),
            "snowballs": get("NSNOWSRC"), "bloomed_sources": get("NBLMSRCS"),
            "processing": frame.access_url.rsplit("_", 1)[-1].removesuffix(".fits"),
        },
    }


@router.get("/coadd")
async def coadd_image(
    ra: float = Ra, dec: float = Dec, fov: float = FovQ,
    band: int = Query(..., ge=1, le=6, description="Detector 1-6"),
    channel: int | None = Query(None, ge=1, le=bands.CHANNELS_PER_BAND,
                                description="Spectral channel 1-17 inside the band. Omit for the whole band"),
    size: int = Query(config.DEFAULT_IMAGE_SIZE, ge=32, le=config.MAX_IMAGE_SIZE),
    stretch: str = Query("asinh", pattern="^(asinh|sqrt|linear)$"),
    format: str = Query("png", pattern="^(png|fits|json)$"),
):
    """Deep picture: all exposures of one band (or one of its 17 channels) averaged.

    Frames are aligned onto the same grid as the blink view, flagged pixels are
    left out, outliers are rejected per pixel, and each frame is weighted by
    its noise. See cutouts.coadd() for the details.
    """
    fov_deg = fov / 60.0
    try:
        found = await data_access.search_frames(ra, dec)
    except data_access.DataSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
    candidates = [f for f in found if f.detector == band]
    if not candidates:
        raise HTTPException(404, f"No D{band} exposures cover this position")

    results = await asyncio.gather(*[_aligned(f, ra, dec, fov_deg, size) for f in candidates],
                                   return_exceptions=True)
    images, ids, skipped = [], [], 0
    for f, im in zip(candidates, results):
        if isinstance(im, Exception) or im.coverage < 0.6:
            skipped += 1
            continue
        if channel is not None and bands.channel_of(band, im.wavelength_um) != channel:
            continue
        images.append(im)
        ids.append(f.id)
    if not images:
        raise HTTPException(404, "No usable exposures in this band/channel here")

    result = await asyncio.to_thread(cutouts.coadd, images, ids)
    img = result.image
    waves = [im.wavelength_um for im in images if im.wavelength_um is not None]
    info = {
        "band": band, "channel": channel, "frames_used": len(ids), "frames_skipped": skipped,
        "frame_ids": ids,
        "wave_min": min(waves) if waves else None, "wave_max": max(waves) if waves else None,
        "clipped_fraction": round(result.clipped_fraction, 4),
        "noise_mjy_sr": round(img.noise, 5) if img.noise else None,
        "min_frames_per_pixel": int(result.count[np.isfinite(img.science)].min()) if np.isfinite(img.science).any() else 0,
    }
    if format == "json":
        return info
    headers = {
        "Cache-Control": "public, max-age=3600",
        "X-Frames-Used": str(len(ids)),
        "X-Wave-Min-Um": f"{info['wave_min']:.4f}" if waves else "",
        "X-Wave-Max-Um": f"{info['wave_max']:.4f}" if waves else "",
        "X-Clipped-Fraction": f"{result.clipped_fraction:.4f}",
    }
    if format == "fits":
        from astropy.io import fits as _fits
        primary = _fits.PrimaryHDU(img.science, header=img.wcs.to_header())
        primary.header["BUNIT"] = "MJy/sr"
        primary.header["NCOMBINE"] = (len(ids), "exposures co-added")
        primary.header["DETECTOR"] = band
        if channel:
            primary.header["CHANNEL"] = channel
        if waves:
            primary.header["WAVEMIN"] = (min(waves), "[um] shortest frame wavelength")
            primary.header["WAVEMAX"] = (max(waves), "[um] longest frame wavelength")
        nmap = _fits.ImageHDU(result.count.astype(np.int16), header=img.wcs.to_header(), name="NFRAMES")
        buf = io.BytesIO()
        _fits.HDUList([primary, nmap]).writeto(buf)
        name = f"spherex_coadd_D{band}" + (f"_ch{channel}" if channel else "") + ".fits"
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
        return Response(buf.getvalue(), media_type="application/fits", headers=headers)
    return Response(render.to_png(img.data, mode=stretch), media_type="image/png", headers=headers)


_spectrum_cache: dict[str, tuple[float, dict]] = {}


@router.get("/spectrum")
async def spectrum(ra: float = Ra, dec: float = Dec,
                   band: int | None = Query(None, ge=1, le=6, description="Only this detector")):
    """Spectrum at a sky position: forced PSF photometry in every exposure.

    Returns every individual measurement (`points`, with time, wavelength,
    flux and quality) and the 102-channel binned spectrum (`channels`).
    The first call reads ~250 small stamps from NASA's S3 bucket (30-60 s);
    repeat calls are instant.
    """
    key = f"{ra:.6f},{dec:.6f},{band}"
    cached = _spectrum_cache.get(key)
    if cached and time.time() - cached[0] < config.SEARCH_TTL_SECONDS:
        return cached[1]
    try:
        found = await data_access.search_frames(ra, dec)
    except data_access.DataSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
    frames = [f for f in found if band is None or f.detector == band]

    async def one(f):
        try:
            path = await data_access.fetch_stamp(f, ra, dec)
            m = await asyncio.to_thread(spectra.measure, path, ra, dec)
        except Exception as exc:  # one bad exposure must not sink the spectrum
            m = {"ok": False, "reason": f"could not read: {exc}"[:200], "wavelength": None}
        return {**m, "id": f.id, "detector": f.detector, "mjd": f.mjd, "date": f.date}

    points = await asyncio.gather(*[one(f) for f in frames])
    points.sort(key=lambda p: (p.get("wavelength") or 99, p["mjd"]))
    good = [p for p in points if p.get("ok")]
    result = {
        "ra": ra, "dec": dec, "band": band,
        "unit": "uJy",
        "method": "forced PSF photometry (mission ePSF), local background fitted, "
                  "flagged pixels excluded, zodiacal light model subtracted",
        "measured": len(good), "total": len(points),
        "points": points,
        "channels": spectra.bin_by_channel(points),
    }
    if points:
        _spectrum_cache[key] = (time.time(), result)
    return result
