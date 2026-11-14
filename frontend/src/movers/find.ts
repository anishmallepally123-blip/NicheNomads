// Mover finder: looks for dots that shift between SPHEREx visits.
//
// SPHEREx sees a patch of sky in short visits (a few exposures over a few
// days), months apart. Single exposures are noisy and each one is at a
// different wavelength, so a dot's brightness can change a lot from visit to
// visit. Plain subtraction of one picture from the next therefore lights up
// every star that changed colour, not just the ones that moved. Instead we:
//   1. group the frames into visits (or equal time slices if the patch is
//      seen all the time, like near the ecliptic poles),
//   2. take the median of each visit, which keeps the stars and drops noise,
//   3. find every dot in each visit and measure its centre to a fraction of
//      a pixel,
//   4. match each dot to the nearest one in the next visit, take out the
//      small shift that all stars share (the visits are never lined up
//      perfectly), and follow each dot across the visits,
//   5. keep dots that move in a straight line, by much more than the usual
//      wobble of the other stars.
// Brightness changes don't move a dot's centre, so they don't fool this.
// All of it runs in the browser on the frames already loaded.
import type { LoadedFrame } from "../api/client";
import { offsetToSky } from "../lib/sky";
import { combine, type Pixels } from "../viewer/imageOps";
import { pixelsOf } from "../viewer/useImageOps";

export interface MoverStep {
  pair: number; // which visit-to-visit difference it came from
  fromX: number; // image pixels
  fromY: number;
  x: number;
  y: number;
  fromDate: string;
  toDate: string;
  days: number;
  snr: number;
}

export interface MoverCandidate {
  id: number;
  x: number; // latest position, image pixels
  y: number;
  fromX: number; // earliest position
  fromY: number;
  ra: number; // latest position on the sky
  dec: number;
  shiftArcsec: number; // total, first to last
  eastArcsec: number;
  northArcsec: number;
  ratePerYear: number; // arcsec / year
  direction: string; // compass word for the motion
  days: number;
  snr: number;
  bright: boolean; // probably a saturated or very bright star
  steps: MoverStep[];
}

export interface MoverResult {
  candidates: MoverCandidate[];
  visits: { from: string; to: string; frames: number }[];
  size: number;
  arcsecPerPx: number;
  note: string | null; // why nothing could be done, if so
}

const VISIT_GAP_DAYS = 10;
const MIN_PER_VISIT = 2;
const MAX_VISITS = 6;
const EDGE = 8; // ignore dots this close to the edge
const DETECT_SIGMA = 4.5;
const MATCH_PX = 6; // furthest a dot may move between neighbouring visits
const MIN_SHIFT_PX = 1.5;
const RING_PX = 9; // ring around each dot used to measure the local background
const GLARE_SIGMA = 3;
const MIN_SIGNIFICANCE = 5;
const POSITION_NOISE_ARCSEC = 3; // centre uncertainty of a dot at signal-to-noise 1, roughly PSF width / 2
const POSITION_FLOOR_ARCSEC = 0.55; // wobble even bright stars show between visits
const MAX_CANDIDATES = 10;

function median(values: ArrayLike<number>): number {
  const a = Float32Array.from(values).sort();
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Robust centre and spread of the valid pixels. */
function stats(p: Pixels): { mid: number; sigma: number } {
  const step = Math.max(1, Math.floor(p.value.length / 40000));
  const vals: number[] = [];
  for (let i = 0; i < p.value.length; i += step) if (p.valid[i]) vals.push(p.value[i]);
  const mid = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - mid)));
  return { mid, sigma: Math.max(1e-6, 1.4826 * mad) };
}

/** Split time-ordered frames into visits; fall back to equal time slices. */
function groupVisits(frames: LoadedFrame[]): LoadedFrame[][] {
  let groups: LoadedFrame[][] = [];
  for (const f of frames) {
    const last = groups[groups.length - 1];
    if (last && f.mjd - last[last.length - 1].mjd < VISIT_GAP_DAYS) last.push(f);
    else groups.push([f]);
  }
  groups = groups.filter((g) => g.length >= MIN_PER_VISIT);
  if (groups.length >= 2 && groups.length <= MAX_VISITS) return groups;

  // Seen continuously (or in very many short visits): cut the time span into slices.
  const slices = Math.min(MAX_VISITS, Math.max(2, Math.floor(frames.length / 4)));
  const t0 = frames[0].mjd;
  const span = frames[frames.length - 1].mjd - t0 || 1;
  const out: LoadedFrame[][] = Array.from({ length: slices }, () => []);
  for (const f of frames) out[Math.min(slices - 1, Math.floor(((f.mjd - t0) / span) * slices))].push(f);
  return out.filter((g) => g.length >= MIN_PER_VISIT);
}

