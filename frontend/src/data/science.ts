// Measurements in the browser: per-frame metadata and flags, co-adds, and
// spectra by forced PSF photometry. Same methods as the earlier Python
// version (see docs/ARCHITECTURE.md), ported to TypeScript.

import { alignCutout, cutoutSizeDeg, fillBadPixels, wavelengthAt, type AlignedImage, type Cutout } from "./align";
import { allChannels, channelOf, globalIndex } from "./bands";
import type { Hdu } from "./fits";
import { fetchCutout, searchFrames, type Frame } from "./irsa";
import { badBitmask, flagValues, namesIn, summarize } from "./quality";
import { SipWcs } from "./wcs";

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

async function findFrame(id: string, ra: number, dec: number, signal?: AbortSignal): Promise<Frame> {
  const f = (await searchFrames(ra, dec, false, signal)).find((x) => x.id === id);
  if (!f) throw new Error(`Unknown frame ${id} at this position`);
  return f;
}

// ---------------------------------------------------------------- metadata

/** Metadata and quality flags of one exposure at this position. Uses the same
 *  cutout as the picture, so it is instant once the frame is shown. */
export async function frameMeta(id: string, ra: number, dec: number, fov: number, signal?: AbortSignal) {
  const frame = await findFrame(id, ra, dec, signal);
  const cut = await fetchCutout(frame, ra, dec, cutoutSizeDeg(fov / 60), signal);
  const h = cut.image.header;
  const [px, py] = new SipWcs(h).worldToPix(ra, dec);
  const { wavelength, bandwidth } = wavelengthAt(cut.image, frame.detector, px, py);
  const ci = Math.round(py) - 1;
  const cj = Math.round(px) - 1;
  const { nx, ny } = cut.image;
  const inside = ci >= 0 && ci < ny && cj >= 0 && cj < nx;
  const k = ci * nx + cj;
  const fv = cut.flags ? flagValues(cut.flags) : new Int32Array(nx * ny);
  const fh = cut.flags?.header;
  const mask = badBitmask(fh);
  let nBad = 0;
  for (const v of fv) if (v & mask) nBad++;
  const zodi = inside && cut.zodi ? cut.zodi.data[k] : null;
  const variance = inside && cut.variance ? cut.variance.data[k] : null;
  const get = (key: string) => (key in h ? h[key] : null);
  const channel = channelOf(frame.detector, wavelength);
  const { access_url, ...pub } = frame;
  return {
    frame: pub,
    wavelength,
    bandwidth,
    channel,
    channel_index: channel ? globalIndex(frame.detector, channel) : null,
    target_pixel: {
      flags: inside ? namesIn(fv[k], fh) : [],
      bad: inside ? (fv[k] & mask) !== 0 : null,
      zodi_mjy_sr: zodi !== null ? r(zodi, 4) : null,
      noise_mjy_sr: variance && variance > 0 ? r(Math.sqrt(variance), 4) : null,
    },
    flags: summarize(fv, fh),
    bad_fraction: r(nBad / Math.max(1, fv.length), 4),
    header: {
      date_obs: (get("DATE-OBS") as string) ?? null,
      exposure_s: (get("XPOSURE") as number) ?? null,
      l1_quality: (get("L1DQAFLG") as string) ?? null,
      fine_astrometry_ok: get("FINAST") === null ? null : get("FINAST") === 0,
      astrometry_stars: (get("MATCH_NSTARS") as number) ?? null,
      source_pixel_percent: (get("PXSRCMSK") as number) ?? null,
      snowballs: (get("NSNOWSRC") as number) ?? null,
      bloomed_sources: (get("NBLMSRCS") as number) ?? null,
      processing: access_url.split("_").pop()!.replace(/\.fits$/, ""),
    },
  };
}

// ---------------------------------------------------------------- co-adds

export interface CoaddOutput {
  image: AlignedImage;
  count: Int16Array; // frames contributing to each output pixel
  framesUsed: string[];
  waveMin: number | null;
  waveMax: number | null;
  clipped: number; // share of input samples rejected as outliers
}

