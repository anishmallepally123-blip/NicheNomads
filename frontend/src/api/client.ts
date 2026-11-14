// API client: the only file that knows the backend's URLs.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Target {
  id: string;
  name: string;
  ra: number;
  dec: number;
  note: string;
  suggested_band: number;
}

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

export const fetchTargets = () =>
  getJson<{ targets: Target[] }>("/api/targets").then((r) => r.targets);

export const resolveQuery = (q: string) =>
  getJson<{ ra: number; dec: number; name: string | null }>(
    `/api/resolve?q=${encodeURIComponent(q)}`,
  );

export const fetchFrames = (view: View, band: number, refresh = false, signal?: AbortSignal) =>
  getJson<FrameList>(
    `/api/frames?ra=${view.ra}&dec=${view.dec}&band=${band}${refresh ? "&refresh=true" : ""}`,
    signal,
  );

export function frameImageUrl(frame: FrameInfo, view: View, size: number, format = "png") {
  return (
    `${BASE}/api/frames/${encodeURIComponent(frame.id)}/image` +
    `?ra=${view.ra}&dec=${view.dec}&fov=${view.fov}&size=${size}&format=${format}`
  );
}

export async function loadFrameImage(
  frame: FrameInfo,
  view: View,
  size: number,
  signal?: AbortSignal,
): Promise<LoadedFrame> {
  const res = await fetch(frameImageUrl(frame, view, size), { signal });
  if (!res.ok) throw new Error(`Image ${frame.id} failed (${res.status})`);
  const num = (name: string) => {
    const v = res.headers.get(name);
    return v === null ? null : Number(v);
  };
  const image = await createImageBitmap(await res.blob());
  return {
    ...frame,
    image,
    wavelength: num("X-Wavelength-Um"),
    coverage: num("X-Coverage") ?? 1,
    flaggedFraction: num("X-Flagged-Fraction") ?? 0,
  };
}
