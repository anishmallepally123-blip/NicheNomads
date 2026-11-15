// Image arithmetic on the loaded frames: subtract a reference to reveal things
// that move or change, or add (average) several frames to see fainter things.
//
// Works on the grey PNGs the backend sends. Every frame is already scaled
// against its own sky background (render.stretch), so frames taken at
// different wavelengths are comparable and static stars mostly cancel.
// Pixels with no data (alpha 0) stay transparent in the result.
//
// The PNGs use an asinh stretch, which boosts faint noise. Arithmetic is done
// after undoing that stretch (back to a linear 0..1 scale), otherwise every
// difference image would be mostly amplified noise. Keep ASINH_A in step with
// render.stretch() in the backend.

const ASINH_A = 0.05;
const ASINH_NORM = Math.asinh(1 / ASINH_A);
const toLinear = (grey: number) => ASINH_A * Math.sinh(grey * ASINH_NORM);
const toDisplay = (linear: number) => Math.asinh(Math.max(0, linear) / ASINH_A) / ASINH_NORM;

export interface Pixels {
  width: number;
  height: number;
  value: Float32Array; // 0..1, linear in flux
  valid: Uint8Array; // 1 where the pixel has data
}

let scratch: HTMLCanvasElement | null = null;

/** Read the grey level and data mask out of a decoded frame picture. */
export function readPixels(image: CanvasImageSource & { width: number; height: number }): Pixels {
  const width = image.width;
  const height = image.height;
  scratch ??= document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const n = width * height;
  const value = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    value[i] = toLinear(rgba[i * 4] / 255);
    valid[i] = rgba[i * 4 + 3] > 127 ? 1 : 0;
  }
  return { width, height, value, valid };
}

function sameShape(list: Pixels[]): boolean {
  return list.every((p) => p.width === list[0].width && p.height === list[0].height);
}

/** Per-pixel median (or mean) of many frames: a picture of everything that
 *  does not change. Subtracting it leaves only movers and variables. */
export function combine(list: Pixels[], how: "median" | "mean"): Pixels | null {
  if (list.length === 0 || !sameShape(list)) return null;
  const { width, height } = list[0];
  const n = width * height;
  const value = new Float32Array(n);
  const valid = new Uint8Array(n);
  const column = new Float32Array(list.length);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const p of list) if (p.valid[i]) column[k++] = p.value[i];
    if (k === 0) continue;
    valid[i] = 1;
    if (how === "mean") {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += column[j];
      value[i] = sum / k;
    } else {
      const part = column.subarray(0, k).sort();
      value[i] = k % 2 ? part[(k - 1) >> 1] : (part[k / 2 - 1] + part[k / 2]) / 2;
    }
  }
  return { width, height, value, valid };
}

/** a - b, drawn on a mid-grey background: brighter now = light, fainter now = dark. */
export function difference(a: Pixels, b: Pixels, gain: number): ImageData | null {
  if (!sameShape([a, b])) return null;
  const out = new ImageData(a.width, a.height);
  const d = out.data;
  for (let i = 0; i < a.value.length; i++) {
    if (!a.valid[i] || !b.valid[i]) continue;
    const v = 128 + (a.value[i] - b.value[i]) * gain * 255;
    const g = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
    d[i * 4 + 3] = 255;
  }
  return out;
}

/** Plain grey picture of a Pixels buffer (used for averaged stacks). */
export function toImageData(p: Pixels): ImageData {
  const out = new ImageData(p.width, p.height);
  const d = out.data;
  for (let i = 0; i < p.value.length; i++) {
    if (!p.valid[i]) continue;
    const g = Math.round(toDisplay(p.value[i]) * 255);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
    d[i * 4 + 3] = 255;
  }
  return out;
}

export function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = data.width;
  c.height = data.height;
  c.getContext("2d")!.putImageData(data, 0, 0);
  return c;
}