function nanMedian(values: number[]): number {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Deep picture: every exposure of one band (or one of its 17 channels)
 * averaged on the blink view's grid.
 *  - only good pixels go in (`science`), weighted by 1 / frame noise^2;
 *  - outliers (missed cosmic rays, movers) are rejected per pixel beyond
 *    clipSigma x max(frame noise, stack spread, 15 % of the signal), with at
 *    least 3 frames;
 *  - values stay in MJy/sr.
 */
export async function coadd(
  view: { ra: number; dec: number; fov: number },
  band: number,
  channel: number | null,
  size: number,
  signal?: AbortSignal,
  clipSigma = 4,
): Promise<CoaddOutput> {
  const fovDeg = view.fov / 60;
  const frames = (await searchFrames(view.ra, view.dec, false, signal)).filter((f) => f.detector === band);
  if (!frames.length) throw new Error(`No D${band} exposures cover this position`);
  const aligned = await Promise.all(
    frames.map(async (f) => {
      try {
        const cut = await fetchCutout(f, view.ra, view.dec, cutoutSizeDeg(fovDeg), signal);
        return alignCutout(cut, f.detector, view.ra, view.dec, fovDeg, size);
      } catch (err) {
        if (signal?.aborted) throw err;
        return null;
      }
    }),
  );
  const images: AlignedImage[] = [];
  const ids: string[] = [];
  aligned.forEach((im, i) => {
    if (!im || im.coverage < 0.6) return;
    if (channel !== null && channelOf(band, im.wavelength) !== channel) return;
    images.push(im);
    ids.push(frames[i].id);
  });
  if (!images.length) throw new Error("No usable exposures in this band/channel here");

  const n = size * size;
  const noises = images.map((im) => (im.noise && im.noise > 0 ? im.noise : NaN));
  const known = noises.filter(Number.isFinite);
  const fallback = known.length ? Math.max(...known) : 1;
  const noise = noises.map((v) => (Number.isFinite(v) ? v : fallback));
  const weight = noise.map((v) => 1 / (v * v));

  const mean = new Float32Array(n);
  const count = new Int16Array(n);
  let nIn = 0;
  let nKept = 0;
  const col: number[] = [];
  for (let p = 0; p < n; p++) {
    col.length = 0;
    for (const im of images) if (Number.isFinite(im.science[p])) col.push(im.science[p]);
    nIn += col.length;
    let med = NaN;
    let spread = 0;
    if (images.length >= 3 && col.length) {
      med = nanMedian(col);
      spread = 1.4826 * nanMedian(col.map((v) => Math.abs(v - med)));
    }
    let sw = 0;
    let sv = 0;
    let kept = 0;
    images.forEach((im, k) => {
      const v = im.science[p];
      if (!Number.isFinite(v)) return;
      if (Number.isFinite(med)) {
        const scale = Math.max(noise[k], spread, 0.15 * Math.abs(med));
        if (Math.abs(v - med) / scale > clipSigma) return;
      }
      sw += weight[k];
      sv += weight[k] * v;
      kept++;
    });
    nKept += kept;
    count[p] = kept;
    mean[p] = sw > 0 ? sv / sw : NaN;
  }

  const waves = images.map((im) => im.wavelength).filter((w): w is number => w !== null);
  let good = 0;
  let empty = 0;
  for (let p = 0; p < n; p++) Number.isFinite(mean[p]) ? good++ : empty++;
  const image: AlignedImage = {
    data: empty ? fillBadPixels(mean, size, size) : mean,
    size,
    wavelength: waves.length ? r(waves.reduce((a, b) => a + b, 0) / waves.length, 4) : null,
    bandwidth: waves.length > 1 ? r(Math.max(...waves) - Math.min(...waves), 4) : images[0].bandwidth,
    coverage: good / n,
    flaggedFraction: empty / n,
    science: mean,
    filled: Uint8Array.from(mean, (v) => (Number.isFinite(v) ? 0 : 1)),
    noise: 1 / Math.sqrt(weight.reduce((a, b) => a + b, 0)),
  };
  return {
    image,
    count,
    framesUsed: ids,
    waveMin: waves.length ? Math.min(...waves) : null,
    waveMax: waves.length ? Math.max(...waves) : null,
    clipped: 1 - nKept / Math.max(1, nIn),
  };
}

// ---------------------------------------------------------------- FITS output

/** A small FITS file: float32 image + int16 frame-count map, both north-up
 *  TAN grids centred on (ra, dec). */
export function coaddFits(out: CoaddOutput, view: { ra: number; dec: number; fov: number }, band: number, channel: number | null): Blob {
  const size = out.image.size;
  const scale = view.fov / 60 / size;
  const wcs: [string, string | number][] = [
    ["CTYPE1", "RA---TAN"], ["CTYPE2", "DEC--TAN"],
    ["CRVAL1", view.ra], ["CRVAL2", view.dec],
    ["CRPIX1", (size + 1) / 2], ["CRPIX2", (size + 1) / 2],
    ["CDELT1", -scale], ["CDELT2", scale], ["CUNIT1", "deg"], ["CUNIT2", "deg"],
  ];
  const card = (k: string, v: string | number | boolean) => {
    const val = typeof v === "string" ? `'${v.padEnd(8)}'`.padEnd(20) : typeof v === "boolean" ? (v ? "T" : "F").padStart(20) : String(v).padStart(20);
    return `${k.padEnd(8)}= ${val}`.padEnd(80);
  };
  const header = (cards: [string, string | number | boolean][]) => {
    let s = cards.map(([k, v]) => card(k, v)).join("") + "END".padEnd(80);
    while (s.length % 2880) s += " ";
    return new TextEncoder().encode(s);
  };
  const pad = (b: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(b.length / 2880) * 2880);
    out.set(b);
    return out;
  };
  // FITS row 1 is the bottom row; our arrays have row 0 = top.
  const sci = new DataView(new ArrayBuffer(size * size * 4));
  const cnt = new DataView(new ArrayBuffer(size * size * 2));
  for (let row = 0; row < size; row++)
    for (let c = 0; c < size; c++) {
      const src = (size - 1 - row) * size + c;
      sci.setFloat32((row * size + c) * 4, out.image.science[src]);
      cnt.setInt16((row * size + c) * 2, out.count[src]);
    }
  const extra: [string, string | number][] = [["BUNIT", "MJy/sr"], ["NCOMBINE", out.framesUsed.length], ["DETECTOR", band]];
  if (channel) extra.push(["CHANNEL", channel]);
  if (out.waveMin !== null) extra.push(["WAVEMIN", out.waveMin], ["WAVEMAX", out.waveMax!]);
  return new Blob([
    header([["SIMPLE", true], ["BITPIX", -32], ["NAXIS", 2], ["NAXIS1", size], ["NAXIS2", size], ["EXTEND", true], ...wcs, ...extra]),
    pad(new Uint8Array(sci.buffer)),
    header([["XTENSION", "IMAGE"], ["BITPIX", 16], ["NAXIS", 2], ["NAXIS1", size], ["NAXIS2", size], ["PCOUNT", 0], ["GCOUNT", 1], ["EXTNAME", "NFRAMES"], ...wcs]),
    pad(new Uint8Array(cnt.buffer)),
  ], { type: "application/fits" });
}

