// Data panel calls: co-adds, spectra, metadata and flags. All computed in the
// browser (see science.ts).
import type { FrameInfo, View } from "../api/client";
import { toImageData } from "./align";
import { coadd, coaddFits, frameMeta, spectrum } from "./science";

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

export const fetchFrameMeta = (id: string, view: View, signal?: AbortSignal) =>
  frameMeta(id, view.ra, view.dec, view.fov, signal) as Promise<FrameMeta>;

export const fetchSpectrum = (ra: number, dec: number, signal?: AbortSignal) =>
  spectrum(ra, dec, signal) as Promise<Spectrum>;

export async function fetchCoadd(
  view: View,
  band: number,
  channel: number | null,
  size: number,
  signal?: AbortSignal,
): Promise<CoaddResult> {
  const out = await coadd(view, band, channel, size, signal);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.putImageData(toImageData(out.image), 0, 0);
  const png = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("PNG failed"))), "image/png"));
  return {
    url: URL.createObjectURL(png),
    framesUsed: out.framesUsed.length,
    waveMin: out.waveMin,
    waveMax: out.waveMax,
    clipped: out.clipped,
    fitsUrl: URL.createObjectURL(coaddFits(out, view, band, channel)),
  };
}
