// Brightness over time (light curves). App wiring: call useLightCurve(view),
// pass useCanvasExtras(overlayCanvas, lightCurve) to BlinkCanvas, and render
// <LightCurvePanel lc={lightCurve} />.
import { useCallback, useMemo } from "react";
import type { CanvasGeom } from "../overlays";
import type { LightCurveState } from "./useLightCurve";

export { default as LightCurvePanel } from "./LightCurvePanel";
export { useLightCurve } from "./useLightCurve";

interface CanvasLayer {
  draw: (ctx: CanvasRenderingContext2D, geom: CanvasGeom) => void;
  pick: (x: number, y: number, geom: CanvasGeom) => unknown;
}

/** Draws the overlays and the picked star; while picking, a click picks the star instead of a marker. */
export function useCanvasExtras(overlays: CanvasLayer, lc: LightCurveState) {
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, geom: CanvasGeom) => {
      overlays.draw(ctx, geom);
      lc.draw(ctx, geom);
    },
    [overlays, lc],
  );
  const pick = useCallback(
    (x: number, y: number, geom: CanvasGeom) => {
      if (!lc.pick(x, y, geom)) overlays.pick(x, y, geom);
    },
    [overlays, lc],
  );
  return useMemo(() => ({ draw, pick }), [draw, pick]);
}
