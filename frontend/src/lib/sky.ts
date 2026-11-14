// Small sky-geometry helpers. Angles in degrees unless noted.

const D2R = Math.PI / 180;

/** Sky position at an offset (arcsec, east and north positive) from a centre.
 *  Inverse tangent-plane projection, matching the backend's image grid. */
export function offsetToSky(ra0: number, dec0: number, eastArcsec: number, northArcsec: number) {
  const xi = (eastArcsec / 3600) * D2R;
  const eta = (northArcsec / 3600) * D2R;
  const d0 = dec0 * D2R;
  const denom = Math.cos(d0) - eta * Math.sin(d0);
  const ra = ra0 + Math.atan2(xi, denom) / D2R;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, denom)) / D2R;
  return { ra: ((ra % 360) + 360) % 360, dec };
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, "0");
}

export function formatRa(ra: number): string {
  const hours = ra / 15;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  const s = ((hours - h) * 60 - m) * 60;
  return `${pad(h)}h ${pad(m)}m ${s.toFixed(2).padStart(5, "0")}s`;
}

export function formatDec(dec: number): string {
  const sign = dec < 0 ? "-" : "+";
  const a = Math.abs(dec);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d) * 60 - m) * 60;
  return `${sign}${pad(d)}° ${pad(m)}′ ${s.toFixed(1).padStart(4, "0")}″`;
}

export function formatDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

/** Offset (arcsec, east and north positive) of a sky position from a centre.
 *  Forward tangent-plane projection, the inverse of offsetToSky(). */
export function skyToOffset(ra0: number, dec0: number, ra: number, dec: number) {
  const a = (ra - ra0) * D2R;
  const d = dec * D2R;
  const d0 = dec0 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
  const xi = (Math.cos(d) * Math.sin(a)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc;
  return { east: (xi / D2R) * 3600, north: (eta / D2R) * 3600 };
}

/** Galactic (l, b) -> ICRS (ra, dec), degrees. Used to draw the Milky Way plane. */
export function galacticToEquatorial(l: number, b: number) {
  // J2000 north galactic pole and the galactic longitude of the celestial pole
  const raGP = 192.85948 * D2R;
  const decGP = 27.12825 * D2R;
  const lCP = 122.93192 * D2R;
  const lr = l * D2R;
  const br = b * D2R;
  const sinDec = Math.sin(decGP) * Math.sin(br) + Math.cos(decGP) * Math.cos(br) * Math.cos(lCP - lr);
  const dec = Math.asin(sinDec);
  const y = Math.cos(br) * Math.sin(lCP - lr);
  const x = Math.cos(decGP) * Math.sin(br) - Math.sin(decGP) * Math.cos(br) * Math.cos(lCP - lr);
  const ra = raGP + Math.atan2(y, x);
  return { ra: (((ra / D2R) % 360) + 360) % 360, dec: dec / D2R };
}

/** Ecliptic longitude (latitude 0) -> ICRS (ra, dec), degrees. */
export function eclipticToEquatorial(lon: number) {
  const eps = 23.4393 * D2R;
  const l = lon * D2R;
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps), Math.cos(l));
  const dec = Math.asin(Math.sin(eps) * Math.sin(l));
  return { ra: (((ra / D2R) % 360) + 360) % 360, dec: dec / D2R };
}

/** Human field-of-view label: 90″, 5′, 1.5° ... */
export function formatFov(arcmin: number): string {
  if (arcmin < 1) return `${Math.round(arcmin * 60)}″`;
  if (arcmin >= 60) return `${+(arcmin / 60).toFixed(2)}°`;
  return `${+arcmin.toFixed(arcmin < 10 ? 2 : 1)}′`;
}
