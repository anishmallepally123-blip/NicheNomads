"""Star catalogues drawn on top of the SPHEREx pictures.

Both catalogues come from IRSA, the same archive that serves SPHEREx, through
its fast cone search (Gator). IRSA's TAP service holds the same tables but
takes 20 to 30 seconds per query, Gator about one second.

  gaia  Gaia DR3 (gaia_dr3_source). Positions at epoch J2016.0 with proper
        motions in mas/yr. Best for stars, including very fast ones such as
        Barnard's Star.
  wise  CatWISE2020 (catwise_2020). WISE infrared sources with motions fitted
        over 2010 to 2018. Sees cold brown dwarfs that Gaia cannot. Note: the
        very fastest objects (Barnard's Star, WISE 0855) are split into
        several pieces in this catalogue because they move too far between
        WISE visits.

Plus a tiny hand-made list of famous fast movers that neither catalogue gets
right, so the viewer can show where they should be in every frame.

Each source is returned with a reference epoch (MJD) and proper motion in
mas/yr (RA motion already multiplied by cos(dec)). The browser moves every
source to each frame's date, so fast stars line up with the picture.
"""
from __future__ import annotations

import json
import math
import time
import warnings
from dataclasses import dataclass

import httpx
import numpy as np
from astropy.io import ascii as astro_ascii

from . import config
from .data_access import _cache_path, _http

GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"

# J2016.0 (Gaia DR3 reference epoch) and the CatWISE2020 motion-fit epoch.
GAIA_EPOCH_MJD = 57388.5
CATWISE_EPOCH_MJD = 57170.0

# Never send the browser more than this many markers per catalogue. The
# brightest sources are kept.
MAX_SOURCES = 2500

# CatWISE motion fits worse than this (reduced chi squared) are ignored. Real
# sources sit near 1; halo pieces around bright stars go into the hundreds.
MAX_RCHI2_PM = 10.0

# Catalogue answers barely change, keep them for a week.
CATALOG_TTL_SECONDS = 7 * 24 * 3600


class CatalogError(RuntimeError):
    """IRSA could not be reached or answered with an error."""


@dataclass(frozen=True)
class Catalog:
    key: str
    label: str
    table: str
    columns: str
    epoch_mjd: float
    mag_label: str
    mag_column: str
    reference: str


CATALOGS: dict[str, Catalog] = {
    "gaia": Catalog(
        key="gaia",
        label="Gaia DR3",
        table="gaia_dr3_source",
        columns="source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,ruwe",
        epoch_mjd=GAIA_EPOCH_MJD,
        mag_label="G",
        mag_column="phot_g_mean_mag",
        reference="Gaia Collaboration 2023, via IRSA",
    ),
    "wise": Catalog(
        key="wise",
        label="CatWISE2020",
        table="catwise_2020",
        columns="source_name,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,rchi2_pm,w1mpro,w2mpro,ab_flags,cc_flags",
        epoch_mjd=CATWISE_EPOCH_MJD,
        mag_label="W2",
        mag_column="w2mpro",
        reference="Marocco et al. 2021, via IRSA",
    ),
}


# Objects that catalogues miss or split. Position at `epoch_mjd`, motion in
# mas/yr (RA already times cos dec).
# WISE 0855-0714: motion and parallax from Luhman & Esplin 2016 (AJ 152, 78).
# Its position at 2014.0 is the one given on the challenge page.
KNOWN_MOVERS: list[dict] = [
    {
        "id": "WISE J085510.83-071442.5",
        "name": "WISE 0855-0714",
        "ra": 133.795129,
        "dec": -7.245147,
        "epoch_mjd": 56658.0,  # 2014-01-01
        "pmra": -8123.0,
        "pmdec": 673.0,
        "parallax": 449.0,
        "mag": None,
        "note": "Coldest known brown dwarf, about 250 K. Not seen by Gaia.",
    },
]


# Faintest magnitude asked for, by field of view. Wide views would otherwise
# return tens of thousands of stars (and take 20 s); SPHEREx's 6 arcsec pixels
# do not show the faint ones anyway. (fov limit in arcmin, gaia G, wise W2)
MAG_LIMITS = [(7, 20.0, 17.0), (15, 18.5, 15.5), (30, 17.0, 14.0), (999, 15.5, 12.5)]


def mag_limit(key: str, fov_arcmin: float) -> float:
    for fov_max, gaia, wise in MAG_LIMITS:
        if fov_arcmin <= fov_max:
            return gaia if key == "gaia" else wise
    return MAG_LIMITS[-1][1 if key == "gaia" else 2]


def search_radius_arcmin(fov_arcmin: float) -> float:
    """Cone that covers the whole square view, plus a margin for motion."""
    return fov_arcmin / math.sqrt(2) + 0.5


def _clean(v) -> float | None:
    if v is None or np.ma.is_masked(v):
        return None
    f = float(v)
    return None if math.isnan(f) else f


