// Everything that talks to IRSA (NASA/IPAC Infrared Science Archive).
//
// IRSA does not send CORS headers, so a browser cannot call it directly from
// another website. Every request therefore goes to IRSA_BASE, a same-site path
// that the host forwards to https://irsa.ipac.caltech.edu (one rewrite rule in
// netlify.toml / vercel.json, the Vite dev server, or the Cloudflare worker in
// proxy/). No code of ours runs on a server.

import { readFitsHdus } from "./fits";
import type { Cutout } from "./align";

export const IRSA_BASE = ((import.meta.env.VITE_IRSA_BASE as string | undefined) ?? "/irsa").replace(/\/$/, "");
const IRSA_ORIGIN = "https://irsa.ipac.caltech.edu";

/** Point an IRSA URL at our proxy. */
export const viaProxy = (url: string) =>
  url.startsWith(IRSA_ORIGIN) ? IRSA_BASE + url.slice(IRSA_ORIGIN.length) : url;

export interface Frame {
  id: string; // e.g. "2025W19_1B_0116_1-D3"
  obs_id: string;
  detector: number; // 1..6
  mjd: number;
  date: string; // ISO UTC
  exptime: number;
  wave_min: number; // microns
  wave_max: number;
  collection: string;
  release_date: string;
  access_url: string;
}

// ---------------------------------------------------------------- helpers

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

// IRSA answers "503 Server busy" above roughly four requests at once.
const MAX_PARALLEL = 4;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

/** fetch() with retries for "server busy" answers. */
async function fetchRetry(url: string, signal?: AbortSignal, tries = 7): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (signal?.aborted || attempt >= tries - 1) throw err;
    }
    if (res) {
      if (!RETRY_STATUS.has(res.status)) return res;
      if (attempt >= tries - 1) throw new Error(`IRSA is busy (${res.status}), try again shortly`);
      res.body?.cancel().catch(() => {});
    }
    await sleep(Math.min(8000, 750 * 2 ** attempt) * (0.75 + Math.random() / 2), signal);
  }
}

// ---------------------------------------------------------------- search

/** Parse an IVOA VOTable (TABLEDATA) into row objects. */
function parseVotable(xml: string): Record<string, string>[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.querySelector("INFO[name=QUERY_STATUS][value=ERROR]");
  if (err) throw new Error(`IRSA search failed: ${err.textContent?.trim()}`);
  const names = Array.from(doc.getElementsByTagName("FIELD")).map((f) => f.getAttribute("name") ?? "");
  return Array.from(doc.getElementsByTagName("TR")).map((tr) => {
    const row: Record<string, string> = {};
    Array.from(tr.getElementsByTagName("TD")).forEach((td, i) => (row[names[i]] = td.textContent ?? ""));
    return row;
  });
}

const mjdToIso = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString().replace("Z", "");

export function framesFromSia(xml: string): Frame[] {
  const best = new Map<string, Frame>();
  for (const row of parseVotable(xml)) {
    if (row.dataproduct_type !== "image" || Number(row.calib_level) !== 2) continue;
    const band = row.energy_bandpassname ?? ""; // "SPHEREx-D3"
    if (!band.includes("-D")) continue;
    const detector = Number(band.split("-D").pop());
    const mjd = Number(row.t_min);
    const frame: Frame = {
      id: `${row.obs_id}-D${detector}`,
      obs_id: row.obs_id,
      detector,
      mjd,
      date: mjdToIso(mjd),
      exptime: Number(row.t_exptime),
      wave_min: Math.round(Number(row.em_min) * 1e10) / 1e4,
      wave_max: Math.round(Number(row.em_max) * 1e10) / 1e4,
      collection: row.obs_collection,
      release_date: row.obs_release_date,
      access_url: row.access_url,
    };
    // The same exposure can appear in more than one release. Keep the newest.
    const old = best.get(frame.id);
    if (!old || frame.release_date > old.release_date) best.set(frame.id, frame);
  }
  return [...best.values()].sort((a, b) => a.mjd - b.mjd || a.detector - b.detector);
}

/** Other SPHEREx products covering a position, such as the DR1 all-sky
 *  spectral cube tile (all 102 colours stacked, one file per 1.8° patch). */
export interface Product {
  collection: string;
  type: string; // "cube", ...
  access_url: string;
  size_kb: number | null;
}

