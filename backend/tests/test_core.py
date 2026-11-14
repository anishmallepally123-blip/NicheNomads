"""Offline tests: no network needed."""
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app import cutouts, render, targets


def test_wise0855_coordinates():
    t = targets.find_target("wise0855")
    assert t["ra"] == pytest.approx(133.795129, abs=1e-5)
    assert t["dec"] == pytest.approx(-7.245147, abs=1e-5)


def test_parse_coordinates_formats():
    assert targets.parse_coordinates("133.795 -7.245") == pytest.approx((133.795, -7.245))
    ra, dec = targets.parse_coordinates("08h55m10.831s -07d14m42.53s")
    assert (ra, dec) == pytest.approx((133.795129, -7.245147), abs=1e-5)
    ra, dec = targets.parse_coordinates("08:55:10.831 -07:14:42.53")
    assert ra == pytest.approx(133.795129, abs=1e-5)
    with pytest.raises(ValueError):
        targets.parse_coordinates("not a place")


def test_parse_coordinates_space_separated_hms():
    # SIMBAD prints coordinates like this; RA is in hours, not degrees.
    ra, dec = targets.parse_coordinates("08 55 10.831 -07 14 42.53")
    assert (ra, dec) == pytest.approx((133.795129, -7.245147), abs=1e-5)
    ra, dec = targets.parse_coordinates("00 00 00 -00 30 00")
    assert (ra, dec) == pytest.approx((0.0, -0.5))


def test_parse_coordinates_rejects_ra_out_of_range():
    for text in ("361 0", "-1 0"):
        with pytest.raises(ValueError):
            targets.parse_coordinates(text)


def _rotated_cutout(tmp_path, ra, dec, angle_deg):
    """Fake SPHEREx cutout: rotated, with one star exactly at (ra, dec)."""
    n = 81
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [35.0, 47.0]
    s = 6.15 / 3600
    a = np.deg2rad(angle_deg)
    w.wcs.cd = [[-s * np.cos(a), s * np.sin(a)], [s * np.sin(a), s * np.cos(a)]]
    yy, xx = np.mgrid[:n, :n]
    star = 50 * np.exp(-((xx - 34) ** 2 + (yy - 46) ** 2) / 4.0)
    zodi = np.full((n, n), 0.3, dtype=np.float32)
    hdr = w.to_header()
    hdul = fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU((star + zodi).astype(np.float32), header=hdr, name="IMAGE"),
        fits.ImageHDU(np.zeros((n, n), dtype=np.int32), header=hdr, name="FLAGS"),
        fits.ImageHDU(zodi, header=hdr, name="ZODI"),
    ])
    path = tmp_path / f"cut_{angle_deg}.fits"
    hdul.writeto(path)
    return path


@pytest.mark.parametrize("angle", [0, 33, 200])
def test_alignment_puts_target_in_centre(tmp_path, angle):
    ra, dec = 133.795129, -7.245147
    path = _rotated_cutout(tmp_path, ra, dec, angle)
    out = cutouts.align_cutout(path, ra, dec, fov_deg=4 / 60, size=65)
    peak = np.unravel_index(np.nanargmax(out.data), out.data.shape)
    assert peak == (32, 32)
    assert out.coverage > 0.95
    # zodi removed: background close to zero
    assert abs(np.nanmedian(out.data)) < 0.01


def test_png_render():
    data = np.random.default_rng(0).normal(0, 1, (32, 32)).astype(np.float32)
    data[0, 0] = np.nan
    png = render.to_png(data)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
