"""Quality flags: which SPHEREx pixels to trust.

Every SPHEREx image comes with a FLAGS extension. Each pixel holds a bitmask,
and the FITS header names every bit (keyword MSKNnnnn = name, MSKDnnnn =
description). We read the names from the header instead of hard-coding bit
numbers, so a future release that moves bits around keeps working.

Not every flag means "bad pixel":
  * SOURCE marks pixels that sit on a known star or galaxy. In a typical
    exposure 40-50 % of pixels carry it. It is information, not a problem.
  * FULLSAMPLE only says extra readout data exists.
  * OUTLIER is set by an outlier detector that also fires on real sources.

The list in BAD_FLAGS is the conservative set used for photometry in the IRSA
SPHEREx tutorials (taken from the SPHEREx Explanatory Supplement): pixels with
any of these bits are excluded from co-adds and spectra, and filled in for
display only.
"""
from __future__ import annotations

import numpy as np
from astropy.io import fits

BAD_FLAGS = (
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA",
    "HOT", "COLD", "NONLINEAR", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT",
    "STREAK", "PERSIST", "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO",
)

# Bit numbers as documented for DR1. Only used when a header has no MSKN keywords.
_DEFAULT_BITS = {
    0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC",
    9: "MISSING_DATA", 10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS",
    15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE",
    22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM",
    27: "SNOWBALL", 28: "HALO",
}


def flag_definitions(header: fits.Header | None) -> dict[int, tuple[str, str]]:
    """{bit: (name, description)} from the FLAGS header."""
    defs: dict[int, tuple[str, str]] = {}
    if header is not None:
        for key in header:
            if key.startswith("MSKN") and key[4:].isdigit():
                bit = int(key[4:])
                name = str(header[key]).strip()
                desc = str(header.get(f"MSKD{key[4:]}", "")).strip()
                defs[bit] = (name, desc)
    if not defs:
        defs = {b: (n, "") for b, n in _DEFAULT_BITS.items()}
    return defs


def bad_bitmask(header: fits.Header | None) -> int:
    """OR of all bits whose name is in BAD_FLAGS."""
    mask = 0
    for bit, (name, _) in flag_definitions(header).items():
        if name in BAD_FLAGS:
            mask |= 1 << bit
    return mask


def bad_pixels(flags: np.ndarray, header: fits.Header | None) -> np.ndarray:
    """Boolean array, True where the pixel should not be trusted."""
    return (np.asarray(flags).astype(np.int64) & bad_bitmask(header)) != 0


def names_in(value: int, header: fits.Header | None) -> list[str]:
    """Flag names set in one pixel value."""
    return [name for bit, (name, _) in sorted(flag_definitions(header).items())
            if int(value) >> bit & 1]


def summarize(flags: np.ndarray, header: fits.Header | None,
              region: np.ndarray | None = None) -> list[dict]:
    """How many pixels carry each flag (optionally only inside `region`)."""
    values = np.asarray(flags).astype(np.int64)
    if region is not None:
        values = values[region]
    values = values.ravel()
    total = max(1, values.size)
    out = []
    for bit, (name, desc) in sorted(flag_definitions(header).items()):
        n = int(np.count_nonzero(values >> bit & 1))
        if n:
            out.append({
                "bit": bit, "name": name, "description": desc, "pixels": n,
                "fraction": round(n / total, 4), "bad": name in BAD_FLAGS,
            })
    return out