export function productsFromSia(xml: string): Product[] {
  return parseVotable(xml)
    .filter((r) => r.dataproduct_type !== "image" && r.access_url)
    .map((r) => ({
      collection: r.obs_collection,
      type: r.dataproduct_type,
      access_url: r.access_url,
      size_kb: Number(r.access_estsize) || null,
    }));
}

const products = new Map<string, Product[]>();
/** Products found by the last image search at this position (see searchFrames). */
export const productsAt = (ra: number, dec: number) => products.get(`${ra.toFixed(5)},${dec.toFixed(5)}`) ?? [];

// Searches are reused for an hour, then IRSA is asked again so new SPHEREx
// observations (and new releases: we search by instrument, not collection)
// appear without any code change.
const SEARCH_TTL_MS = 3600_000;
const searches = new Map<string, { at: number; frames: Frame[] }>();
const status = { last_search_utc: null as string | null, collections: {} as Record<string, string> };

export async function searchFrames(ra: number, dec: number, refresh = false, signal?: AbortSignal): Promise<Frame[]> {
  const key = `${ra.toFixed(5)},${dec.toFixed(5)}`;
  const hit = searches.get(key);
  if (hit && !refresh && Date.now() - hit.at < SEARCH_TTL_MS) return hit.frames;
  const pos = `circle ${ra.toFixed(6)} ${dec.toFixed(6)} 0.0003`;
  const url = `${IRSA_BASE}/SIA?POS=${encodeURIComponent(pos)}&INSTRUMENT=SPHEREx&RESPONSEFORMAT=VOTABLE`;
  let frames: Frame[];
  try {
    const res = await fetchRetry(url, signal);
    if (!res.ok) throw new Error(`IRSA image search failed (${res.status})`);
    const xml = await res.text();
    frames = framesFromSia(xml);
    products.set(key, productsFromSia(xml));
  } catch (err) {
    if (hit && !signal?.aborted) return hit.frames; // IRSA down: the old answer is still useful
    throw err;
  }
  searches.set(key, { at: Date.now(), frames });
  status.last_search_utc = new Date().toISOString();
  for (const f of frames) {
    const seen = status.collections[f.collection];
    if (!seen || f.date > seen) status.collections[f.collection] = f.date;
  }
  return frames;
}

export const searchStatus = () => ({
  source: "NASA/IPAC Infrared Science Archive (IRSA)",
  search_ttl_seconds: SEARCH_TTL_MS / 1000,
  ...status,
});

// ---------------------------------------------------------------- cutouts

// Parsed cutouts, newest last. A released exposure never changes.
const CUTOUT_CACHE_MAX = 400;
const cutouts = new Map<string, Promise<Cutout>>();

/** Download the image, flags and zodiacal-light planes of one exposure around
 *  (ra, dec). IRSA cuts the image on its side; we stop reading the answer once
 *  the planes we need have arrived. */
export function fetchCutout(
  frame: Frame,
  ra: number,
  dec: number,
  sizeDeg: number,
  signal?: AbortSignal,
  withPsf = false,
): Promise<Cutout> {
  const key = `${frame.collection}/${frame.id}/${ra.toFixed(5)},${dec.toFixed(5)}/${sizeDeg.toFixed(4)}${withPsf ? "/psf" : ""}`;
  const cached = cutouts.get(key);
  if (cached) return cached;
  const url = `${viaProxy(frame.access_url)}?center=${ra.toFixed(6)},${dec.toFixed(6)}deg&size=${sizeDeg.toFixed(5)}deg`;
  const job = slot(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchRetry(url, signal);
      if (!res.ok) throw new Error(`IRSA cutout failed for ${frame.id} (${res.status})`);
      try {
        const h = await readFitsHdus(res, ["IMAGE", "FLAGS", "VARIANCE", "ZODI", ...(withPsf ? ["EPSF"] : [])]);
        if (!h.IMAGE) throw new Error(`No image in cutout for ${frame.id}`);
        return { image: h.IMAGE, flags: h.FLAGS, variance: h.VARIANCE, zodi: h.ZODI, epsf: h.EPSF };
      } catch (err) {
        // "Server busy, retry later." can also come back as a short text answer
        if (signal?.aborted || attempt >= 5 || !/busy/i.test(String(err))) throw err;
        await sleep(Math.min(8000, 1000 * 2 ** attempt) * (0.75 + Math.random() / 2), signal);
      }
    }
  });
  cutouts.set(key, job);
  job.catch(() => cutouts.delete(key));
  if (cutouts.size > CUTOUT_CACHE_MAX) cutouts.delete(cutouts.keys().next().value as string);
  return job;
}