def parse_gator(catalog: Catalog, text: str) -> list[dict]:
    """Read Gator's IPAC table answer into plain dictionaries."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table = astro_ascii.read(text.splitlines(), format="ipac", guess=False)

    out: list[dict] = []
    for row in table:
        if catalog.key == "gaia":
            src = {
                "id": f"Gaia DR3 {row['source_id']}",
                "ra": float(row["ra"]),
                "dec": float(row["dec"]),
                "pmra": _clean(row["pmra"]),
                "pmdec": _clean(row["pmdec"]),
                "parallax": _clean(row["parallax"]),
                "mag": _clean(row["phot_g_mean_mag"]),
                "ruwe": _clean(row["ruwe"]),
            }
        else:
            pmra, pmdec = _clean(row["pmra"]), _clean(row["pmdec"])
            src = {
                "id": f"CWISE {row['source_name']}",
                "ra": float(row["ra_pm"]),
                "dec": float(row["dec_pm"]),
                # CatWISE motions are in arcsec/yr, we use mas/yr everywhere.
                "pmra": None if pmra is None else pmra * 1000,
                "pmdec": None if pmdec is None else pmdec * 1000,
                "pm_err": None,
                "mag": _clean(row["w2mpro"]),
                "w1": _clean(row["w1mpro"]),
                "flags": str(row["ab_flags"]) if not np.ma.is_masked(row["ab_flags"]) else "",
            }
            e1, e2 = _clean(row["sigpmra"]), _clean(row["sigpmdec"])
            if e1 is not None and e2 is not None:
                src["pm_err"] = round(math.hypot(e1, e2) * 1000, 1)
            # Around very bright or very fast stars CatWISE has many fake
            # "movers" (halo pieces). Their motion fit is terrible, so only
            # trust a motion when the fit is good and the motion is at least
            # 3 times its error.
            chi2 = _clean(row["rchi2_pm"])
            pm = math.hypot(src["pmra"] or 0, src["pmdec"] or 0)
            src["pm_ok"] = (chi2 is not None and chi2 <= MAX_RCHI2_PM
                            and (src["pm_err"] is None or pm >= 3 * src["pm_err"]))
            cc = "" if np.ma.is_masked(row["cc_flags"]) else str(row["cc_flags"])
            # upper-case contamination flags mean "probably not a real source"
            src["spurious"] = any(ch.isupper() for ch in cc)
        out.append(src)

    # brightest first, sources without a magnitude last
    out.sort(key=lambda s: s["mag"] if s["mag"] is not None else 99)
    return out


async def cone_search(key: str, ra: float, dec: float, fov_arcmin: float) -> dict:
    """Sources from one catalogue around (ra, dec), cached on disk."""
    catalog = CATALOGS[key]
    radius_arcsec = round(search_radius_arcmin(fov_arcmin) * 60, 1)
    faintest = mag_limit(key, fov_arcmin)
    cache_key = f"{catalog.table}/{ra:.5f},{dec:.5f}/{radius_arcsec}/{faintest}"
    path = _cache_path("catalogs", cache_key, ".json")
    fresh = path.exists() and (time.time() - path.stat().st_mtime) < CATALOG_TTL_SECONDS
    if fresh:
        return json.loads(path.read_text())

    params = {
        "catalog": catalog.table,
        "spatial": "cone",
        "objstr": f"{ra:.6f} {dec:+.6f}",
        "radius": str(radius_arcsec),
        "outfmt": "1",
        "selcols": catalog.columns,
        "constraints": f"{catalog.mag_column}<{faintest}",
    }
    try:
        resp = await _http().get(GATOR_URL, params=params, timeout=60)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        if path.exists():  # IRSA is down: an old answer is still right
            return json.loads(path.read_text())
        raise CatalogError(f"{catalog.label} search failed: {exc}") from exc
    if "[struct stat=" in resp.text[:500] and "ERROR" in resp.text[:500]:
        raise CatalogError(f"{catalog.label} search failed: {resp.text[:200]}")

    sources = parse_gator(catalog, resp.text)
    result = {
        "catalog": catalog.key,
        "label": catalog.label,
        "reference": catalog.reference,
        "epoch_mjd": catalog.epoch_mjd,
        "mag_label": catalog.mag_label,
        "radius_arcmin": radius_arcsec / 60,
        "mag_limit": faintest,
        "total": len(sources),
        "truncated": len(sources) > MAX_SOURCES,
        "sources": sources[:MAX_SOURCES],
    }
    path.write_text(json.dumps(result))
    return result


def known_movers(ra: float, dec: float, fov_arcmin: float, span_years: float = 30) -> dict:
    """Hand-made fast movers that could be in the view at any time in the
    past or next few decades (they move up to ~10 arcsec per year)."""
    reach_deg = search_radius_arcmin(fov_arcmin) / 60
    found = []
    for m in KNOWN_MOVERS:
        cosd = math.cos(math.radians(dec))
        dra = ((m["ra"] - ra + 180) % 360 - 180) * cosd
        ddec = m["dec"] - dec
        travel = math.hypot(m["pmra"], m["pmdec"]) / 3.6e6 * span_years
        if math.hypot(dra, ddec) <= reach_deg + travel:
            src = {k: m[k] for k in ("id", "ra", "dec", "pmra", "pmdec", "parallax", "mag", "note")}
            src["name"] = m["name"]
            src["epoch_mjd"] = m["epoch_mjd"]
            found.append(src)
    return {
        "catalog": "movers",
        "label": "Known fast movers",
        "reference": "Literature values",
        "epoch_mjd": None,  # each source carries its own
        "mag_label": "",
        "radius_arcmin": search_radius_arcmin(fov_arcmin),
        "mag_limit": None,
        "total": len(found),
        "truncated": False,
        "sources": found,
    }
