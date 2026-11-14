"""Spectra: measure how bright a source is in every SPHEREx exposure.

SPHEREx builds a spectrum by seeing the same spot through a different part of
its filter in each exposure. So the spectrum of a position is simply: for each
exposure, the source's flux and the wavelength that pixel saw.

Flux is measured by forced PSF photometry at a fixed sky position:
  * model = F * PSF + B over the pixels within FIT_RADIUS of the position,
    where PSF is the mission's effective PSF (EPSF extension) for that part of
    the detector, sampled at the exact sub-pixel position of every pixel;
  * F and the local background B are found by weighted least squares, using
    the VARIANCE extension for weights;
  * pixels with a bad quality flag are left out of the fit (never patched);
  * F (MJy/sr summed over pixels) times the pixel solid angle gives flux
    density, reported in microjansky.
Points where too much of the PSF falls on bad pixels are returned but marked
not ok, so the plot can show them faded and they never enter the binned
spectrum. Pure functions, no network.
"""
from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

from . import bands, quality
from .cutouts import alt_wcs, wavelength_at

FIT_RADIUS = 3.0          # pixels (about 18 arcsec), inside the ePSF table (3.2 px)
MIN_PSF_COVERAGE = 0.7    # share of the PSF that must land on good pixels
ARCSEC2_TO_SR = (np.pi / 180 / 3600) ** 2


