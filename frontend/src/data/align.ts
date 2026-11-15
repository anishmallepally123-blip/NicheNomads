// Image alignment: turn a raw SPHEREx cutout into a north-up picture.
//
// SPHEREx exposures are rotated differently every time, so frames cannot be
// blinked as they come. alignCutout() resamples each one onto the same grid
// (north up, east left, centred on the requested RA/Dec) so that fixed stars
// stay put from frame to frame and anything that moves stands out.

import type { Hdu } from "./fits";
import { badBitmask, flagValues } from "./quality";
import { WAVE_TABLES } from "./waveTables";
import { SipWcs, tanDeproject } from "./wcs";

export interface Cutout {
  image: Hdu;
  zodi?: Hdu;
  flags?: Hdu;
  variance?: Hdu;
  epsf?: Hdu; // PSF grid table, only when asked for (4 MB)
}

export interface AlignedImage {
  data: Float32Array; // size x size, row 0 = top (north). NaN = no data
  size: number;
  wavelength: number | null; // microns, what SPHEREx saw at the centre
  bandwidth: number | null;
  coverage: number; // fraction of the picture that has data
  flaggedFraction: number; // fraction of source pixels with a *bad* quality flag
  // Same grid, but NaN wherever a bad pixel contributed. `data` has those
  // filled in from neighbours for a clean picture; anything that measures
  // (co-adds, differences) should use `science`.
  science: Float32Array;
  filled: Uint8Array; // 1 where `data` was filled in
  noise: number | null; // typical 1-sigma per source pixel, MJy/sr
}

