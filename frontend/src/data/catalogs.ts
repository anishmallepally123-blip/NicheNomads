// Star catalogues drawn on top of the SPHEREx pictures, queried from the
// browser through IRSA's fast cone search (Gator, about 1 s; IRSA TAP holds
// the same tables but takes 20 to 30 s).
//
//   gaia  Gaia DR3 (gaia_dr3_source). Positions at J2016.0 with proper motions.
//   wise  CatWISE2020 (catwise_2020). WISE infrared sources; sees cold brown
//         dwarfs Gaia cannot. The very fastest objects (Barnard's Star,
//         WISE 0855) are split into several fake pieces in this catalogue.
//
// Plus a tiny hand-made list of famous fast movers that neither catalogue gets
// right. Every source has a reference epoch and proper motion in mas/yr (RA
// motion already times cos dec), so the viewer can move it to each frame's date.

import { IRSA_BASE } from "./irsa";
import type { CatalogResult, CatalogSource, LayerKey } from "../overlays/api";

const GAIA_EPOCH_MJD = 57388.5; // J2016.0
const CATWISE_EPOCH_MJD = 57170.0;
const MAX_SOURCES = 2500; // brightest kept
const MAX_RCHI2_PM = 10; // CatWISE motion fits worse than this are not trusted
const TTL_MS = 24 * 3600_000;

interface Catalog {
  key: "gaia" | "wise";
  label: string;
  table: string;
  columns: string;
  epoch_mjd: number;
  mag_label: string;
  mag_column: string;
  reference: string;
}

export const CATALOGS: Record<"gaia" | "wise", Catalog> = {
  gaia: {
    key: "gaia",
    label: "Gaia DR3",
    table: "gaia_dr3_source",
    columns: "source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,ruwe",
    epoch_mjd: GAIA_EPOCH_MJD,
    mag_label: "G",
    mag_column: "phot_g_mean_mag",
    reference: "Gaia Collaboration 2023, via IRSA",
  },
  wise: {
    key: "wise",
    label: "CatWISE2020",
    table: "catwise_2020",
    columns: "source_name,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,rchi2_pm,w1mpro,w2mpro,ab_flags,cc_flags",
    epoch_mjd: CATWISE_EPOCH_MJD,
    mag_label: "W2",
    mag_column: "w2mpro",
    reference: "Marocco et al. 2021, via IRSA",
  },
};

// WISE 0855-0714: motion and parallax from Luhman & Esplin 2016 (AJ 152, 78).
// Its position at 2014.0 is the one given on the challenge page.
const KNOWN_MOVERS = [
  {
    id: "WISE J085510.83-071442.5",
    name: "WISE 0855-0714",
    ra: 133.795129,
    dec: -7.245147,
    epoch_mjd: 56658.0,
    pmra: -8123.0,
    pmdec: 673.0,
    parallax: 449.0,
    mag: null,
    note: "Coldest known brown dwarf, about 250 K. Not seen by Gaia.",
  },
];

// Faintest magnitude asked for, by field of view (fov arcmin, Gaia G, WISE W2).
const MAG_LIMITS: [number, number, number][] = [[7, 20, 17], [15, 18.5, 15.5], [30, 17, 14], [999, 15.5, 12.5]];

function magLimit(key: string, fov: number) {
  const row = MAG_LIMITS.find(([max]) => fov <= max) ?? MAG_LIMITS[MAG_LIMITS.length - 1];
  return key === "gaia" ? row[1] : row[2];
}

/** Cone that covers the whole square view, plus a margin for motion. */
const searchRadiusArcmin = (fov: number) => fov / Math.SQRT2 + 0.5;

/** Read an IPAC table (Gator's answer) into row objects. */
export function parseIpac(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("\\"));
  const header = lines.findIndex((l) => l.startsWith("|"));
  if (header < 0) return [];
  const bars: number[] = [];
  for (let i = 0; i < lines[header].length; i++) if (lines[header][i] === "|") bars.push(i);
  const names = bars.slice(0, -1).map((b, i) => lines[header].slice(b + 1, bars[i + 1]).trim());
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    if (line.startsWith("|")) continue;
    const row: Record<string, string> = {};
    names.forEach((n, i) => (row[n] = line.slice(bars[i] + 1, bars[i + 1] + 1).trim()));
    rows.push(row);
  }
  return rows;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "" || v === "null") return null;
  const f = Number(v);
  return Number.isFinite(f) ? f : null;
};

