// Downloads the SPHEREx data the viewer needs for the challenge targets and
// saves it under frontend/public/preload/, so those targets open without
// waiting on IRSA (handy for demos). Anything not in the bundle, and anything
// newer than it, is still fetched live by the site.
//
//   node scripts/prefetch-targets.mjs     (every target in targets.ts; Node 22+)
//
// What gets saved per target (all gzipped):
//   - the image search answer (list of exposures)
//   - up to VIEW_MAX of the default view's cutouts (10 arcmin, the target's
//     suggested band), spread evenly over time; the rest load live
//   - small 17 px stamps of every exposure, for the spectrum and light curve
//     (only the light curve's sample where there are more than STAMP_ALL)
// plus one PSF table per detector, shared by every target.
// Files already on disk are reused (released exposures never change), so a
// refresh only downloads what is new.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { SPHEREX_AT, TARGETS } from "../frontend/src/data/targets.ts";
import { sample } from "../frontend/src/lightcurve/sample.ts";

const IRSA = "https://irsa.ipac.caltech.edu";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../frontend/public/preload");
// Must match the site: urlState.ts default fov, align.ts cutoutSizeDeg, science.ts STAMP_DEG
const VIEW_DEG = (10 / 60) * 1.5 + 0.01;
const STAMP_DEG = (17 * 6.2) / 3600;
const BLOCK = 2880;
const VIEW_MAX = Infinity; // lower this to bundle fewer frames per target
const STAMP_ALL = 500;

const targets = TARGETS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const busy = [429, 502, 503, 504].includes(res.status) || (buf.length < 400 && /busy/i.test(buf.toString()));
      if (res.ok && !busy) return buf;
      if (!busy) throw new Error(`${res.status} for ${url}`);
    } catch (err) {
      if (attempt >= 6) throw err;
    }
    await sleep(Math.min(10000, 1000 * 2 ** attempt));
  }
}

// Four at a time: IRSA says "busy" above that.
async function pool(items, fn, n = 4) {
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
        if (++done % 20 === 0) console.log(`  ${done}/${items.length}`);
      }
    }),
  );
}