function median(values: ArrayLike<number>): number {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Fill NaN pixels from a Gaussian-weighted average of good neighbours, for
 *  display only. Bigger holes get a wider kernel on later passes. */
export function fillBadPixels(src: Float32Array, nx: number, ny: number, passes = 4): Float32Array {
  let out = Float32Array.from(src);
  let sigma = 1;
  for (let pass = 0; pass < passes; pass++) {
    const holes: number[] = [];
    let anyGood = false;
    for (let i = 0; i < out.length; i++) Number.isFinite(out[i]) ? (anyGood = true) : holes.push(i);
    if (!holes.length || !anyGood) break;
    const r = Math.ceil(4 * sigma);
    const next = Float32Array.from(out);
    for (const i of holes) {
      const x = i % nx;
      const y = (i / nx) | 0;
      let sw = 0;
      let sv = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(ny - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const v = out[yy * nx + Math.min(nx - 1, Math.max(0, x + dx))];
          if (!Number.isFinite(v)) continue;
          const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
          sw += w;
          sv += w * v;
        }
      }
      if (sw > 1e-8) next[i] = sv / sw;
    }
    out = next;
    sigma *= 2;
  }
  return out;
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
  plane: "sky" | "zodi" | "noise" | "flags" = "sky",
): AlignedImage {
  const { image, zodi, flags, variance } = cut;
  const wcs = new SipWcs(image.header);
  const { nx, ny } = image;
  const n = nx * ny;

  // Bad pixels (by quality flag, or no value) become NaN in the science image.
  const mask = flags ? badBitmask(flags.header) : 0;
  const fv = flags && flags.nx === nx && flags.ny === ny ? flagValues(flags) : null;
  const useZodi = subtractZodi && zodi && zodi.nx === nx && zodi.ny === ny;
  const science = new Float32Array(n);
  let nBad = 0;
  for (let i = 0; i < n; i++) {
    // Remove the model of sunlight scattered by solar-system dust, the
    // dominant smooth background in every SPHEREx image.
    const v = useZodi ? image.data[i] - zodi!.data[i] : image.data[i];
    const bad = (fv !== null && (fv[i] & mask) !== 0) || !Number.isFinite(v);
    if (bad) nBad++;
    science[i] = bad ? NaN : v;
  }
  let display = nBad ? fillBadPixels(science, nx, ny) : science;
  // The other planes of the same file, shown instead of the sky on request.
  if (plane !== "sky") {
    const same = (h?: Hdu) => (h && h.nx === nx && h.ny === ny ? h : null);
    const other = new Float32Array(n);
    const z = same(zodi);
    const va = same(variance);
    for (let i = 0; i < n; i++) {
      if (plane === "zodi") other[i] = z ? z.data[i] : NaN;
      else if (plane === "noise") other[i] = va && va.data[i] > 0 ? Math.sqrt(va.data[i]) : NaN;
      // flags: 1 where a problem flag is set, 0 for usable pixels
      else other[i] = fv ? ((fv[i] & mask) !== 0 ? 1 : 0) : NaN;
    }
    display = other;
  }

  let noise: number | null = null;
  if (variance && variance.data.length === n) {
    const good: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = variance.data[i];
      if (Number.isFinite(science[i]) && v > 0) good.push(v);
    }
    if (good.length) noise = Math.sqrt(median(good));
  }

  const [cx, cy] = wcs.worldToPix(ra, dec);
  const { wavelength, bandwidth } = wavelengthAt(image, detector, cx, cy);

  // Output grid: north-up, east-left tangent plane centred on (ra, dec).
  const out = new Float32Array(size * size);
  const sci = new Float32Array(size * size);
  const filled = new Uint8Array(size * size);
  const scale = fovDeg / size;
  const crpix = (size + 1) / 2;
  let good = 0;
  for (let r = 0; r < size; r++) {
    const fy = size - r; // FITS row of this output row (top row = north)
    for (let c = 0; c < size; c++) {
      const o = r * size + c;
      const [wr, wd] = tanDeproject(-scale * (c + 1 - crpix), scale * (fy - crpix), ra, dec);
      const [px, py] = wcs.worldToPix(wr, wd);
      // bilinear interpolation, 0-based array coordinates. Values are surface
      // brightness (MJy/sr), so no flux rescaling is needed.
      const x = px - 1;
      const y = py - 1;
      if (x < -0.5 || y < -0.5 || x > nx - 0.5 || y > ny - 0.5) {
        out[o] = sci[o] = NaN;
        continue;
      }
      const x0 = Math.min(nx - 2, Math.max(0, Math.floor(x)));
      const y0 = Math.min(ny - 2, Math.max(0, Math.floor(y)));
      const tx = Math.min(1, Math.max(0, x - x0));
      const ty = Math.min(1, Math.max(0, y - y0));
      const i = y0 * nx + x0;
      const lerp = (p: Float32Array) =>
        (1 - ty) * ((1 - tx) * p[i] + tx * p[i + 1]) + ty * ((1 - tx) * p[i + nx] + tx * p[i + nx + 1]);
      out[o] = lerp(display);
      sci[o] = lerp(science);
      if (Number.isFinite(out[o])) {
        good++;
        if (!Number.isFinite(sci[o])) filled[o] = 1;
      }
    }
  }

  return {
    data: out,
    size,
    wavelength,
    bandwidth,
    coverage: good / (size * size),
    flaggedFraction: nBad / n,
    science: sci,
    filled,
    noise,
  };
}

/** Scale to 0..1 using the image's own background level and noise, so frames
 *  taken at different wavelengths look comparable when blinked. */
export function stretch(data: Float32Array, mode = "asinh", lowSigma = 2, highSigma = 40): Float32Array {
  const finite: number[] = [];
  for (const v of data) if (Number.isFinite(v)) finite.push(v);
  const out = new Float32Array(data.length);
  if (!finite.length) return out;
  if (mode === "linear") {
    // Smooth maps (background, noise, flags): darkest to brightest, 1% clipped.
    const s = Float64Array.from(finite).sort();
    const lo = s[Math.floor(s.length * 0.01)];
    const hi = s[Math.ceil(s.length * 0.99) - 1];
    const span = hi - lo || 1;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (Number.isFinite(v)) out[i] = Math.min(1, Math.max(0, (v - lo) / span));
    }
    return out;
  }
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