interface Dot {
  x: number;
  y: number;
  snr: number;
  next?: Dot; // the same dot in the following visit
  prev?: Dot;
}

/** Local peaks above the threshold, with intensity-weighted centres. */
function findDots(p: Pixels, mid: number, sigma: number): Dot[] {
  const { width: w, height: h, value, valid } = p;
  const out: Dot[] = [];
  const t = DETECT_SIGMA * sigma;
  for (let y = EDGE; y < h - EDGE; y++) {
    for (let x = EDGE; x < w - EDGE; x++) {
      const i = y * w + x;
      const v = value[i] - mid;
      if (v < t || !valid[i]) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if ((dx || dy) && value[i + dy * w + dx] - mid > v) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      // Skip dots sitting in the glare of a very bright star: the glare
      // changes with wavelength and drags their centres around.
      const ring: number[] = [];
      for (let a = 0; a < 16; a++) {
        const rx = Math.round(x + RING_PX * Math.cos((a * Math.PI) / 8));
        const ry = Math.round(y + RING_PX * Math.sin((a * Math.PI) / 8));
        if (rx >= 0 && ry >= 0 && rx < w && ry < h && valid[ry * w + rx]) ring.push(value[ry * w + rx]);
      }
      if (ring.length < 8 || median(ring) - mid > GLARE_SIGMA * sigma) continue;
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const q = Math.max(0, value[i + dy * w + dx] - mid - 0.25 * v); // core only, so neighbours pull less
          sw += q;
          sx += q * dx;
          sy += q * dy;
        }
      }
      out.push({ x: x + sx / sw, y: y + sy / sw, snr: v / sigma });
    }
  }
  return out;
}