/** Keep the file only up to the end of the last HDU the site reads. */
function trimFits(buf, keep) {
  let off = 0;
  let end = 0;
  while (off < buf.length) {
    const h = {};
    for (let done = false; !done && off < buf.length; off += BLOCK) {
      for (let i = 0; i < 36; i++) {
        const card = buf.toString("latin1", off + i * 80, off + i * 80 + 80);
        if (card.startsWith("END ")) { done = true; break; }
        const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('?)(.*?)\2\s*(\/|$)/);
        if (m) h[m[1]] = m[3].trim();
      }
    }
    let count = Number(h.NAXIS ?? 0) > 0 ? 1 : 0;
    for (let i = 1; i <= Number(h.NAXIS ?? 0); i++) count *= Number(h[`NAXIS${i}`]);
    const bytes = (count * Math.abs(Number(h.BITPIX ?? 8))) / 8 + Number(h.PCOUNT ?? 0);
    off += Math.ceil(bytes / BLOCK) * BLOCK;
    if (keep.includes(String(h.EXTNAME ?? "").trim())) end = off;
  }
  return buf.subarray(0, end || buf.length);
}

function framesFromSia(xml) {
  const names = [...xml.matchAll(/<FIELD[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
  const best = new Map();
  for (const tr of xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const tds = [...tr[1].matchAll(/<TD>([\s\S]*?)<\/TD>|<TD\/>/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
    const row = Object.fromEntries(names.map((n, i) => [n, tds[i] ?? ""]));
    if (row.dataproduct_type !== "image" || Number(row.calib_level) !== 2) continue;
    const band = row.energy_bandpassname ?? "";
    if (!band.includes("-D")) continue;
    const detector = Number(band.split("-D").pop());
    const id = `${row.obs_id}-D${detector}`;
    const old = best.get(id);
    if (!old || row.obs_release_date > old.release)
      best.set(id, { id, detector, mjd: Number(row.t_min), url: row.access_url, release: row.obs_release_date });
  }
  return [...best.values()].sort((a, b) => a.mjd - b.mjd || a.detector - b.detector);
}

const even = (list, n) =>
  list.length <= n ? list : Array.from({ length: n }, (_, k) => list[Math.floor(((k + 0.5) * list.length) / n)]);
const nameOf = (key) => createHash("sha1").update(key).digest("hex").slice(0, 16) + ".bin";

const files = {};
const epsf = {};
let total = 0;

function save(key, data) {
  const name = nameOf(key);
  const gz = gzipSync(data, { level: 9 });
  writeFileSync(join(OUT, name), gz);
  files[key] = name;
  total += gz.length;
  return gz.length;
}

const cutoutKey = (url, ra, dec, size) =>
  `${url.slice(IRSA.length)}?center=${ra.toFixed(6)},${dec.toFixed(6)}deg&size=${size.toFixed(5)}deg`;

mkdirSync(OUT, { recursive: true });

// Where a target really is today (e.g. WISE 0855), the 3D map measures its
// spectrum there, so bundle the stamps for that spot too
const spots = targets.flatMap((t) =>
  SPHEREX_AT[t.id] ? [t, { ...t, ...SPHEREX_AT[t.id], name: `${t.name} (today)`, stampsOnly: true }] : [t],
);

for (const t of spots) {
  console.log(`${t.name}: searching`);
  const pos = `circle ${t.ra.toFixed(6)} ${t.dec.toFixed(6)} 0.0003`;
  const searchKey = `/SIA?POS=${encodeURIComponent(pos)}&INSTRUMENT=SPHEREx&RESPONSEFORMAT=VOTABLE`;
  const xml = await get(IRSA + searchKey);
  save(searchKey, xml);
  const frames = framesFromSia(xml.toString());
  const inBand = frames.filter((f) => f.detector === t.suggested_band);
  const view = t.stampsOnly ? [] : even(inBand, VIEW_MAX);
  const stamps = frames.length > STAMP_ALL ? sample(frames) : frames;
  console.log(`${t.name}: ${frames.length} exposures; bundling ${view.length} of ${inBand.length} in band ${t.suggested_band}, ${stamps.length} stamps`);
  const jobs = [
    ...view.map((f) => ({ f, size: VIEW_DEG })),
    ...stamps.map((f) => ({ f, size: STAMP_DEG })),
  ];
  const before = total;
  await pool(jobs, async ({ f, size }) => {
    const key = cutoutKey(f.url, t.ra, t.dec, size);
    const name = nameOf(key);
    if (existsSync(join(OUT, name)) && (size !== STAMP_DEG || epsf[f.detector])) {
      files[key] = name;
      total += statSync(join(OUT, name)).size;
      return;
    }
    const buf = await get(IRSA + key);
    save(key, trimFits(buf, ["IMAGE", "FLAGS", "VARIANCE", "ZODI"]));
    // The PSF table rides along in every cutout and is the same for every
    // exposure of a detector, so keep one per detector
    if (size === STAMP_DEG && !epsf[f.detector]) {
      epsf[f.detector] = "pending";
      save(`epsf/D${f.detector}`, trimFits(buf, ["EPSF"]));
      epsf[f.detector] = files[`epsf/D${f.detector}`];
    }
  });
  console.log(`${t.name}: ${((total - before) / 1e6).toFixed(1)} MB`);
}

// Drop files from earlier runs that are no longer used
const used = new Set(Object.values(files));
for (const f of readdirSync(OUT)) if (f.endsWith(".bin") && !used.has(f)) rmSync(join(OUT, f));

writeFileSync(
  join(OUT, "manifest.json"),
  JSON.stringify({ generated: new Date().toISOString(), targets: targets.map((t) => t.id), epsf, files }),
);
console.log(`Done: ${Object.keys(files).length} files, ${(total / 1e6).toFixed(1)} MB in ${OUT}`);
