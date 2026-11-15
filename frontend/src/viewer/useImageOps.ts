// Turns the current frame into the picture to draw, applying the chosen image
// arithmetic (see imageOps.ts). With op "none" it simply returns the frame.
import { useEffect, useMemo, useState } from "react";
import type { LoadedFrame } from "../api/client";
import type { DiffRef, ImageOp } from "../state/urlState";
import { combine, difference, imageDataToCanvas, readPixels, toImageData, type Pixels } from "./imageOps";

export interface ImageOpsResult {
  image: CanvasImageSource | null;
  /** Short description of what is on screen, e.g. "Frame 12 − median of 44 frames". */
  label: string | null;
  /** Frame index used as the reference, when there is one (to highlight it). */
  refIndex: number | null;
}

// Pixels are read once per decoded picture and dropped with it.
const pixelCache = new WeakMap<object, Pixels>();
export function pixelsOf(frame: LoadedFrame): Pixels {
  let p = pixelCache.get(frame.image);
  if (!p) {
    p = readPixels(frame.image);
    pixelCache.set(frame.image, p);
  }
  return p;
}

export function useImageOps(
  frames: LoadedFrame[],
  index: number,
  op: ImageOp,
  ref: DiffRef,
  n: number,
  gain: number,
): ImageOpsResult {
  // The median/mean template is slow-ish (all frames), so rebuild it only once
  // frames stop arriving for a moment.
  const wantsTemplate = op === "diff" && (ref === "median" || ref === "mean");
  const [template, setTemplate] = useState<{ pixels: Pixels; count: number; how: string } | null>(null);
  useEffect(() => {
    if (!wantsTemplate || frames.length < 2) {
      setTemplate(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const pixels = combine(frames.map(pixelsOf), ref as "median" | "mean");
      setTemplate(pixels ? { pixels, count: frames.length, how: ref } : null);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [frames, wantsTemplate, ref]);

  return useMemo<ImageOpsResult>(() => {
    const current = frames[index];
    if (!current) return { image: null, label: null, refIndex: null };
    if (op === "none" || frames.length < 2) {
      return { image: current.image, label: null, refIndex: null };
    }
    try {
      if (op === "sum") {
        const count = Math.min(n, frames.length);
        const start = Math.max(0, Math.min(index, frames.length - count));
        const stack = combine(frames.slice(start, start + count).map(pixelsOf), "mean");
        if (!stack) return { image: current.image, label: null, refIndex: null };
        return {
          image: imageDataToCanvas(toImageData(stack)),
          label: `Average of frames ${start + 1}–${start + count}`,
          refIndex: null,
        };
      }

      // op === "diff"
      let base: Pixels | null = null;
      let label = "";
      let refIndex: number | null = null;
      if (ref === "median" || ref === "mean") {
        if (!template || template.how !== ref) {
          return { image: current.image, label: `Building the ${ref} of all frames…`, refIndex: null };
        }
        base = template.pixels;
        label = `Frame ${index + 1} − ${ref} of ${template.count} frames`;
      } else {
        if (ref === "prev") refIndex = (index - 1 + frames.length) % frames.length;
        else if (ref === "first") refIndex = index === 0 ? 1 : 0;
        else {
          refIndex = frames.findIndex((f) => f.obs_id === ref);
          if (refIndex < 0) {
            return { image: current.image, label: "Pinned reference frame not loaded (yet)", refIndex: null };
          }
        }
        base = pixelsOf(frames[refIndex]);
        label = `Frame ${index + 1} − frame ${refIndex + 1}`;
      }
      const diff = difference(pixelsOf(current), base, gain);
      if (!diff) return { image: current.image, label: "Frames have different sizes", refIndex: null };
      return { image: imageDataToCanvas(diff), label, refIndex };
    } catch (err) {
      console.warn(err);
      return { image: current.image, label: "Image arithmetic failed for this frame", refIndex: null };
    }
  }, [frames, index, op, ref, n, gain, template]);
}
