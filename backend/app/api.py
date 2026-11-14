"""HTTP API. Thin layer: validates input, calls data_access / cutouts / render."""
from __future__ import annotations

import asyncio
import io
from collections import Counter

from fastapi import APIRouter, HTTPException, Query, Response

from . import config, cutouts, data_access, render, targets

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
    }
    if aligned.wavelength_um is not None:
        headers["X-Wavelength-Um"] = f"{aligned.wavelength_um:.4f}"
    if aligned.bandwidth_um is not None:
        headers["X-Bandwidth-Um"] = f"{aligned.bandwidth_um:.4f}"

    if format == "fits":
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
