"""Offline tests for flags, co-adds, channels and spectra."""
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app import bands, cutouts, quality, spectra

RA, DEC = 133.795129, -7.245147
SOURCE, HOT = 1 << 21, 1 << 10
SCALE = 6.15 / 3600


def _wcs(angle_deg=0.0, n=61):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA, DEC]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    a = np.deg2rad(angle_deg)
    w.wcs.cd = [[-SCALE * np.cos(a), SCALE * np.sin(a)], [SCALE * np.sin(a), SCALE * np.cos(a)]]
    return w


def _flag_header(hdr):
    hdr = hdr.copy()
    hdr["MSKN0010"], hdr["MSKD0010"] = "HOT", "Hot pixel"
    hdr["MSKN0021"], hdr["MSKD0021"] = "SOURCE", "Pixel mapped to a known source"
    return hdr


def _exposure(tmp_path, name, image, flags, angle=0.0, variance=0.01, extra=()):
    n = image.shape[0]
    hdr = _wcs(angle, n).to_header()
    hdul = fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU(image.astype(np.float32), header=hdr, name="IMAGE"),
        fits.ImageHDU(flags.astype(np.int32), header=_flag_header(hdr), name="FLAGS"),
        fits.ImageHDU(np.full(image.shape, variance, dtype=np.float32), header=hdr, name="VARIANCE"),
        fits.ImageHDU(np.zeros(image.shape, dtype=np.float32), header=hdr, name="ZODI"),
        *extra,
    ])
    path = tmp_path / f"{name}.fits"
    hdul.writeto(path)
    return path


def test_102_channels_in_order():
    ch = bands.all_channels()
    assert len(ch) == 102
    assert [c["index"] for c in ch] == list(range(102))
    centres = [c["wave_center"] for c in ch]
    assert centres == sorted(centres)
    assert bands.channel_of(6, 4.43) == 1 and bands.channel_of(6, 4.99) == 17
    assert bands.channel_of(1, 3.0) is None


def test_source_flag_is_not_bad():
    hdr = _flag_header(fits.Header())
    flags = np.array([[0, SOURCE], [HOT, HOT | SOURCE]])
    assert quality.bad_pixels(flags, hdr).tolist() == [[False, False], [True, True]]


def test_bad_pixel_is_filled_for_display_but_masked_for_science(tmp_path):
    n = 61
    image = np.full((n, n), 1.0)
    flags = np.full((n, n), SOURCE)          # "source" everywhere: must not count as bad
    image[30, 30] = 5000.0                   # a hot pixel right at the target
    flags[30, 30] |= HOT
    path = _exposure(tmp_path, "hot", image, flags)
    out = cutouts.align_cutout(path, RA, DEC, fov_deg=3 / 60, size=64)
    assert out.flagged_fraction == pytest.approx(1 / n ** 2)
    assert np.nanmax(out.data) == pytest.approx(1.0, abs=1e-4)   # spike gone from the picture
    assert np.isnan(out.science[32, 32])                         # and not invented in the data
    assert out.filled[32, 32]


def _star(n, x, y, flux=100.0, sigma=1.2):
    yy, xx = np.mgrid[:n, :n]
    g = np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))
    return flux * g / g.sum()


def test_coadd_keeps_brightness_and_rejects_outliers(tmp_path):
    n, rng = 61, np.random.default_rng(1)
    images, ids = [], []
    for i, angle in enumerate([0, 40, 95, 170, 260, 300]):
        img = 0.5 + _star(n, 30, 30) + rng.normal(0, 0.02, (n, n))
        flags = np.zeros((n, n), dtype=int)
        if i == 2:                            # unflagged cosmic ray away from the star
            x, y = _wcs(angle, n).world_to_pixel_values(RA + 20 / 3600, DEC + 20 / 3600)
            img[int(round(float(y))), int(round(float(x)))] += 300
        if i == 4:                            # flagged garbage on top of the star
            img[29:32, 29:32] = -999
            flags[29:32, 29:32] = HOT
        path = _exposure(tmp_path, f"f{i}", img, flags, angle=angle, variance=0.02 ** 2)
        images.append(cutouts.align_cutout(path, RA, DEC, fov_deg=3 / 60, size=64))
        ids.append(f"f{i}")
    result = cutouts.coadd(images, ids)
    data = result.image.science
    truth = cutouts.align_cutout(
        _exposure(tmp_path, "truth", 0.5 + _star(n, 30, 30), np.zeros((n, n), dtype=int)),
        RA, DEC, fov_deg=3 / 60, size=64).science
    # same brightness as a single clean frame, everywhere, including the star's peak
    assert np.nanmax(np.abs(data - truth)) < 0.04 * np.nanmax(truth)
    assert np.nanmax(data) == pytest.approx(np.nanmax(truth), rel=0.02)
    assert np.nanmedian(data) == pytest.approx(0.5, abs=0.005)
    assert result.count.max() == 6 and result.count[32, 32] == 5   # flagged frame left out there
    assert result.image.noise == pytest.approx(0.02 / np.sqrt(6), rel=1e-6)


