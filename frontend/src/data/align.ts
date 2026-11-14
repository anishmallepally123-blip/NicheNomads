// Image alignment: turn a raw SPHEREx cutout into a north-up picture.
//
// SPHEREx exposures are rotated differently every time, so frames cannot be
// blinked as they come. alignCutout() resamples each one onto the same grid
// (north up, east left, centred on the requested RA/Dec) so that fixed stars
// stay put from frame to frame and anything that moves stands out.

import type { Hdu } from "./fits";
import { WAVE_TABLES } from "./waveTables";
import { SipWcs, tanDeproject } from "./wcs";

export interface Cutout {
  image: Hdu;
  zodi?: Hdu;
  flags?: Hdu;
}

export interface AlignedImage {
  data: Float32Array; // size x size, row 0 = top (north). NaN = no data
  size: number;
  wavelength: number | null; // microns, what SPHEREx saw at the centre
  bandwidth: number | null;
  coverage: number; // fraction of the picture that has data
  flaggedFraction: number; // fraction of source pixels with any quality flag
}

/** How big a raw cutout to download so a rotated frame still fills the view. */
export const cutoutSizeDeg = (fovDeg: number) => fovDeg * 1.5 + 0.01;

/** SPHEREx sees a different wavelength at every pixel (linear variable
 *  filter). Bilinear lookup in the detector's calibration table. */
export function wavelengthAt(image: Hdu, detector: number, px: number, py: number) {
  const t = WAVE_TABLES[detector];
  const h = image.header;
  if (!t || typeof h.CRPIX1W !== "number") return { wavelength: null, bandwidth: null };
  const rx = px - Number(h.CRPIX1W) + Number(h.CRVAL1W ?? 1);
  const ry = py - Number(h.CRPIX2W) + Number(h.CRVAL2W ?? 1);
  const seg = (pts: number[], v: number) => {
    let i = 0;
    while (i < pts.length - 2 && v > pts[i + 1]) i++;
    const f = Math.min(1, Math.max(0, (v - pts[i]) / (pts[i + 1] - pts[i])));
    return [i, f] as const;
  };
  const [ix, fx] = seg(t.x, rx);
  const [iy, fy] = seg(t.y, ry);
  const n = t.x.length;
  const at = (x: number, y: number, m: number) => t.v[(y * n + x) * 2 + m];
  const lerp = (m: number) =>
    (1 - fy) * ((1 - fx) * at(ix, iy, m) + fx * at(ix + 1, iy, m)) +
    fy * ((1 - fx) * at(ix, iy + 1, m) + fx * at(ix + 1, iy + 1, m));
  const round = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v * 1e4) / 1e4 : null);
  return { wavelength: round(lerp(0)), bandwidth: round(lerp(1)) };
}

export function alignCutout(
  cut: Cutout,
  detector: number,
  ra: number,
  dec: number,
  fovDeg: number,
  size: number,
  subtractZodi = true,
): AlignedImage {
  const { image, zodi, flags } = cut;
  const wcs = new SipWcs(image.header);
  const { nx, ny } = image;
  const src = image.data;

  // Remove the model of sunlight scattered by dust in our solar system, the
  // dominant smooth background in every SPHEREx image.
  let pix = src;
  if (subtractZodi && zodi && zodi.nx === nx && zodi.ny === ny) {
    pix = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) pix[i] = src[i] - zodi.data[i];
  }

  let flagged = 0;
  if (flags) {
    for (let i = 0; i < flags.data.length; i++) if (flags.data[i] !== 0) flagged++;
    flagged /= flags.data.length || 1;
  }

  const [cx, cy] = wcs.worldToPix(ra, dec);
  const { wavelength, bandwidth } = wavelengthAt(image, detector, cx, cy);

  // Output grid: north-up, east-left tangent plane centred on (ra, dec).
  const out = new Float32Array(size * size);
  const scale = fovDeg / size;
  const crpix = (size + 1) / 2;
  let good = 0;
  for (let r = 0; r < size; r++) {
    const fy = size - r; // FITS row of this output row (top row = north)
    for (let c = 0; c < size; c++) {
      const [wr, wd] = tanDeproject(-scale * (c + 1 - crpix), scale * (fy - crpix), ra, dec);
      const [px, py] = wcs.worldToPix(wr, wd);
      // bilinear interpolation, 0-based array coordinates
      const x = px - 1;
      const y = py - 1;
      if (x < -0.5 || y < -0.5 || x > nx - 0.5 || y > ny - 0.5) {
        out[r * size + c] = NaN;
        continue;
      }
      const x0 = Math.min(nx - 2, Math.max(0, Math.floor(x)));
      const y0 = Math.min(ny - 2, Math.max(0, Math.floor(y)));
      const tx = Math.min(1, Math.max(0, x - x0));
      const ty = Math.min(1, Math.max(0, y - y0));
      const i = y0 * nx + x0;
      const v =
        (1 - ty) * ((1 - tx) * pix[i] + tx * pix[i + 1]) +
        ty * ((1 - tx) * pix[i + nx] + tx * pix[i + nx + 1]);
      out[r * size + c] = v;
      if (Number.isFinite(v)) good++;
    }
  }

  return {
    data: out,
    size,
    wavelength,
    bandwidth,
    coverage: good / (size * size),
    flaggedFraction: flagged,
  };
}

/** Scale to 0..1 using the image's own background level and noise, so frames
 *  taken at different wavelengths look comparable when blinked. */
export function stretch(data: Float32Array, mode = "asinh", lowSigma = 2, highSigma = 40): Float32Array {
  const finite: number[] = [];
  for (const v of data) if (Number.isFinite(v)) finite.push(v);
  const out = new Float32Array(data.length);
  if (!finite.length) return out;
  const median = (a: number[]) => {
    const s = Float64Array.from(a).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const med = median(finite);
  const sigma = 1.4826 * median(finite.map((v) => Math.abs(v - med))) || 1e-6;
  const lo = med - lowSigma * sigma;
  const hi = med + highSigma * sigma;
  const a = 0.05;
  const norm = Math.asinh(1 / a);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    let s = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    if (mode === "asinh") s = Math.asinh(s / a) / norm;
    else if (mode === "sqrt") s = Math.sqrt(s);
    out[i] = s;
  }
  return out;
}

/** Greyscale picture, transparent where there is no data. North is up. */
export function toImageData(img: AlignedImage, mode = "asinh"): ImageData {
  const s = stretch(img.data, mode);
  const rgba = new Uint8ClampedArray(img.size * img.size * 4);
  for (let i = 0; i < s.length; i++) {
    const g = Math.round(s[i] * 255);
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = Number.isFinite(img.data[i]) ? 255 : 0;
  }
  return new ImageData(rgba, img.size, img.size);
}
