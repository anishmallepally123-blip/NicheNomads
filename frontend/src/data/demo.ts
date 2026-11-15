// "Save for the demo": downloads every picture the viewer needs for the five
// challenge targets (default 10 arcmin view, suggested detector) plus the
// spectra of the two that SPHEREx can measure. Everything lands in the
// browser's Cache Storage (see savedFetch / fetchCutout in irsa.ts), so later
// visits, reloads and a bad venue Wi-Fi skip the wait.
import { cutoutSizeDeg } from "./align";
import { fetchCutout, searchFrames } from "./irsa";
import { spectrum } from "./science";
import { SPHEREX_AT, TARGETS } from "./targets";

const FOV_DEG = 10 / 60; // DEFAULT_STATE.fov in state/urlState.ts
const SPECTRA = ["wise0855", "epsindb"]; // the others are saturated in SPHEREx
const DONE_KEY = "niche-demo-saved";

export const demoSavedAt = (): string | null => {
  try {
    return localStorage.getItem(DONE_KEY);
  } catch {
    return null;
  }
};

export async function saveDemo(onProgress: (done: number, total: number, what: string) => void, signal?: AbortSignal) {
  if (typeof caches === "undefined") throw new Error("This browser can't keep downloads (needs https).");
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict it
  const lists = await Promise.all(TARGETS.map((t) => searchFrames(t.ra, t.dec, false, signal)));
  const jobs: { name: string; run: () => Promise<unknown>; weight: number }[] = [];
  TARGETS.forEach((t, i) => {
    for (const f of lists[i].filter((f) => f.detector === t.suggested_band)) {
      jobs.push({ name: t.name, weight: 1, run: () => fetchCutout(f, t.ra, t.dec, cutoutSizeDeg(FOV_DEG), signal) });
    }
  });
  let done = 0;
  let total = jobs.length;
  const spectra = TARGETS.filter((t) => SPECTRA.includes(t.id));
  const spectraFrames = await Promise.all(spectra.map((t) => {
    const at = SPHEREX_AT[t.id] ?? t;
    return searchFrames(at.ra, at.dec, false, signal);
  }));
  total += spectraFrames.reduce((n, l) => n + l.length, 0);
  onProgress(0, total, "pictures");
  let failed = 0;
  await Promise.all(jobs.map((j) => j.run().catch(() => { failed++; }).finally(() => onProgress(++done, total, j.name))));
  for (const t of spectra) {
    const at = SPHEREX_AT[t.id] ?? t;
    await spectrum(at.ra, at.dec, signal, () => onProgress(++done, total, `${t.name} spectrum`));
  }
  if (signal?.aborted) return failed;
  try {
    localStorage.setItem(DONE_KEY, new Date().toISOString());
  } catch { /* private window */ }
  return failed;
}