/** Pair each dot with its nearest neighbour in the next visit (both ways). */
function link(a: Dot[], b: Dot[], shift: { dx: number; dy: number }) {
  const nearest = (d: Dot, list: Dot[], sx: number, sy: number) => {
    let best: Dot | null = null;
    let bestDist = MATCH_PX;
    for (const o of list) {
      const dist = Math.hypot(o.x - d.x - sx, o.y - d.y - sy);
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    return best;
  };
  for (const d of a) {
    const o = nearest(d, b, shift.dx, shift.dy);
    if (o && nearest(o, a, -shift.dx, -shift.dy) === d) {
      d.next = o;
      o.prev = d;
    }
  }
}

const dateOf = (g: LoadedFrame[]) => g[Math.floor(g.length / 2)].date.slice(0, 10);
const mjdOf = (g: LoadedFrame[]) => g.reduce((s, f) => s + f.mjd, 0) / g.length;

function compass(east: number, north: number): string {
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const angle = (Math.atan2(east, north) * 180) / Math.PI; // 0 = north, 90 = east
  return names[Math.round(((angle + 360) % 360) / 45) % 8];
}

export function findMovers(frames: LoadedFrame[], view: { ra: number; dec: number; fov: number }): MoverResult {
  const empty = (note: string): MoverResult => ({ candidates: [], visits: [], size: 0, arcsecPerPx: 0, note });
  if (frames.length < 4) return empty("Need at least 4 loaded frames. Wait for more to arrive.");
  const visits = groupVisits(frames);
  if (visits.length < 2) return empty("All the frames were taken at about the same time, so nothing has had time to move.");

  const stacks = visits.map((g) => combine(g.map(pixelsOf), "median"));
  if (stacks.some((s) => !s)) return empty("The frames have different sizes. Reload the view and try again.");
  const S = stacks as Pixels[];
  const w = S[0].width;
  const arcsecPerPx = (view.fov * 60) / w;
  const st = S.map(stats);
  const dots = S.map((s, k) => findDots(s, st[k].mid, st[k].sigma));
  const times = visits.map(mjdOf);

  // Match visit to visit. First a rough match to measure the shift that all
  // stars share, then the real match with that shift taken out.
  const offsets: { dx: number; dy: number }[] = [{ dx: 0, dy: 0 }];
  for (let k = 0; k + 1 < S.length; k++) {
    link(dots[k], dots[k + 1], { dx: 0, dy: 0 });
    const pairs = dots[k].filter((d) => d.next);
    const shift = pairs.length >= 3
      ? { dx: median(pairs.map((d) => d.next!.x - d.x)), dy: median(pairs.map((d) => d.next!.y - d.y)) }
      : { dx: 0, dy: 0 };
    for (const d of dots[k]) d.next = undefined;
    for (const d of dots[k + 1]) d.prev = undefined;
    link(dots[k], dots[k + 1], shift);
    const prev = offsets[k];
    offsets.push({ dx: prev.dx + shift.dx, dy: prev.dy + shift.dy });
  }

  // Follow each dot from the first visit it appears in, in the common frame
  // of the first visit (shared shifts removed), and fit a straight line.
  interface Track {
    pts: { k: number; x: number; y: number; snr: number }[];
    vx: number; // px per day
    vy: number;
    rms: number;
  }
  const tracks: Track[] = [];
  for (let k = 0; k < S.length; k++) {
    for (const start of dots[k]) {
      if (start.prev) continue;
      const pts: Track["pts"] = [];
      let kk = k;
      for (let d: Dot | undefined = start; d; d = d.next, kk++) {
        pts.push({ k: kk, x: d.x - offsets[kk].dx, y: d.y - offsets[kk].dy, snr: d.snr });
      }
      const needed = S.length >= 3 ? 3 : 2;
      if (pts.length < needed) continue;
      const ts = pts.map((p) => times[p.k]);
      const tm = ts.reduce((a, b) => a + b, 0) / ts.length;
      const xm = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const ym = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      let stt = 0;
      let stx = 0;
      let sty = 0;
      pts.forEach((p, i) => {
        const dt = ts[i] - tm;
        stt += dt * dt;
        stx += dt * (p.x - xm);
        sty += dt * (p.y - ym);
      });
      const vx = stt ? stx / stt : 0;
      const vy = stt ? sty / stt : 0;
      const rms = Math.sqrt(
        pts.reduce((a, p, i) => a + (p.x - xm - vx * (ts[i] - tm)) ** 2 + (p.y - ym - vy * (ts[i] - tm)) ** 2, 0) / pts.length,
      );
      tracks.push({ pts, vx, vy, rms });
    }
  }
  if (!tracks.length) {
    return { candidates: [], visits: summary(visits), size: w, arcsecPerPx, note: null };
  }

  // How far could an ordinary star seem to move by chance? Centres of faint
  // dots are less certain, and even bright ones wobble a little because the
  // picture's sharpness changes with wavelength. A candidate has to move
  // well beyond that.
  const chanceShiftArcsec = (snr: number) => Math.SQRT2 * Math.hypot(POSITION_NOISE_ARCSEC / snr, POSITION_FLOOR_ARCSEC);

  const c = (w - 1) / 2;
  const candidates: MoverCandidate[] = [];
  for (const t of tracks) {
    const first = t.pts[0];
    const last = t.pts[t.pts.length - 1];
    const days = times[last.k] - times[first.k];
    const speed = Math.hypot(t.vx, t.vy);
    const shiftPx = speed * days;
    const snr = median(t.pts.map((p) => p.snr));
    const significance = (shiftPx * arcsecPerPx) / chanceShiftArcsec(snr);
    if (shiftPx < MIN_SHIFT_PX || significance < MIN_SIGNIFICANCE) continue;
    if (t.rms > Math.max(0.6, 0.35 * shiftPx)) continue; // wobbles about instead of moving steadily
    const east = -t.vx * days * arcsecPerPx;
    const north = -t.vy * days * arcsecPerPx;
    // Back into the picture's pixel frame (the latest visit's shift added).
    const lx = last.x + offsets[last.k].dx;
    const ly = last.y + offsets[last.k].dy;
    const sky = offsetToSky(view.ra, view.dec, -(lx - c) * arcsecPerPx, (c - ly) * arcsecPerPx);
    candidates.push({
      id: 0,
      x: lx,
      y: ly,
      fromX: lx - t.vx * days,
      fromY: ly - t.vy * days,
      ra: sky.ra,
      dec: sky.dec,
      shiftArcsec: shiftPx * arcsecPerPx,
      eastArcsec: east,
      northArcsec: north,
      ratePerYear: speed * 365.25 * arcsecPerPx,
      direction: compass(east, north),
      days,
      snr: significance,
      bright: Math.max(...t.pts.map((p) => p.snr)) > 400,
      steps: t.pts.slice(1).map((p, i) => ({
        pair: p.k - 1,
        fromX: t.pts[i].x + offsets[t.pts[i].k].dx,
        fromY: t.pts[i].y + offsets[t.pts[i].k].dy,
        x: p.x + offsets[p.k].dx,
        y: p.y + offsets[p.k].dy,
        fromDate: dateOf(visits[t.pts[i].k]),
        toDate: dateOf(visits[p.k]),
        days: times[p.k] - times[t.pts[i].k],
        snr: p.snr,
      })),
    });
  }

  candidates.sort((a, b) => b.snr - a.snr);
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES).map((m, i) => ({ ...m, id: i + 1 })),
    visits: summary(visits),
    size: w,
    arcsecPerPx,
    note: null,
  };
}

function summary(visits: LoadedFrame[][]) {
  return visits.map((g) => ({ from: g[0].date.slice(0, 10), to: g[g.length - 1].date.slice(0, 10), frames: g.length }));
}
