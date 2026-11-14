// Types and data calls for the catalogue overlays (queried from the browser).

import { coneSearch, knownMovers } from "../data/catalogs";

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
  if (key === "movers") return knownMovers(ra, dec, fov);
  return coneSearch(key, ra, dec, fov, signal);
}
