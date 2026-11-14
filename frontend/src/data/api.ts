// Backend calls for the data panel: co-adds, spectra, metadata and flags.
import type { FrameInfo, View } from "../api/client";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface FlagCount {
  bit: number;
  name: string;
  description: string;
  pixels: number;
  fraction: number;
  bad: boolean;
}

export interface FrameMeta {
  frame: FrameInfo;
  wavelength: number | null;
  bandwidth: number | null;
  channel: number | null;
  channel_index: number | null;
  target_pixel: { flags: string[]; bad: boolean | null; zodi_mjy_sr: number | null; noise_mjy_sr: number | null };
  flags: FlagCount[];
  bad_fraction: number;
  header: {
    date_obs: string | null;
    exposure_s: number | null;
    l1_quality: string | null;
    fine_astrometry_ok: boolean | null;
    astrometry_stars: number | null;
    source_pixel_percent: number | null;
    snowballs: number | null;
    bloomed_sources: number | null;
    processing: string;
  };
}

export interface SpectrumPoint {
  id: string;
  detector: number;
  mjd: number;
  date: string;
  ok: boolean;
  reason?: string;
  wavelength: number | null;
  flux_ujy?: number;
  flux_err_ujy?: number;
  chi2_dof?: number;
  flags_at_target?: string[];
}

export interface SpectrumChannel {
  index: number;
  band: number;
  channel: number;
  wavelength: number;
  wave_min: number;
  wave_max: number;
  flux_ujy: number;
  flux_err_ujy: number;
  n: number;
}

export interface Spectrum {
  ra: number;
  dec: number;
  measured: number;
  total: number;
  method: string;
  points: SpectrumPoint[];
  channels: SpectrumChannel[];
}

export interface CoaddResult {
  url: string; // object URL of the PNG
  framesUsed: number;
  waveMin: number | null;
  waveMax: number | null;
  clipped: number;
  fitsUrl: string;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, { signal });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return res.json();
}

export const fetchFrameMeta = (id: string, view: View, signal?: AbortSignal) =>
  getJson<FrameMeta>(
    `/api/frames/${encodeURIComponent(id)}/meta?ra=${view.ra}&dec=${view.dec}&fov=${view.fov}`,
    signal,
  );

export const fetchSpectrum = (ra: number, dec: number, signal?: AbortSignal) =>
  getJson<Spectrum>(`/api/spectrum?ra=${ra}&dec=${dec}`, signal);

export async function fetchCoadd(
  view: View,
  band: number,
  channel: number | null,
  size: number,
  signal?: AbortSignal,
): Promise<CoaddResult> {
  const query =
    `/api/coadd?ra=${view.ra}&dec=${view.dec}&fov=${view.fov}&band=${band}&size=${size}` +
    (channel ? `&channel=${channel}` : "");
  const res = await fetch(BASE + query, { signal });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  const num = (name: string) => {
    const v = res.headers.get(name);
    return v ? Number(v) : null;
  };
  return {
    url: URL.createObjectURL(await res.blob()),
    framesUsed: num("X-Frames-Used") ?? 0,
    waveMin: num("X-Wave-Min-Um"),
    waveMax: num("X-Wave-Max-Um"),
    clipped: num("X-Clipped-Fraction") ?? 0,
    fitsUrl: BASE + query + "&format=fits",
  };
}
