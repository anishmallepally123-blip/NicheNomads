// Backend calls and types for the catalogue overlays.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export type LayerKey = "gaia" | "wise" | "movers";

export interface CatalogSource {
  id: string;
  ra: number; // degrees, at the reference epoch
  dec: number;
  pmra: number | null; // mas/yr, RA motion already times cos(dec)
  pmdec: number | null;
  mag: number | null;
  parallax?: number | null; // mas
  ruwe?: number | null;
  pm_err?: number | null;
  pm_ok?: boolean; // false: catalogue motion is not trustworthy, do not use it
  spurious?: boolean; // catalogue thinks this is probably an artefact
  w1?: number | null;
  flags?: string;
  name?: string;
  note?: string;
  epoch_mjd?: number; // only for known movers, which each carry their own
}

export interface CatalogResult {
  catalog: LayerKey;
  label: string;
  reference: string;
  epoch_mjd: number | null;
  mag_label: string;
  radius_arcmin: number;
  mag_limit: number | null;
  total: number;
  truncated: boolean;
  sources: CatalogSource[];
}

export async function fetchCatalog(
  key: LayerKey,
  ra: number,
  dec: number,
  fov: number,
  signal?: AbortSignal,
): Promise<CatalogResult> {
  const res = await fetch(`${BASE}/api/overlays/${key}?ra=${ra}&dec=${dec}&fov=${fov}`, { signal });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(typeof detail === "string" ? detail : "Catalogue request failed");
  }
  return res.json();
}
