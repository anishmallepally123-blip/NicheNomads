// Measures a star for the light curve. Spots near the ecliptic poles have
// thousands of exposures, far too many to read in a browser, so above MAX it
// measures an even sample: every visit and every band keeps its share.
import { binByChannel, measureFrames, type SpectrumPoint } from "../data/science";
import { searchFrames, type Frame } from "../data/irsa";
import type { Spectrum } from "../data/api";

const MAX = 360;
const VISIT_GAP = 6; // days

export interface Measured extends Spectrum {
  available: number; // exposures in the archive at this spot
}

function sample(frames: Frame[]): Frame[] {
  if (frames.length <= MAX) return frames;
  const groups = new Map<string, Frame[]>();
  for (const d of new Set(frames.map((f) => f.detector))) {
    const mine = frames.filter((f) => f.detector === d).sort((a, b) => a.mjd - b.mjd);
    let visit = 0;
    mine.forEach((f, i) => {
      if (i && f.mjd - mine[i - 1].mjd > VISIT_GAP) visit++;
      const key = `${d}:${visit}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    });
  }
  const share = MAX / frames.length;
  const out: Frame[] = [];
  for (const g of groups.values()) {
    const n = Math.min(g.length, Math.max(2, Math.round(g.length * share)));
    for (let k = 0; k < n; k++) out.push(g[Math.floor(((k + 0.5) * g.length) / n)]);
  }
  return out;
}

const cache = new Map<string, Promise<Measured>>();

export function measureStar(ra: number, dec: number, onProgress?: (done: number, total: number) => void): Promise<Measured> {
  const key = `${ra.toFixed(6)},${dec.toFixed(6)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const all = await searchFrames(ra, dec, false);
    const chosen = sample(all);
    let done = 0;
    onProgress?.(0, chosen.length);
    const points: SpectrumPoint[] = await measureFrames(chosen, ra, dec, undefined, () => onProgress?.(++done, chosen.length));
    return {
      ra, dec, points, available: all.length,
      measured: points.filter((p) => p.ok).length,
      total: points.length,
      method: "forced PSF photometry, as for the spectrum",
      channels: binByChannel(points),
    } as Measured;
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}
