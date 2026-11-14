"""Turn an aligned float image into a PNG the browser can show."""
from __future__ import annotations

import io

import numpy as np
from PIL import Image


def stretch(data: np.ndarray, *, mode: str = "asinh", low_sigma: float = 2.0,
            high_sigma: float = 40.0) -> np.ndarray:
    """Scale to 0..1 using the image's own background level and noise.

    Every frame is scaled against its own sky, so frames taken at different
    wavelengths and brightness levels look comparable when blinked.
    """
    finite = np.isfinite(data)
    if not finite.any():
        return np.zeros_like(data, dtype=np.float32)
    values = data[finite]
    median = float(np.median(values))
    sigma = 1.4826 * float(np.median(np.abs(values - median))) or 1e-6
    lo = median - low_sigma * sigma
    hi = median + high_sigma * sigma
    scaled = np.clip((data - lo) / (hi - lo), 0, 1)
    if mode == "asinh":
        a = 0.05
        scaled = np.arcsinh(scaled / a) / np.arcsinh(1 / a)
    elif mode == "sqrt":
        scaled = np.sqrt(scaled)
    return np.where(finite, scaled, 0).astype(np.float32)


def to_png(data: np.ndarray, *, mode: str = "asinh") -> bytes:
    """Grayscale PNG with transparency where there is no data. North is up."""
    grey = (stretch(data, mode=mode) * 255).astype(np.uint8)
    alpha = np.where(np.isfinite(data), 255, 0).astype(np.uint8)
    # FITS row 0 is the bottom of the picture, PNG row 0 is the top.
    stacked = np.dstack([grey, alpha])[::-1]
    buf = io.BytesIO()
    Image.fromarray(stacked, mode="LA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()
