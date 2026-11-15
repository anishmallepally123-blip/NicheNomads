// Measures a star for the light curve. Spots near the ecliptic poles have
// thousands of exposures, far too many to read in a browser, so above MAX it
// measures an even sample: every visit and every band keeps its share.
import { binByChannel, measureFrames, type SpectrumPoint } from "../data/science";
import { searchFrames } from "../data/irsa";
import { sample } from "./sample";
import type { Spectrum } from "../data/api";


export interface Measured extends Spectrum {
  available: number; // exposures in the archive at this spot
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
