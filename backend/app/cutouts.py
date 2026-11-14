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
from astropy.convolution import Gaussian2DKernel, interpolate_replace_nans
from reproject import reproject_interp

from . import quality

logging.getLogger("astropy").setLevel(logging.WARNING)


@dataclass
class AlignedImage:
    data: np.ndarray            # float32, shape (size, size), row 0 = south. NaN = no data
    wcs: WCS                    # north-up TAN grid of `data`
    wavelength_um: float | None  # wavelength SPHEREx saw at the centre position
    bandwidth_um: float | None
    coverage: float             # fraction of the picture that has data (0..1)
    flagged_fraction: float     # fraction of source pixels with a *bad* quality flag
    # Same grid as `data`, but NaN wherever a bad pixel contributed. `data` has
    # those pixels filled in from their neighbours so the picture looks clean;
    # anything that measures (co-adds, spectra, differences) should use this.
    science: np.ndarray | None = None
    filled: np.ndarray | None = None   # bool, True where `data` was filled in
    noise: float | None = None          # typical 1-sigma per source pixel, MJy/sr
    flag_summary: list | None = None    # quality.summarize() of the cutout
    header: fits.Header | None = None   # IMAGE header of the exposure (metadata)

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


def alt_wcs(header: fits.Header, key: str, hdul: fits.HDUList | None = None) -> WCS:
    """An alternate WCS from a SPHEREx header, without the sky distortion.

    The headers carry SIP distortion keywords for the sky WCS. astropy also
    applies them to every alternate WCS ('W' wavelength table, 'A' detector
    pixels), which shifts those by up to ~1.5 pixels. The IRSA tutorials turn
    SIP off for these, and so do we.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w = WCS(header, fobj=hdul, key=key)
    w.sip = None
    return w


def wavelength_at(hdul: fits.HDUList, header: fits.Header, x: float, y: float):
    """SPHEREx has a different wavelength at every pixel (linear variable filter).
    The file carries a lookup table for it as alternate WCS 'W'. x, y are 0-based
    pixel positions in the array that `header` describes."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wave_wcs = alt_wcs(header, "W", hdul)
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

        if "FLAGS" in hdul:
            flags = np.asarray(hdul["FLAGS"].data)
            flags_header = hdul["FLAGS"].header
        else:
            flags, flags_header = np.zeros(data.shape, dtype=np.int32), None
        bad = quality.bad_pixels(flags, flags_header) | ~np.isfinite(data)
        flag_summary = quality.summarize(flags, flags_header)

        noise = None
        if "VARIANCE" in hdul:
            var = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
            good_var = var[~bad & np.isfinite(var) & (var > 0)]
            if good_var.size:
                noise = float(np.sqrt(np.median(good_var)))

        x, y = src_wcs.world_to_pixel_values(ra, dec)
        wavelength, bandwidth = wavelength_at(hdul, header, float(x), float(y))
        image_header = header.copy()

    science_src = np.where(bad, np.nan, data).astype(np.float32)
    display_src = fill_bad_pixels(science_src)

    out_wcs = target_wcs(ra, dec, fov_deg, size)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        # Bilinear resampling. Values are surface brightness (MJy/sr), so
        # interpolating them is correct: no flux rescaling is needed.
        out, footprint = reproject_interp((display_src, src_wcs), out_wcs, shape_out=(size, size))
        sci, _ = reproject_interp((science_src, src_wcs), out_wcs, shape_out=(size, size))
    out = out.astype(np.float32)
    sci = sci.astype(np.float32)
    outside = footprint == 0
    out[outside] = np.nan
    sci[outside] = np.nan
    filled = np.isfinite(out) & ~np.isfinite(sci)

    return AlignedImage(
        data=out,
        wcs=out_wcs,
        wavelength_um=wavelength,
        bandwidth_um=bandwidth,
        coverage=float(np.mean(np.isfinite(out))),
        flagged_fraction=float(np.mean(bad)),
        science=sci,
        filled=filled,
        noise=noise,
        flag_summary=flag_summary,
        header=image_header,
    )


