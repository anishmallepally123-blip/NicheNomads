// URL state: the address bar is the single source of truth for what is shown,
// so any view can be shared or embedded with a link such as
//   /?ra=133.795129&dec=-7.245147&fov=10&band=6&embed=1
import { useCallback, useEffect, useState } from "react";

export interface ViewState {
  ra: number;
  dec: number;
  fov: number; // arcmin
  band: number; // detector 1..6
  embed: boolean; // hide page chrome, for iframes
}

// WISE 0855-0714, the challenge's headline test target
export const DEFAULT_STATE: ViewState = {
  ra: 133.795129,
  dec: -7.245147,
  fov: 10,
  band: 6,
  embed: false,
};

export const FOV_CHOICES = [5, 10, 20, 40];

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function parseUrl(search: string): ViewState {
  const p = new URLSearchParams(search);
  const num = (key: string, fallback: number) => {
    const raw = p.get(key);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    ra: ((num("ra", DEFAULT_STATE.ra) % 360) + 360) % 360,
    dec: clamp(num("dec", DEFAULT_STATE.dec), -90, 90),
    fov: clamp(num("fov", DEFAULT_STATE.fov), 1, 60),
    band: clamp(Math.round(num("band", DEFAULT_STATE.band)), 1, 6),
    embed: p.get("embed") === "1",
  };
}

export function toUrl(s: ViewState): string {
  const p = new URLSearchParams();
  p.set("ra", s.ra.toFixed(6));
  p.set("dec", s.dec.toFixed(6));
  p.set("fov", String(s.fov));
  p.set("band", String(s.band));
  if (s.embed) p.set("embed", "1");
  return `${window.location.pathname}?${p.toString()}`;
}

export function useUrlState(): [ViewState, (patch: Partial<ViewState>) => void] {
  const [state, setState] = useState<ViewState>(() => parseUrl(window.location.search));

  useEffect(() => {
    const onPop = () => setState(parseUrl(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const update = useCallback((patch: Partial<ViewState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      window.history.pushState(null, "", toUrl(next));
      return next;
    });
  }, []);

  // Make sure a bare "/" also ends up with a shareable address.
  useEffect(() => {
    window.history.replaceState(null, "", toUrl(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [state, update];
}
