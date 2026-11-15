// URL state: the address bar is the single source of truth for what is shown,
// so any view can be shared, bookmarked or embedded with a link such as
//   /?ra=133.795129&dec=-7.245147&fov=10&band=6&frame=<obs_id>&op=diff&ref=median&embed=1
//
// Parameters (all optional, anything missing or invalid falls back to a default):
//   ra, dec     view centre, degrees (ICRS). `ra` also accepts hours as "8h55m10.8s".
//   fov         field of view, arcmin (1 to 60)
//   band        SPHEREx detector 1..6
//   frame       obs_id of the frame to show (the player starts paused on it)
//   fps         playback speed, 1..15
//   play        0 = start paused
//   zoom        on-screen zoom of the loaded picture (0.5..12)
//   op, ref, n, gain   image arithmetic, see ImageOp below
//   invert, marker     display toggles (1/0)
//   embed       1 = bare viewer for iframes
//   controls    0 = in embed mode also hide the player bar
import { useCallback, useEffect, useRef, useState } from "react";

/** none = plain blink; diff = frame minus a reference; sum = average of N frames */
export type ImageOp = "none" | "diff" | "sum";
/** What a difference is taken against: previous/first frame, the median or mean of
 *  all frames (static stars cancel, movers stay), or one pinned frame by obs_id. */
export type DiffRef = "prev" | "first" | "median" | "mean" | string;
/** Which part of each SPHEREx exposure file is drawn: the sky (background
 *  removed), the zodiacal-light background model, the noise map, or the
 *  problem-pixel map. */
export type Plane = "sky" | "zodi" | "noise" | "flags";
export const PLANES: Plane[] = ["sky", "zodi", "noise", "flags"];

export interface ViewState {
  ra: number;
  dec: number;
  fov: number; // arcmin
  band: number; // detector 1..6
  frame: string | null; // obs_id
  fps: number;
  play: boolean;
  zoom: number;
  op: ImageOp;
  plane: Plane;
  ref: DiffRef;
  n: number; // frames per stack for op=sum
  gain: number; // contrast multiplier for op=diff
  invert: boolean;
  marker: boolean;
  embed: boolean;
  controls: boolean; // player bar visible in embed mode
}

// WISE 0855-0714, the challenge's headline test target
export const DEFAULT_STATE: ViewState = {
  ra: 133.795129,
  dec: -7.245147,
  fov: 10,
  band: 6,
  frame: null,
  fps: 4,
  play: true,
  zoom: 1,
  op: "none",
  plane: "sky",
  ref: "median",
  n: 4,
  gain: 3,
  invert: false,
  marker: true,
  embed: false,
  controls: true,
};

export const FOV_MIN = 1;
export const FOV_MAX = 60;
export const FOV_CHOICES = [2, 5, 10, 20, 40, 60];
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 12;

/** Parameters that move you to a different patch of sky get their own history
 *  entry (so Back works like in a map); everything else replaces the entry. */
const NAVIGATION_KEYS: (keyof ViewState)[] = ["ra", "dec", "fov", "band"];

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** "8h55m10.8s" or "8 55 10.8" (hours) or plain degrees. */
function parseRa(raw: string | null): number {
  if (raw === null || raw.trim() === "") return NaN;
  const plain = Number(raw);
  if (Number.isFinite(plain)) return plain;
  const parts = raw.trim().split(/[hms:\s]+/).filter(Boolean).map(Number);
  if (parts.length === 0 || parts.some((x) => !Number.isFinite(x))) return NaN;
  const [h, m = 0, s = 0] = parts;
  return (h + m / 60 + s / 3600) * 15;
}