// ---------------------------------------------------------------- spectra

const FIT_RADIUS = 3; // pixels (~18 arcsec), inside the ePSF table
const MIN_PSF_COVERAGE = 0.7; // share of the PSF that must land on good pixels
const STAMP_DEG = (17 * 6.2) / 3600; // 17 x 17 pixel stamp
const ARCSEC2_TO_SR = (Math.PI / 180 / 3600) ** 2;

interface PsfGrid {
  over: number;
  side: number; // table is side x side
  x: Float32Array; // detector centres of each grid cell (alt WCS 'A')
  y: Float32Array;
  psfs: Float64Array[];
}

// The ePSF grid is a calibration product shared by every exposure of a
// detector, so its 4 MB table is downloaded once per detector and kept.
const psfGrids = new Map<number, Promise<PsfGrid>>();

function parsePsfTable(h: Hdu): PsfGrid {
  const raw = h.raw!;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const rowLen = Number(h.header.NAXIS1);
  const rows = Number(h.header.NAXIS2);
  // column offsets from TFORMn
  const sizes: Record<string, number> = { J: 4, E: 4, D: 8, I: 2, K: 8, B: 1 };
  const cols: Record<string, { off: number; n: number; t: string }> = {};
  let off = 0;
  for (let i = 1; i <= Number(h.header.TFIELDS); i++) {
    const m = String(h.header[`TFORM${i}`]).match(/^(\d*)([A-Z])/)!;
    const n = Number(m[1] || 1);
    cols[String(h.header[`TTYPE${i}`]).trim()] = { off, n, t: m[2] };
    off += n * sizes[m[2]];
  }
  const side = Math.round(Math.sqrt(cols.EPSF.n));
  const x = new Float32Array(rows);
  const y = new Float32Array(rows);
  const psfs: Float64Array[] = [];
  for (let rIdx = 0; rIdx < rows; rIdx++) {
    const base = rIdx * rowLen;
    x[rIdx] = view.getFloat32(base + cols.XCENTER.off);
    y[rIdx] = view.getFloat32(base + cols.YCENTER.off);
    const p = new Float64Array(cols.EPSF.n);
    for (let k = 0; k < p.length; k++) p[k] = view.getFloat64(base + cols.EPSF.off + k * 8);
    psfs.push(p);
  }
  return { over: Number(h.header.OVSMPX ?? 5), side, x, y, psfs };
}

