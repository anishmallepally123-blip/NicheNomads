"""Test targets from the challenge page, plus coordinate parsing.

To add a target, add one entry to TARGETS. Coordinates are ICRS degrees.
"""
from __future__ import annotations

import astropy.units as u
from astropy.coordinates import SkyCoord


def _deg(text: str) -> tuple[float, float]:
    c = SkyCoord(text, unit=(u.hourangle, u.deg), frame="icrs")
    return round(float(c.ra.deg), 6), round(float(c.dec.deg), 6)


def _target(id_: str, name: str, coord: str, note: str, band: int) -> dict:
    ra, dec = _deg(coord)
    return {"id": id_, "name": name, "ra": ra, "dec": dec, "note": note, "suggested_band": band}


# Fast movers are no longer at their catalogue (J2000) positions. Barnard's Star
# and Epsilon Indi B are listed near where they are in 2026 so they sit inside
# the default view. WISE 0855 uses the exact coordinates from the challenge page.
TARGETS: list[dict] = [
    _target("wise0855", "WISE 0855-0714", "08h55m10.831s -07d14m42.53s",
            "Very cold brown dwarf 7.4 light years away, moving about 8 arcsec per year. "
            "These are the challenge's 2014 coordinates, so today it sits roughly 1.6 arcmin "
            "to the west (right) of the marker.", 6),
    _target("barnard", "Barnard's Star", "17h57m47.10s +04d46m00.3s",
            "Fastest moving star in the sky, about 10 arcsec per year (approximate 2026 position).", 3),
    _target("epsindb", "Epsilon Indi B", "22h04m23.0s -56d48m04s",
            "Brown dwarf pair orbiting Epsilon Indi, moving about 4.7 arcsec per year "
            "(approximate 2026 position).", 3),
    _target("rwaur", "RW Aurigae", "05h07m49.54s +30d24m05.1s",
            "Young variable star that dims unpredictably.", 2),
    _target("rdra", "R Draconis", "16h32m40.23s +66d45m17.9s",
            "Mira variable with a period of about 246 days.", 3),
]


def find_target(text: str) -> dict | None:
    key = "".join(ch for ch in text.lower() if ch.isalnum())
    for t in TARGETS:
        names = {t["id"], "".join(ch for ch in t["name"].lower() if ch.isalnum())}
        if key in names or (len(key) >= 4 and any(n.startswith(key) for n in names)):
            return t
    return None


def parse_coordinates(text: str) -> tuple[float, float]:
    """Turn user text into (ra_deg, dec_deg).

    Accepts "133.795 -7.245" (degrees), "08h55m10.8s -07d14m42s" and
    "08:55:10.8 -07:14:42" (hours for RA when written with h or colons).
    Raises ValueError when the text cannot be read.
    """
    text = text.strip().replace(",", " ")
    if not text:
        raise ValueError("Empty coordinates")
    sexagesimal = any(ch in text for ch in "hms:")
    unit = (u.hourangle, u.deg) if sexagesimal else (u.deg, u.deg)
    try:
        c = SkyCoord(text, unit=unit, frame="icrs")
    except Exception as exc:  # astropy raises several types here
        raise ValueError(f"Could not read coordinates: {text!r}") from exc
    return float(c.ra.deg), float(c.dec.deg)
