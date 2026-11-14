"""The 102 SPHEREx spectral channels.

SPHEREx has six detectors (bands). Each sits behind a linear variable filter,
so the wavelength changes smoothly across the detector. The mission splits
each band into 17 channels of equal resolving power R = lambda / d_lambda,
giving 6 x 17 = 102 channels. Channel index = 17 * (band - 1) + (channel - 1),
counting from 0 in increasing wavelength.

The band edges and R below are the published DR1 values (IRSA "Intro to
SPHEREx Spectral Images"). The channel edges are spaced evenly in
log(wavelength) inside each band, which is what "equal R" means. They match the
mission's channel table closely but not to the last digit, so a frame whose
wavelength lands right on an edge may be put in the neighbouring channel. That
only changes which frames get co-added together, never the measured values.
"""
from __future__ import annotations

import numpy as np

CHANNELS_PER_BAND = 17

# band: (wave_min_um, wave_max_um, resolving power)
BANDS: dict[int, tuple[float, float, float]] = {
    1: (0.75, 1.09, 39),
    2: (1.10, 1.62, 41),
    3: (1.63, 2.41, 41),
    4: (2.42, 3.82, 35),
    5: (3.83, 4.41, 112),
    6: (4.42, 5.00, 128),
}


def channel_edges(band: int) -> np.ndarray:
    lo, hi, _ = BANDS[band]
    return np.geomspace(lo, hi, CHANNELS_PER_BAND + 1)


def all_channels() -> list[dict]:
    out = []
    for band in BANDS:
        edges = channel_edges(band)
        for ch in range(CHANNELS_PER_BAND):
            lo, hi = float(edges[ch]), float(edges[ch + 1])
            out.append({
                "index": CHANNELS_PER_BAND * (band - 1) + ch,
                "band": band,
                "channel": ch + 1,
                "wave_min": round(lo, 4),
                "wave_max": round(hi, 4),
                "wave_center": round(float(np.sqrt(lo * hi)), 4),
                "resolving_power": BANDS[band][2],
            })
    return out


def channel_of(band: int, wavelength_um: float | None) -> int | None:
    """Channel number (1..17) of a wavelength inside a band, or None if outside."""
    if wavelength_um is None or not np.isfinite(wavelength_um) or band not in BANDS:
        return None
    edges = channel_edges(band)
    # Small tolerance: the filter edges in real frames sit a little outside
    # the nominal band limits.
    if wavelength_um < edges[0]:
        return 1 if wavelength_um > edges[0] * 0.98 else None
    if wavelength_um >= edges[-1]:
        return CHANNELS_PER_BAND if wavelength_um < edges[-1] * 1.02 else None
    return int(np.searchsorted(edges, wavelength_um, side="right"))


def global_index(band: int, channel: int) -> int:
    return CHANNELS_PER_BAND * (band - 1) + (channel - 1)
