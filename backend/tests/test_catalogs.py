"""Offline tests for the catalogue overlays."""
import pytest

from app import catalogs

GAIA_ANSWER = """\\fixlen = T
|           source_id|            ra|           dec|      pmra|     pmdec|  parallax| phot_g_mean_mag|  ruwe|
|                long|        double|        double|    double|    double|    double|          double|double|
|                    |           deg|           deg|    mas/yr|    mas/yr|       mas|             mag|      |
|                null|          null|          null|      null|      null|      null|            null|  null|
  4472832130942575872 269.44850252544  4.73942005111  -801.551 10362.394  546.9759         8.193974  1.085
  4472832165289153024 269.46646068714  4.70557281066      null      null      null        11.451174   null
"""

WISE_ANSWER = """\\fixlen = T
|source_name        |ra_pm      |dec_pm    |pmra    |pmdec   |sigpmra|sigpmdec|rchi2_pm |w1mpro|w2mpro|ab_flags|cc_flags|
|char               |double     |double    |double  |double  |double |double  |double   |double|double|char    |char    |
|                   |deg        |deg       |arcsec/yr|arcsec/yr|arcsec/yr|arcsec/yr|        |mag   |mag   |        |        |
|null               |null       |null      |null    |null    |null   |null    |null     |null  |null  |null    |null    |
 J085509.09-071455.7 133.7879010 -7.2488212 -1.20000  0.10000 0.0500  0.0500   1.10000   18.23  15.67  00       0000
 J175746.05+044446.2 269.4418981  4.7461853  1.25534  2.40842 0.0117  0.0117   354.100   14.50  12.50  00       hHH0
"""


def test_parse_gaia_sorts_by_brightness_and_keeps_motion():
    rows = catalogs.parse_gator(catalogs.CATALOGS["gaia"], GAIA_ANSWER)
    assert [r["mag"] for r in rows] == pytest.approx([8.193974, 11.451174])
    barnard = rows[0]
    assert barnard["id"] == "Gaia DR3 4472832130942575872"
    assert barnard["pmdec"] == pytest.approx(10362.394)
    assert rows[1]["pmra"] is None and rows[1]["parallax"] is None


def test_parse_catwise_converts_units_and_flags_bad_motion():
    rows = catalogs.parse_gator(catalogs.CATALOGS["wise"], WISE_ANSWER)
    good, halo = rows[1], rows[0]  # sorted by W2, the halo piece is brighter
    assert good["pmra"] == pytest.approx(-1200.0)  # arcsec/yr -> mas/yr
    assert good["pm_ok"] and not good["spurious"]
    assert not halo["pm_ok"]  # terrible motion fit
    assert halo["spurious"]  # upper-case contamination flag


def test_known_movers_found_near_wise0855_only():
    assert catalogs.known_movers(133.795129, -7.245147, 10)["total"] == 1
    assert catalogs.known_movers(269.452, 4.6933, 10)["total"] == 0


def test_wider_views_ask_for_brighter_stars():
    assert catalogs.mag_limit("gaia", 5) > catalogs.mag_limit("gaia", 40)
    assert catalogs.mag_limit("wise", 10) > catalogs.mag_limit("wise", 60)
