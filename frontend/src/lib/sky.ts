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