def native_psf(epsf: np.ndarray, oversample: int, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """PSF value of native pixels at offsets (dx, dy) from the source, in pixels.

    The ePSF is tabulated `oversample` times finer than the detector. It is
    an *effective* PSF: each value already is the share of light a whole
    pixel centred there collects, so we sample it at native-pixel spacing
    without integrating again. (We tried both on a 2MASS star near WISE 0855:
    sampling gave lower chi-square and fluxes within 3-8 % of 2MASS J, H, Ks,
    integrating over the pixel again gave 10-15 % too much.)
    Normalised so the whole PSF sums to 1 on the native grid.
    """
    integrated = epsf
    cy, cx = (np.array(epsf.shape) - 1) / 2

    def sample(ox, oy):
        return map_coordinates(integrated, [cy + oversample * oy, cx + oversample * ox],
                               order=1, mode="constant", cval=0.0)

    reach = int(np.ceil(cx / oversample))
    gy, gx = np.mgrid[-reach:reach + 1, -reach:reach + 1]
    # Normalise using the full footprint at the same sub-pixel phase.
    phase_x = dx.flat[0] - np.round(dx.flat[0]) if dx.size else 0.0
    phase_y = dy.flat[0] - np.round(dy.flat[0]) if dy.size else 0.0
    total = sample(gx + phase_x, gy + phase_y).sum()
    return sample(dx, dy) / total if total > 0 else sample(dx, dy)


def _epsf_for(hdul: fits.HDUList, header: fits.Header, x: float, y: float):
    """(psf array, oversample) for this position, from a stamp or a cutout."""
    hdu = hdul["EPSF"]
    over = int(hdu.header.get("OVSMPX", 5))
    if isinstance(hdu, fits.ImageHDU):   # our S3 stamps keep just the right one
        return np.asarray(hdu.data, dtype=np.float64), over
    table = hdu.data                       # IRSA cutouts carry the whole grid
    dx, dy = alt_wcs(header, "A").pixel_to_world_values(x, y)
    dist = (np.asarray(table["XCENTER"]) - dx) ** 2 + (np.asarray(table["YCENTER"]) - dy) ** 2
    return np.asarray(table[int(np.argmin(dist))]["EPSF"], dtype=np.float64), over


def pixel_solid_angle_sr(header: fits.Header, wcs: WCS) -> float:
    omega = header.get("OMEGA_MEDIAN")  # arcsec^2, from the solid-angle pixel map
    if omega:
        return float(omega) * ARCSEC2_TO_SR
    scales = wcs.proj_plane_pixel_scales()
    return float(scales[0].to_value("deg") * scales[1].to_value("deg")) * (np.pi / 180) ** 2


def measure(path: str | Path, ra: float, dec: float) -> dict:
    """Forced PSF photometry of (ra, dec) in one stamp or cutout file."""
    with fits.open(path) as hdul:
        header = hdul["IMAGE"].header
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wcs = WCS(header)
            x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        x0, y0 = int(header.get("STAMPX0", 0)), int(header.get("STAMPY0", 0))
        image = np.asarray(hdul["IMAGE"].data, dtype=np.float64)
        if "ZODI" in hdul:
            image = image - np.asarray(hdul["ZODI"].data, dtype=np.float64)
        variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
        flags = np.asarray(hdul["FLAGS"].data)
        flags_header = hdul["FLAGS"].header
        wave, width = wavelength_at(hdul, header, x, y)
        psf_table, over = _epsf_for(hdul, header, x, y)
        omega_sr = pixel_solid_angle_sr(header, wcs)
        meta = {
            "detector": int(header.get("DETECTOR", 0)) or None,
            "l1_quality": str(header.get("L1DQAFLG", "")).strip() or None,
            "astrometry_ok": header.get("FINAST") in (0, None),
        }

    lx, ly = x - x0, y - y0                       # position inside the stamp
    ny, nx = image.shape
    yy, xx = np.mgrid[:ny, :nx]
    dx, dy = xx - lx, yy - ly
    region = dx ** 2 + dy ** 2 <= FIT_RADIUS ** 2
    if not region.any():
        return {"ok": False, "reason": "position is off this exposure", "wavelength": wave, **meta}

    bad = quality.bad_pixels(flags, flags_header) | ~np.isfinite(image) | ~(variance > 0)
    psf = native_psf(psf_table, over, dx, dy)
    use = region & ~bad
    psf_coverage = float(psf[use].sum() / max(psf[region].sum(), 1e-12))

    ci, cj = int(round(ly)), int(round(lx))
    centre_flags = quality.names_in(flags[ci, cj], flags_header) if 0 <= ci < ny and 0 <= cj < nx else []
    result = {
        "wavelength": wave, "bandwidth": width,
        "flags_at_target": centre_flags,
        "bad_pixels_in_fit": int((region & bad).sum()),
        "psf_coverage": round(psf_coverage, 3),
        **meta,
    }
    if use.sum() < 6 or psf_coverage < MIN_PSF_COVERAGE:
        saturated = {"OVERFLOW", "BLOOM", "NONLINEAR"} & set(centre_flags)
        reason = ("saturated: too bright for SPHEREx" if saturated
                  else "too many flagged pixels on the source")
        return {**result, "ok": False, "reason": reason}

    # Weighted linear least squares for [F, B].
    p, d, w = psf[use], image[use], 1.0 / variance[use]
    a = np.array([[np.sum(w * p * p), np.sum(w * p)], [np.sum(w * p), np.sum(w)]])
    b = np.array([np.sum(w * p * d), np.sum(w * d)])
    try:
        cov = np.linalg.inv(a)
    except np.linalg.LinAlgError:
        return {**result, "ok": False, "reason": "fit failed"}
    flux, background = cov @ b
    resid = d - flux * p - background
    dof = max(1, use.sum() - 2)
    chi2 = float(np.sum(w * resid ** 2) / dof)

    to_ujy = omega_sr * 1e12                      # MJy/sr * sr = MJy, 1 MJy = 1e12 uJy
    flux_err = float(np.sqrt(cov[0, 0]))
    channel = bands.channel_of(meta["detector"], wave) if meta["detector"] else None
    return {
        **result,
        "ok": bool(np.isfinite(flux)),
        "flux_ujy": round(float(flux) * to_ujy, 3),
        "flux_err_ujy": round(flux_err * to_ujy, 3),
        "background_mjy_sr": round(float(background), 5),
        "chi2_dof": round(chi2, 2),
        "channel": channel,
        "channel_index": bands.global_index(meta["detector"], channel) if channel else None,
    }


def bin_by_channel(points: list[dict]) -> list[dict]:
    """Inverse-variance mean of good points in each of the 102 channels."""
    groups: dict[int, list[dict]] = {}
    for p in points:
        if p.get("ok") and p.get("channel_index") is not None and p.get("flux_err_ujy", 0) > 0:
            groups.setdefault(p["channel_index"], []).append(p)
    channels = {c["index"]: c for c in bands.all_channels()}
    out = []
    for idx in sorted(groups):
        pts = groups[idx]
        w = np.array([1 / p["flux_err_ujy"] ** 2 for p in pts])
        f = np.array([p["flux_ujy"] for p in pts])
        mean = float(np.sum(w * f) / np.sum(w))
        err = float(1 / np.sqrt(np.sum(w)))
        # If the points scatter more than their error bars say (variability,
        # neighbours, a moving source), widen the error instead of hiding it.
        if len(pts) > 1:
            chi2 = float(np.sum(w * (f - mean) ** 2) / (len(pts) - 1))
            err *= max(1.0, np.sqrt(chi2))
        ch = channels[idx]
        out.append({
            "index": idx, "band": ch["band"], "channel": ch["channel"],
            "wave_center": ch["wave_center"], "wave_min": ch["wave_min"], "wave_max": ch["wave_max"],
            "wavelength": round(float(np.mean([p["wavelength"] for p in pts])), 4),
            "flux_ujy": round(mean, 3), "flux_err_ujy": round(err, 3), "n": len(pts),
        })
    return out
