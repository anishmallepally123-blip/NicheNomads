// Sky maths for overlays: move a source along its proper motion, and project
// a sky position onto the viewer's north-up tangent plane.

const D2R = Math.PI / 180;
const MAS_PER_DEG = 3.6e6;
const DAYS_PER_YEAR = 365.25;

/** Proper motions above this (mas/yr) get a motion trail and a highlight. */
export const FAST_PM = 100;

export function mjdNow(): number {
  return Date.now() / 86400000 + 40587;
}

export function mjdToYear(mjd: number): number {
  return 2000 + (mjd - 51544.5) / DAYS_PER_YEAR;
}

export function totalPm(pmra: number | null, pmdec: number | null): number {
  return Math.hypot(pmra ?? 0, pmdec ?? 0);
}

/** Position of a source at `mjd`, moving it in a straight line from `epochMjd`.
 *  Parallax (under 1 arcsec even for the nearest stars) is ignored. */
export function positionAt(
  ra: number,
  dec: number,
  pmra: number | null,
  pmdec: number | null,
  epochMjd: number,
  mjd: number,
): { ra: number; dec: number } {
  if (!pmra && !pmdec) return { ra, dec };
  const years = (mjd - epochMjd) / DAYS_PER_YEAR;
  const newDec = dec + ((pmdec ?? 0) * years) / MAS_PER_DEG;
  const cosd = Math.max(1e-6, Math.cos(dec * D2R));
  const newRa = ra + ((pmra ?? 0) * years) / MAS_PER_DEG / cosd;
  return { ra: ((newRa % 360) + 360) % 360, dec: newDec };
}

/** Offset (arcsec, east and north positive) of a sky position from a centre.
 *  Forward tangent-plane (gnomonic) projection; the inverse of offsetToSky in
 *  lib/sky.ts, matching the backend's north-up image grid. */
export function skyToOffset(ra0: number, dec0: number, ra: number, dec: number) {
  const d0 = dec0 * D2R;
  const d = dec * D2R;
  const dra = (ra - ra0) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dra);
  if (cosc <= 0) return null; // other side of the sky
  const xi = (Math.cos(d) * Math.sin(dra)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dra)) / cosc;
  return { east: (xi / D2R) * 3600, north: (eta / D2R) * 3600 };
}
