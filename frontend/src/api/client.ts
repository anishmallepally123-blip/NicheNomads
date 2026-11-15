// Data layer used by the components. Everything runs in the browser: the IRSA
// search, the FITS cutouts, alignment and display scaling (see src/data/).
// There is no backend of our own.

import { alignCutout, cutoutSizeDeg, toImageData } from "../data/align";
import { fetchCutout, searchFrames, type Frame } from "../data/irsa";
import { resolve, TARGETS, type Target } from "../data/targets";
import type { Plane } from "../state/urlState";

export type { Target };
export interface FrameInfo {
  id: string;
  obs_id: string;
  detector: number;
  mjd: number;
  date: string;
  exptime: number;
  wave_min: number;
  wave_max: number;
  collection: string;
  release_date: string;
  access_url: string; // the full exposure file at IRSA
}

export interface BandInfo {
  detector: number;
  count: number;
  wave_min: number;
  wave_max: number;
}

export interface FrameList {
  ra: number;
  dec: number;
  band: number | null;
  count: number;
  total: number;
  bands: BandInfo[];
  latest: FrameInfo | null;
  frames: FrameInfo[];
}

/** A frame whose picture has been downloaded and is ready to draw. */
export interface LoadedFrame extends FrameInfo {
  image: ImageBitmap;
  wavelength: number | null;
  coverage: number;
  flaggedFraction: number;
}

export interface View {
  ra: number;
  dec: number;
  fov: number; // arcmin
}

export const fetchTargets = async (): Promise<Target[]> => TARGETS;

export const resolveQuery = async (q: string) => resolve(q);

const publicFrame = (f: Frame): FrameInfo => ({ ...f });

export async function fetchFrames(view: View, band: number, refresh = false, signal?: AbortSignal): Promise<FrameList> {
  const found = await searchFrames(view.ra, view.dec, refresh, signal);
  const perBand = new Map<number, BandInfo>();
  for (const f of found) {
    const b = perBand.get(f.detector) ?? { detector: f.detector, count: 0, wave_min: f.wave_min, wave_max: f.wave_max };
    b.count++;
    perBand.set(f.detector, b);
  }
  const selected = found.filter((f) => !band || f.detector === band);
  const latest = found.reduce<Frame | null>((a, f) => (!a || f.mjd > a.mjd ? f : a), null);
  return {
    ra: view.ra,
    dec: view.dec,
    band,
    count: selected.length,
    total: found.length,
    bands: [...perBand.values()].sort((a, b) => a.detector - b.detector),
    latest: latest ? publicFrame(latest) : null,
    frames: selected.map(publicFrame),
  };
}

/** Download one exposure around the view, align it north-up and turn it into
 *  a picture. */
export async function loadFrameImage(
  frame: FrameInfo,
  view: View,
  size: number,
  signal?: AbortSignal,
  plane: Plane = "sky",
): Promise<LoadedFrame> {
  const full = (await searchFrames(view.ra, view.dec, false, signal)).find((f) => f.id === frame.id);
  if (!full) throw new Error(`Unknown frame ${frame.id} at this position`);
  const fovDeg = view.fov / 60;
  const cut = await fetchCutout(full, view.ra, view.dec, cutoutSizeDeg(fovDeg), signal);
  const aligned = alignCutout(cut, full.detector, view.ra, view.dec, fovDeg, size, true, plane);
  const image = await createImageBitmap(toImageData(aligned, plane === "sky" ? "asinh" : "linear"));
  return {
    ...frame,
    image,
    wavelength: aligned.wavelength,
    coverage: aligned.coverage,
    flaggedFraction: aligned.flaggedFraction,
  };
}