function psfGrid(frame: Frame, ra: number, dec: number, signal?: AbortSignal): Promise<PsfGrid> {
  let job = psfGrids.get(frame.detector);
  if (!job) {
    job = fetchCutout(frame, ra, dec, STAMP_DEG, signal, true).then((c) => {
      if (!c.epsf?.raw) throw new Error("No PSF table in this file");
      return parsePsfTable(c.epsf);
    });
    psfGrids.set(frame.detector, job);
    job.catch(() => psfGrids.delete(frame.detector));
  }
  return job;
}

/** Bilinear sample of the oversampled ePSF at native-pixel offsets, zero outside. */
function samplePsf(psf: Float64Array, side: number, over: number, ox: number, oy: number): number {
  const c = (side - 1) / 2;
  const x = c + over * ox;
  const y = c + over * oy;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= side || j >= side ? 0 : psf[j * side + i]);
  return (1 - ty) * ((1 - tx) * at(x0, y0) + tx * at(x0 + 1, y0)) + ty * ((1 - tx) * at(x0, y0 + 1) + tx * at(x0 + 1, y0 + 1));
}

export interface SpectrumPoint {
  id: string;
  detector: number;
  mjd: number;
  date: string;
  ok: boolean;
  reason?: string;
  wavelength: number | null;
  bandwidth?: number | null;
  flux_ujy?: number;
  flux_err_ujy?: number;
  chi2_dof?: number;
  flags_at_target?: string[];
  channel?: number | null;
  channel_index?: number | null;
}

/** Forced PSF photometry of (ra, dec) in one stamp: model = F * PSF + B over
 *  pixels within FIT_RADIUS, weighted by 1 / VARIANCE, bad pixels left out. */