function toSource(key: "gaia" | "wise", row: Record<string, string>): CatalogSource {
  if (key === "gaia") {
    return {
      id: `Gaia DR3 ${row.source_id}`,
      ra: Number(row.ra),
      dec: Number(row.dec),
      pmra: num(row.pmra),
      pmdec: num(row.pmdec),
      parallax: num(row.parallax),
      mag: num(row.phot_g_mean_mag),
      ruwe: num(row.ruwe),
    };
  }
  const pmra = num(row.pmra);
  const pmdec = num(row.pmdec);
  const src: CatalogSource = {
    id: `CWISE ${row.source_name}`,
    ra: Number(row.ra_pm),
    dec: Number(row.dec_pm),
    // CatWISE motions are in arcsec/yr, we use mas/yr everywhere.
    pmra: pmra === null ? null : pmra * 1000,
    pmdec: pmdec === null ? null : pmdec * 1000,
    pm_err: null,
    mag: num(row.w2mpro),
    w1: num(row.w1mpro),
    flags: row.ab_flags && row.ab_flags !== "null" ? row.ab_flags : "",
  };
  const e1 = num(row.sigpmra);
  const e2 = num(row.sigpmdec);
  if (e1 !== null && e2 !== null) src.pm_err = Math.round(Math.hypot(e1, e2) * 10000) / 10;
  // Around very bright or fast stars CatWISE has many fake "movers" with
  // terrible motion fits: only trust good fits at 3 sigma or better.
  const chi2 = num(row.rchi2_pm);
  const pm = Math.hypot(src.pmra ?? 0, src.pmdec ?? 0);
  src.pm_ok = chi2 !== null && chi2 <= MAX_RCHI2_PM && (src.pm_err == null || pm >= 3 * src.pm_err);
  const cc = row.cc_flags && row.cc_flags !== "null" ? row.cc_flags : "";
  src.spurious = /[A-Z]/.test(cc); // upper case: probably not a real source
  return src;
}

const cache = new Map<string, { at: number; result: CatalogResult }>();

export async function coneSearch(
  key: "gaia" | "wise",
  ra: number,
  dec: number,
  fov: number,
  signal?: AbortSignal,
): Promise<CatalogResult> {
  const cat = CATALOGS[key];
  const radiusArcsec = Math.round(searchRadiusArcmin(fov) * 600) / 10;
  const faintest = magLimit(key, fov);
  const cacheKey = `${cat.table}/${ra.toFixed(5)},${dec.toFixed(5)}/${radiusArcsec}/${faintest}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  const params = new URLSearchParams({
    catalog: cat.table,
    spatial: "cone",
    objstr: `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`,
    radius: String(radiusArcsec),
    outfmt: "1",
    selcols: cat.columns,
    constraints: `${cat.mag_column}<${faintest}`,
  });
  const res = await fetch(`${IRSA_BASE}/cgi-bin/Gator/nph-query?${params}`, { signal });
  const text = await res.text();
  if (!res.ok || (text.slice(0, 500).includes("[struct stat=") && text.slice(0, 500).includes("ERROR"))) {
    if (hit) return hit.result;
    throw new Error(`${cat.label} search failed${res.ok ? "" : ` (${res.status})`}`);
  }
  const sources = parseIpac(text)
    .map((r) => toSource(key, r))
    .sort((a, b) => (a.mag ?? 99) - (b.mag ?? 99));
  const result: CatalogResult = {
    catalog: key,
    label: cat.label,
    reference: cat.reference,
    epoch_mjd: cat.epoch_mjd,
    mag_label: cat.mag_label,
    radius_arcmin: radiusArcsec / 60,
    mag_limit: faintest,
    total: sources.length,
    truncated: sources.length > MAX_SOURCES,
    sources: sources.slice(0, MAX_SOURCES),
  };
  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** Hand-made fast movers that could be in the view at any time in the past or
 *  next few decades (they move up to ~10 arcsec per year). */
export function knownMovers(ra: number, dec: number, fov: number, spanYears = 30): CatalogResult {
  const reach = searchRadiusArcmin(fov) / 60;
  const cosd = Math.cos((dec * Math.PI) / 180);
  const sources: CatalogSource[] = KNOWN_MOVERS.filter((m) => {
    const dra = ((((m.ra - ra + 180) % 360) + 360) % 360 - 180) * cosd;
    const travel = (Math.hypot(m.pmra, m.pmdec) / 3.6e6) * spanYears;
    return Math.hypot(dra, m.dec - dec) <= reach + travel;
  }).map((m) => ({ ...m }));
  return {
    catalog: "movers" as LayerKey,
    label: "Known fast movers",
    reference: "Literature values",
    epoch_mjd: null,
    mag_label: "",
    radius_arcmin: searchRadiusArcmin(fov),
    mag_limit: null,
    total: sources.length,
    truncated: false,
    sources,
  };
}