/** "-7d14m42.5s" or "-7 14 42.5" or plain degrees. */
function parseDec(raw: string | null): number {
  if (raw === null || raw.trim() === "") return NaN;
  const plain = Number(raw);
  if (Number.isFinite(plain)) return plain;
  const t = raw.trim();
  const sign = t.startsWith("-") ? -1 : 1;
  const parts = t.replace(/^[+-]/, "").split(/[d°m′'s″"\s:]+/).filter(Boolean).map(Number);
  if (parts.length === 0 || parts.some((x) => !Number.isFinite(x))) return NaN;
  const [d, m = 0, s = 0] = parts;
  return sign * (d + m / 60 + s / 3600);
}

export function parseUrl(search: string): ViewState {
  const p = new URLSearchParams(search);
  const D = DEFAULT_STATE;
  const num = (key: string, fallback: number) => {
    const raw = p.get(key);
    const v = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  const flag = (key: string, fallback: boolean) => {
    const raw = p.get(key);
    if (raw === null) return fallback;
    return !["0", "false", "no", "off"].includes(raw.toLowerCase());
  };
  let ra = parseRa(p.get("ra"));
  let dec = parseDec(p.get("dec"));
  // A broken position in a shared link falls back to the default view as a whole,
  // so we never mix the default RA with someone else's Dec.
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90) {
    ra = D.ra;
    dec = D.dec;
  }
  const op = p.get("op");
  const ref = p.get("ref");
  return {
    ra: Number.isFinite(ra) ? ((ra % 360) + 360) % 360 : D.ra,
    dec: Number.isFinite(dec) ? clamp(dec, -90, 90) : D.dec,
    fov: clamp(num("fov", D.fov), FOV_MIN, FOV_MAX),
    band: clamp(Math.round(num("band", D.band)), 1, 6),
    frame: p.get("frame") || null,
    fps: clamp(Math.round(num("fps", D.fps)), 1, 15),
    play: flag("play", D.play) && !p.get("frame"),
    zoom: clamp(num("zoom", D.zoom), ZOOM_MIN, ZOOM_MAX),
    op: op === "diff" || op === "sum" ? op : "none",
    plane: (PLANES as string[]).includes(p.get("plane") ?? "") ? (p.get("plane") as Plane) : D.plane,
    ref: ref && /^[\w.:-]{1,80}$/.test(ref) ? ref : D.ref,
    n: clamp(Math.round(num("n", D.n)), 2, 20),
    gain: clamp(num("gain", D.gain), 0.5, 20),
    invert: flag("invert", D.invert),
    marker: flag("marker", D.marker),
    embed: flag("embed", D.embed),
    controls: flag("controls", D.controls),
  };
}

const round = (v: number, digits: number) => String(+v.toFixed(digits));

/** Query string for a state. Only values that differ from the defaults are written,
 *  except the position, which is always there so links stay readable. */
export function toQuery(s: ViewState, overrides: Partial<ViewState> = {}): string {
  const v = { ...s, ...overrides };
  const D = DEFAULT_STATE;
  const p = new URLSearchParams();
  p.set("ra", v.ra.toFixed(6));
  p.set("dec", v.dec.toFixed(6));
  p.set("fov", round(v.fov, 3));
  p.set("band", String(v.band));
  if (v.frame && !v.play) p.set("frame", v.frame);
  if (v.fps !== D.fps) p.set("fps", String(v.fps));
  if (!v.play && !v.frame) p.set("play", "0");
  if (Math.abs(v.zoom - 1) > 0.01) p.set("zoom", round(v.zoom, 2));
  if (v.op !== "none") {
    p.set("op", v.op);
    if (v.op === "diff") {
      p.set("ref", v.ref);
      if (v.gain !== D.gain) p.set("gain", round(v.gain, 1));
    } else p.set("n", String(v.n));
  }
  if (v.plane !== D.plane) p.set("plane", v.plane);
  if (v.invert) p.set("invert", "1");
  if (!v.marker) p.set("marker", "0");
  if (v.embed) {
    p.set("embed", "1");
    if (!v.controls) p.set("controls", "0");
  }
  return p.toString();
}

export function toUrl(s: ViewState, overrides: Partial<ViewState> = {}): string {
  return `${window.location.pathname}?${toQuery(s, overrides)}`;
}

/** Absolute link to a state, e.g. for "copy link" or the embed snippet. */
export function absoluteUrl(s: ViewState, overrides: Partial<ViewState> = {}): string {
  return `${window.location.origin}${toUrl(s, overrides)}`;
}

export type UpdateFn = (patch: Partial<ViewState>) => void;

export function useUrlState(): [ViewState, UpdateFn] {
  const [state, setState] = useState<ViewState>(() => parseUrl(window.location.search));
  const pendingPush = useRef(false);

  useEffect(() => {
    const onPop = () => setState(parseUrl(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const update = useCallback<UpdateFn>((patch) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      if (NAVIGATION_KEYS.some((k) => patch[k] !== undefined && patch[k] !== prev[k])) {
        // A new place: forget the frame and on-screen zoom that belonged to the old one.
        if (patch.frame === undefined) next.frame = null;
        if (patch.zoom === undefined) next.zoom = 1;
        pendingPush.current = true;
      }
      return next;
    });
  }, []);

  // Write the address bar after each change. Navigation pushes a history entry
  // right away. Everything else (frame, zoom, speed...) is folded into the current
  // entry after a short pause, because browsers limit how often the URL may change.
  useEffect(() => {
    const url = toUrl(state);
    const sameAsBar = url === window.location.pathname + window.location.search;
    if (pendingPush.current) {
      pendingPush.current = false;
      // Inside an iframe, never add entries to the host page's Back button.
      if (!sameAsBar) {
        if (state.embed) window.history.replaceState(null, "", url);
        else window.history.pushState(null, "", url);
      }
      return;
    }
    if (sameAsBar) return;
    const timer = window.setTimeout(() => window.history.replaceState(null, "", url), 400);
    return () => window.clearTimeout(timer);
  }, [state]);

  return [state, update];
}