def test_coadd_does_not_clip_a_star_that_changes_with_wavelength(tmp_path):
    n = 61
    images = []
    for i, flux in enumerate([50, 80, 120, 200, 320]):
        path = _exposure(tmp_path, f"w{i}", _star(n, 30, 30, flux), np.zeros((n, n), dtype=int),
                         variance=1e-4)
        images.append(cutouts.align_cutout(path, RA, DEC, fov_deg=3 / 60, size=64))
    result = cutouts.coadd(images, [str(i) for i in range(5)])
    expected = np.mean([np.nanmax(im.science) for im in images])
    assert np.nanmax(result.image.science) == pytest.approx(expected, rel=0.01)


def _epsf_hdu(sigma_px=0.9, over=5):
    yy, xx = np.mgrid[:33, :33]
    psf = np.exp(-((xx - 16) ** 2 + (yy - 16) ** 2) / (2 * (sigma_px * over) ** 2))
    hdr = fits.Header()
    hdr["OVSMPX"], hdr["OVSMPY"] = over, over
    return fits.ImageHDU(psf / psf.sum(), header=hdr, name="EPSF")


@pytest.mark.parametrize("offset", [(0.0, 0.0), (0.37, -0.21)])
def test_forced_photometry_recovers_flux(tmp_path, offset):
    n, rng = 17, np.random.default_rng(3)
    x, y = 8 + offset[0], 8 + offset[1]
    flux = 400.0                                             # MJy/sr summed over pixels
    image = 2.0 + _star(n, x, y, flux, sigma=0.9) + rng.normal(0, 0.05, (n, n))
    flags = np.zeros((n, n), dtype=int)
    image[9, 9] = 1e5                                        # flagged junk next to the source
    flags[9, 9] = HOT
    path = _exposure(tmp_path, "phot", image, flags, variance=0.05 ** 2, extra=(_epsf_hdu(),))
    ra, dec = _wcs(0, n).pixel_to_world_values(x, y)
    m = spectra.measure(path, float(ra), float(dec))
    omega = SCALE ** 2 * (np.pi / 180) ** 2
    assert m["ok"] and m["bad_pixels_in_fit"] == 1
    assert m["flux_ujy"] == pytest.approx(flux * omega * 1e12, rel=0.03)
    assert m["background_mjy_sr"] == pytest.approx(2.0, abs=0.05)
    assert 0.2 < m["chi2_dof"] < 3


def test_photometry_refuses_when_source_is_flagged(tmp_path):
    n = 17
    flags = np.zeros((n, n), dtype=int)
    flags[6:11, 6:11] = HOT
    path = _exposure(tmp_path, "masked", _star(n, 8, 8), flags, extra=(_epsf_hdu(),))
    m = spectra.measure(path, RA, DEC)
    assert m["ok"] is False


def test_binning_uses_only_good_points():
    pts = [
        {"ok": True, "channel_index": 90, "wavelength": 4.6, "flux_ujy": 100.0, "flux_err_ujy": 10.0},
        {"ok": True, "channel_index": 90, "wavelength": 4.6, "flux_ujy": 120.0, "flux_err_ujy": 10.0},
        {"ok": False, "channel_index": 90, "wavelength": 4.6, "flux_ujy": 9e9, "flux_err_ujy": 1.0},
    ]
    out = spectra.bin_by_channel(pts)
    assert len(out) == 1 and out[0]["n"] == 2
    assert out[0]["flux_ujy"] == pytest.approx(110.0)
    assert out[0]["flux_err_ujy"] == pytest.approx(10.0)  # widened: scatter exceeds formal 7.07
