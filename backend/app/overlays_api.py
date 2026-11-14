"""HTTP routes for catalogue overlays (Gaia DR3, CatWISE2020, known movers).

Kept apart from api.py so overlay work does not touch the frame routes.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from . import catalogs, config

router = APIRouter(prefix="/api/overlays")


@router.get("")
async def list_overlays():
    """The catalogues the viewer can draw."""
    layers = [
        {"key": c.key, "label": c.label, "reference": c.reference, "mag_label": c.mag_label}
        for c in catalogs.CATALOGS.values()
    ]
    layers.append({"key": "movers", "label": "Known fast movers",
                   "reference": "Literature values", "mag_label": ""})
    return {"layers": layers}


@router.get("/{catalog}")
async def overlay(
    catalog: str,
    ra: float = Query(..., ge=0, le=360, description="Right ascension, degrees (ICRS)"),
    dec: float = Query(..., ge=-90, le=90, description="Declination, degrees (ICRS)"),
    fov: float = Query(config.DEFAULT_FOV_ARCMIN, ge=config.MIN_FOV_ARCMIN,
                       le=config.MAX_FOV_ARCMIN, description="Field of view, arcmin"),
):
    """Sources around a position. Each has a reference epoch and proper motion
    (mas/yr, RA motion already times cos dec) so the browser can move it to
    each frame's date."""
    if catalog == "movers":
        return catalogs.known_movers(ra, dec, fov)
    if catalog not in catalogs.CATALOGS:
        raise HTTPException(404, f"Unknown catalogue {catalog!r}")
    try:
        return await catalogs.cone_search(catalog, ra, dec, fov)
    except catalogs.CatalogError as exc:
        raise HTTPException(502, str(exc)) from exc