export function measure(cut: Cutout, grid: PsfGrid, detector: number, ra: number, dec: number) {
  const { image, flags, variance, zodi } = cut;
  const h = image.header;
  const wcs = new SipWcs(h);
  const [px, py] = wcs.worldToPix(ra, dec);
  const lx = px - 1; // 0-based
  const ly = py - 1;
  const { nx, ny } = image;
  const { wavelength, bandwidth } = wavelengthAt(image, detector, px, py);
  if (!variance || !flags) return { ok: false, reason: "file has no variance or flags", wavelength };

  // which PSF of the grid: nearest centre in detector coordinates (alt WCS 'A')
  const dxA = px - Number(h.CRPIX1A ?? 0) + Number(h.CRVAL1A ?? 0);
  const dyA = py - Number(h.CRPIX2A ?? 0) + Number(h.CRVAL2A ?? 0);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < grid.x.length; i++) {
    const d = (grid.x[i] - dxA) ** 2 + (grid.y[i] - dyA) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  }
  const psf = grid.psfs[best];
  // normalise over the full footprint at the same sub-pixel phase
  const phx = -lx - Math.round(-lx);
  const phy = -ly - Math.round(-ly);
  const reach = Math.ceil((grid.side - 1) / 2 / grid.over);
  let total = 0;
  for (let gy = -reach; gy <= reach; gy++)
    for (let gx = -reach; gx <= reach; gx++) total += samplePsf(psf, grid.side, grid.over, gx + phx, gy + phy);
  if (!(total > 0)) total = 1;

  const fv = flagValues(flags);
  const mask = badBitmask(flags.header);
  let sumRegion = 0;
  let sumUse = 0;
  let nBadInFit = 0;
  const P: number[] = [];
  const D: number[] = [];
  const W: number[] = [];
  let inRegion = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const dx = i - lx;
      const dy = j - ly;
      if (dx * dx + dy * dy > FIT_RADIUS * FIT_RADIUS) continue;
      inRegion++;
      const k = j * nx + i;
      const p = samplePsf(psf, grid.side, grid.over, dx, dy) / total;
      sumRegion += p;
      const d = image.data[k] - (zodi ? zodi.data[k] : 0);
      const v = variance.data[k];
      if ((fv[k] & mask) !== 0 || !Number.isFinite(d) || !(v > 0)) {
        nBadInFit++;
        continue;
      }
      sumUse += p;
      P.push(p);
      D.push(d);
      W.push(1 / v);
    }
  if (!inRegion) return { ok: false, reason: "position is off this exposure", wavelength };

  const ci = Math.round(ly);
  const cj = Math.round(lx);
  const centreFlags = ci >= 0 && ci < ny && cj >= 0 && cj < nx ? namesIn(fv[ci * nx + cj], flags.header) : [];
  const coverage = sumUse / Math.max(sumRegion, 1e-12);
  const base = { wavelength, bandwidth, flags_at_target: centreFlags, bad_pixels_in_fit: nBadInFit, psf_coverage: r(coverage, 3) };
  if (P.length < 6 || coverage < MIN_PSF_COVERAGE) {
    const saturated = centreFlags.some((f) => ["OVERFLOW", "BLOOM", "NONLINEAR"].includes(f));
    return { ...base, ok: false, reason: saturated ? "saturated: too bright for SPHEREx" : "too many flagged pixels on the source" };
  }

  // weighted linear least squares for [F, B]
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  for (let k = 0; k < P.length; k++) {
    a00 += W[k] * P[k] * P[k];
    a01 += W[k] * P[k];
    a11 += W[k];
    b0 += W[k] * P[k] * D[k];
    b1 += W[k] * D[k];
  }
  const det = a00 * a11 - a01 * a01;
  if (!det) return { ...base, ok: false, reason: "fit failed" };
  const c00 = a11 / det;
  const flux = (a11 * b0 - a01 * b1) / det;
  const background = (a00 * b1 - a01 * b0) / det;
  let chi = 0;
  for (let k = 0; k < P.length; k++) chi += W[k] * (D[k] - flux * P[k] - background) ** 2;
  const chi2 = chi / Math.max(1, P.length - 2);

  // pixel solid angle from OMEGA_MEDIAN (arcsec^2); MJy/sr * sr -> uJy
  const omega = Number(h.OMEGA_MEDIAN ?? 0) || 6.2 * 6.2;
  const toUjy = omega * ARCSEC2_TO_SR * 1e12;
  const channel = channelOf(detector, wavelength);
  return {
    ...base,
    ok: Number.isFinite(flux),
    flux_ujy: r(flux * toUjy, 3),
    flux_err_ujy: r(Math.sqrt(c00) * toUjy, 3),
    background_mjy_sr: r(background, 5),
    chi2_dof: r(chi2, 2),
    channel,
    channel_index: channel ? globalIndex(detector, channel) : null,
  };
}

