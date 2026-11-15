// Light curve maths. It reuses the spectrum measurement (forced PSF photometry
// in every exposure, see data/science.ts) and lays it out against time.
//
// SPHEREx sees a different wavelength in every exposure, so raw fluxes jump
// around just because of the star's colour. To take that out, each exposure is
// divided by the average of all exposures at the same channel (one of the 102
// narrow colours). A steady star then sits at 100% whatever the colour, and a
// variable one rises and falls together across channels.
import type { Spectrum, SpectrumPoint } from "../data/api";

export interface CurvePoint {
  id: string;
  detector: number;
  mjd: number;
  date: string;
  wavelength: number | null;
  value: number; // percent of the channel average, or µJy when raw
  err: number;
}

export interface Missing {
  id: string;
  detector: number;
  mjd: number;
  date: string;
  reason: string;
}

export interface Visit {
  mjd: number;
  first: number;
  last: number;
  value: number;
  err: number;
  n: number;
}

export interface Curve {
  raw: boolean;
  points: CurvePoint[];
  missing: Missing[];
  visits: Visit[];
  /** Peak-to-trough change between visits, in percent (null with fewer than two visits). */
  swing: number | null;
}

/** Exposures closer than this many days count as one visit. */
const VISIT_GAP = 6;

const plain = (p: SpectrumPoint) => {
  const why = p.reason ?? "not measured";
  if (why.startsWith("saturated")) return "too bright: saturated";
  if (why.startsWith("too many flagged")) return "masked: bad pixels on the star";
  if (why.startsWith("position is off")) return "star falls off this frame";
  if (why.startsWith("could not read")) return "archive did not answer";
  return why;
};

/** band 0 = all six detectors. */
export function buildCurve(s: Spectrum, band: number, raw: boolean): Curve {
  const mean = new Map(s.channels.map((c) => [c.index, c]));
  // A channel seen only once borrows its two neighbours (same band), whose
  // colour is within a few percent, so sparse samples still compare.
  const reference = (idx: number) => {
    const own = mean.get(idx);
    if (own && own.n >= 2) return own;
    const near = [idx - 1, idx, idx + 1]
      .filter((i) => Math.floor(i / 17) === Math.floor(idx / 17))
      .map((i) => mean.get(i))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const n = near.reduce((a, c) => a + c.n, 0);
    if (n < 2) return own;
    const w = near.map((c) => 1 / c.flux_err_ujy ** 2);
    const sw = w.reduce((a, b) => a + b, 0);
    return { ...near[0], n, flux_ujy: near.reduce((a, c, i) => a + w[i] * c.flux_ujy, 0) / sw, flux_err_ujy: 1 / Math.sqrt(sw) };
  };
  const points: CurvePoint[] = [];
  const missing: Missing[] = [];
  for (const p of s.points as (SpectrumPoint & { channel_index?: number | null })[]) {
    if (band && p.detector !== band) continue;
    const base = { id: p.id, detector: p.detector, mjd: p.mjd, date: p.date };
    if (!p.ok || p.flux_ujy === undefined || p.flux_err_ujy === undefined) {
      missing.push({ ...base, reason: plain(p) });
      continue;
    }
    if (raw) {
      points.push({ ...base, wavelength: p.wavelength, value: p.flux_ujy, err: p.flux_err_ujy });
      continue;
    }
    const c = p.channel_index != null ? reference(p.channel_index) : undefined;
    if (!c || c.n < 2) {
      missing.push({ ...base, reason: "only one look at this colour, nothing to compare with" });
      continue;
    }
    if (!(c.flux_ujy > 3 * c.flux_err_ujy)) {
      missing.push({ ...base, reason: "too faint at this colour to compare" });
      continue;
    }
    points.push({
      ...base,
      wavelength: p.wavelength,
      value: (100 * p.flux_ujy) / c.flux_ujy,
      err: (100 * p.flux_err_ujy) / c.flux_ujy,
    });
  }
  points.sort((a, b) => a.mjd - b.mjd);
  missing.sort((a, b) => a.mjd - b.mjd);
  const visits = groupVisits(points);
  let swing: number | null = null;
  if (!raw && visits.length > 1) {
    const vals = visits.filter((v) => v.n >= 3).map((v) => v.value);
    if (vals.length > 1) swing = Math.max(...vals) - Math.min(...vals);
  }
  return { raw, points, missing, visits, swing };
}

/** Weighted mean per visit. Scatter beyond the error bars widens the error. */
function groupVisits(points: CurvePoint[]): Visit[] {
  const groups: CurvePoint[][] = [];
  for (const p of points) {
    const g = groups[groups.length - 1];
    if (g && p.mjd - g[g.length - 1].mjd <= VISIT_GAP) g.push(p);
    else groups.push([p]);
  }
  return groups.map((g) => {
    const w = g.map((p) => 1 / Math.max(p.err, 1e-6) ** 2);
    const sw = w.reduce((a, b) => a + b, 0);
    const value = g.reduce((a, p, i) => a + w[i] * p.value, 0) / sw;
    let err = 1 / Math.sqrt(sw);
    if (g.length > 1) {
      const chi2 = g.reduce((a, p, i) => a + w[i] * (p.value - value) ** 2, 0) / (g.length - 1);
      err *= Math.max(1, Math.sqrt(chi2));
    }
    const mjd = g.reduce((a, p) => a + p.mjd, 0) / g.length;
    return { mjd, first: g[0].mjd, last: g[g.length - 1].mjd, value, err, n: g.length };
  });
}

export function curveCsv(c: Curve) {
  const unit = c.raw ? "flux_uJy" : "percent_of_channel_average";
  const rows = [`frame,detector,mjd,date,wavelength_um,${unit},error,status`];
  for (const p of c.points) rows.push([p.id, p.detector, p.mjd, p.date, p.wavelength ?? "", p.value.toFixed(3), p.err.toFixed(3), "measured"].join(","));
  for (const m of c.missing) rows.push([m.id, m.detector, m.mjd, m.date, "", "", "", `"${m.reason}"`].join(","));
  return URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
}
