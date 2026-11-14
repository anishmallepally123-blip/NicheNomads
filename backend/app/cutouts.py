"""Image alignment: turn a raw SPHEREx cutout into a north-up picture.

SPHEREx exposures are rotated differently every time, so frames cannot be
blinked as they come. align_cutout() resamples each one onto the same grid
(north up, east left, centred on the requested RA/Dec) so that fixed stars
stay put from frame to frame and anything that moves stands out.

Pure functions, no network: easy to test and to extend (co-adds, differences).
"""
from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp

logging.getLogger("astropy").setLevel(logging.WARNING)


@dataclass
class AlignedImage:
    data: np.ndarray            # float32, shape (size, size), row 0 = south. NaN = no data
    wcs: WCS                    # north-up TAN grid of `data`
    wavelength_um: float | None  # wavelength SPHEREx saw at the centre position
    bandwidth_um: float | None
    coverage: float             # fraction of the picture that has data (0..1)
    flagged_fraction: float     # fraction of source pixels with any quality flag set

    def to_fits(self) -> fits.PrimaryHDU:
        header = self.wcs.to_header()
        header["BUNIT"] = "MJy/sr"
        if self.wavelength_um is not None:
            header["WAVELEN"] = (self.wavelength_um, "[um] wavelength at image centre")
        return fits.PrimaryHDU(self.data, header=header)


def target_wcs(ra: float, dec: float, fov_deg: float, size: int) -> WCS:
    """North-up, east-left tangent-plane grid centred on (ra, dec)."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(size + 1) / 2, (size + 1) / 2]
    scale = fov_deg / size
    w.wcs.cdelt = [-scale, scale]
    w.wcs.cunit = ["deg", "deg"]
    return w


def cutout_size_deg(fov_deg: float) -> float:
    """How big a raw cutout to download so a rotated frame still fills the view."""
    return fov_deg * 1.5 + 0.01


def _wavelength_at(hdul: fits.HDUList, header: fits.Header, x: float, y: float):
    """SPHEREx has a different wavelength at every pixel (linear variable filter).
    The file carries a lookup table for it as alternate WCS 'W'."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wave_wcs = WCS(header, fobj=hdul, key="W")
            wave, width = wave_wcs.pixel_to_world_values(x, y)
        wave, width = float(wave), float(width)
        if np.isfinite(wave):
            return round(wave, 4), round(width, 4) if np.isfinite(width) else None
    except Exception:
        pass
    return None, None


def align_cutout(
    fits_path: str | Path,
    ra: float,
    dec: float,
    fov_deg: float,
    size: int,
    *,
    subtract_zodi: bool = True,
) -> AlignedImage:
    with fits.open(fits_path) as hdul:
        image_hdu = hdul["IMAGE"]
        data = np.asarray(image_hdu.data, dtype=np.float32)
        header = image_hdu.header
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            src_wcs = WCS(header, fobj=hdul)

        if subtract_zodi and "ZODI" in hdul:
            # Remove the model of sunlight scattered by dust in our solar system,
            # the dominant smooth background in every SPHEREx image.
            data = data - np.asarray(hdul["ZODI"].data, dtype=np.float32)

        flagged = 0.0
        if "FLAGS" in hdul:
            flagged = float(np.mean(np.asarray(hdul["FLAGS"].data) != 0))

        x, y = src_wcs.world_to_pixel_values(ra, dec)
        wavelength, bandwidth = _wavelength_at(hdul, header, float(x), float(y))

    out_wcs = target_wcs(ra, dec, fov_deg, size)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out, footprint = reproject_interp((data, src_wcs), out_wcs, shape_out=(size, size))
    out = out.astype(np.float32)
    out[footprint == 0] = np.nan

    return AlignedImage(
        data=out,
        wcs=out_wcs,
        wavelength_um=wavelength,
        bandwidth_um=bandwidth,
        coverage=float(np.mean(np.isfinite(out))),
        flagged_fraction=flagged,
    )
