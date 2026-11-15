// Which exposures the light curve measures. Kept free of browser-only imports
// so scripts/prefetch-targets.mjs can bundle exactly these stamps.
export interface Timed {
  detector: number;
  mjd: number;
}

const MAX = 360;
const VISIT_GAP = 6; // days

export function sample<F extends Timed>(frames: F[]): F[] {
  if (frames.length <= MAX) return frames;
  const groups = new Map<string, F[]>();
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
  const out: F[] = [];
  for (const g of groups.values()) {
    const n = Math.min(g.length, Math.max(2, Math.round(g.length * share)));
    for (let k = 0; k < n; k++) out.push(g[Math.floor(((k + 0.5) * g.length) / n)]);
  }
  return out;
}