/** Inverse-variance mean of good points in each of the 102 channels. Scatter
 *  beyond the error bars (variability, neighbours, movers) widens the error. */
export function binByChannel(points: SpectrumPoint[]) {
  const groups = new Map<number, SpectrumPoint[]>();
  for (const p of points)
    if (p.ok && p.channel_index != null && (p.flux_err_ujy ?? 0) > 0)
      groups.set(p.channel_index, [...(groups.get(p.channel_index) ?? []), p]);
  const channels = new Map(allChannels().map((c) => [c.index, c]));
  return [...groups.keys()].sort((a, b) => a - b).map((idx) => {
    const pts = groups.get(idx)!;
    const w = pts.map((p) => 1 / p.flux_err_ujy! ** 2);
    const sw = w.reduce((a, b) => a + b, 0);
    const mean = pts.reduce((a, p, i) => a + w[i] * p.flux_ujy!, 0) / sw;
    let err = 1 / Math.sqrt(sw);
    if (pts.length > 1) {
      const chi2 = pts.reduce((a, p, i) => a + w[i] * (p.flux_ujy! - mean) ** 2, 0) / (pts.length - 1);
      err *= Math.max(1, Math.sqrt(chi2));
    }
    const ch = channels.get(idx)!;
    return {
      index: idx, band: ch.band, channel: ch.channel,
      wave_center: ch.wave_center, wave_min: ch.wave_min, wave_max: ch.wave_max,
      wavelength: r(pts.reduce((a, p) => a + p.wavelength!, 0) / pts.length, 4),
      flux_ujy: r(mean, 3), flux_err_ujy: r(err, 3), n: pts.length,
    };
  });
}

/** Forced photometry of (ra, dec) in each of `frames`. `onDone` counts finished exposures. */
export function measureFrames(frames: Frame[], ra: number, dec: number, signal?: AbortSignal, onDone?: () => void) {
  return Promise.all(
    frames.map(async (f): Promise<SpectrumPoint> => {
      const info = { id: f.id, detector: f.detector, mjd: f.mjd, date: f.date };
      try {
        const [grid, cut] = await Promise.all([psfGrid(f, ra, dec, signal), fetchCutout(f, ra, dec, STAMP_DEG, signal)]);
        return { ...measure(cut, grid, f.detector, ra, dec), ...info } as SpectrumPoint;
      } catch (err) {
        if (signal?.aborted) throw err;
        return { ok: false, reason: `could not read: ${err}`.slice(0, 200), wavelength: null, ...info };
      } finally {
        onDone?.();
      }
    }),
  );
}

const spectra = new Map<string, Promise<unknown>>();

/** Spectrum at a sky position: forced PSF photometry in every exposure. */
export function spectrum(ra: number, dec: number, signal?: AbortSignal) {
  const key = `${ra.toFixed(6)},${dec.toFixed(6)}`;
  const cached = spectra.get(key);
  if (cached) return cached as ReturnType<typeof run>;
  const run = async () => {
    const frames = await searchFrames(ra, dec, false, signal);
    const points = await measureFrames(frames, ra, dec, signal);
    points.sort((a, b) => (a.wavelength ?? 99) - (b.wavelength ?? 99) || a.mjd - b.mjd);
    return {
      ra, dec, band: null, unit: "uJy",
      method: "forced PSF photometry (mission ePSF), local background fitted, flagged pixels excluded, zodiacal light model subtracted",
      measured: points.filter((p) => p.ok).length,
      total: points.length,
      points,
      channels: binByChannel(points),
    };
  };
  const job = run();
  spectra.set(key, job);
  job.catch(() => spectra.delete(key));
  return job;
}