def fill_bad_pixels(data: np.ndarray, max_passes: int = 4) -> np.ndarray:
    """Fill NaN pixels from their neighbours, for display only.

    A Gaussian-weighted average of the good pixels around each hole. Bigger
    holes get a wider kernel on later passes. Pixels still empty after that
    stay NaN (shown as transparent).
    """
    out = data.astype(np.float64)
    sigma = 1.0
    for _ in range(max_passes):
        if np.all(np.isfinite(out)) or not np.any(np.isfinite(out)):
            break
        kernel = Gaussian2DKernel(sigma, x_size=int(8 * sigma) | 1, y_size=int(8 * sigma) | 1)
        out = interpolate_replace_nans(out, kernel, boundary="extend")
        sigma *= 2
    return out.astype(np.float32)


@dataclass
class Coadd:
    image: AlignedImage
    frames_used: list[str]
    count: np.ndarray            # frames contributing to each output pixel
    clipped_fraction: float      # share of input samples rejected as outliers


def coadd(images: list[AlignedImage], ids: list[str], *, clip_sigma: float = 4.0) -> Coadd:
    """Combine aligned frames (same grid) into one deeper picture.

    * Only good pixels go in (`science`, so flagged pixels never leak in).
    * Each frame is weighted by 1 / noise^2, one weight per frame. Per-pixel
      weights from VARIANCE would include the star's own photon noise and pull
      bright stars down, so we deliberately avoid them.
    * Outliers (cosmic rays the flags missed, moving objects) are rejected per
      pixel when they sit more than `clip_sigma` times the larger of the frame
      noise and the stack's own robust scatter from the median of that pixel's
      stack. Needs at least 3 frames; with fewer, plain mean.
    * No background re-levelling or scaling: values stay in MJy/sr.
    The result is a plain weighted mean, so a moving object shows up as a
    faint smear (or is clipped), and a varying source shows its average.
    """
    if not images:
        raise ValueError("Nothing to co-add")
    shape = images[0].data.shape
    for im in images:
        if im.data.shape != shape:
            raise ValueError("Co-add needs frames on the same grid")
    stack = np.stack([im.science if im.science is not None else im.data for im in images]).astype(np.float64)
    noise = np.array([im.noise if im.noise and im.noise > 0 else np.nan for im in images])
    if np.all(np.isnan(noise)):
        noise[:] = 1.0
    noise = np.where(np.isnan(noise), np.nanmax(noise), noise)
    weights = (1.0 / noise ** 2)[:, None, None] * np.ones_like(stack)

    good = np.isfinite(stack)
    n_in = int(good.sum())
    if len(images) >= 3:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            median = np.nanmedian(stack, axis=0)
            # Scatter of this pixel's stack. A bright star seen at different
            # wavelengths genuinely changes brightness, so we never clip
            # tighter than the stack's own robust spread.
            spread = 1.4826 * np.nanmedian(np.abs(stack - median), axis=0)
        # SPHEREx pixels are big (6 arcsec), so the same star lands differently
        # on the pixel grid in each exposure and its peak value wobbles. Allow
        # 15 % of the signal as extra scatter so star cores are never clipped.
        scale = np.maximum(np.maximum(noise[:, None, None], spread[None]),
                           0.15 * np.abs(median)[None])
        with np.errstate(invalid="ignore"):
            deviation = np.abs(stack - median) / scale
        good &= ~(deviation > clip_sigma)
    clipped = 1 - good.sum() / max(1, n_in)

    weights = np.where(good, weights, 0.0)
    total_w = weights.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(total_w > 0, (np.where(good, stack, 0) * weights).sum(axis=0) / total_w, np.nan)
    count = good.sum(axis=0)
    mean = mean.astype(np.float32)

    waves = [im.wavelength_um for im in images if im.wavelength_um is not None]
    first = images[0]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        combined_noise = float(1 / np.sqrt(np.sum(1 / noise ** 2)))
    result = AlignedImage(
        data=fill_bad_pixels(mean) if np.isnan(mean).any() else mean,
        wcs=first.wcs,
        wavelength_um=round(float(np.mean(waves)), 4) if waves else None,
        bandwidth_um=round(float(max(waves) - min(waves)), 4) if len(waves) > 1 else first.bandwidth_um,
        coverage=float(np.mean(np.isfinite(mean))),
        flagged_fraction=float(np.mean(count == 0)),
        science=mean,
        filled=~np.isfinite(mean),
        noise=combined_noise,
    )
    return Coadd(image=result, frames_used=list(ids), count=count, clipped_fraction=float(clipped))
