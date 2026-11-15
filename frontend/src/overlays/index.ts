// Catalogue overlays (Gaia DR3, CatWISE2020, known fast movers).
// App wiring: call useOverlays(view), then useOverlayCanvas(...) to get the
// two BlinkCanvas hooks, and render <OverlayPanel>, <SourceCard>, <AladinPanel>.
import { useCallback, useMemo } from "react";
import { drawMarkers, pickMarker, projectMarkers, type CanvasGeom } from "./draw";
import type { OverlaysState } from "./useOverlays";
import "./overlays.css";

export { default as OverlayPanel } from "./OverlayPanel";
export { default as SourceCard } from "./SourceCard";
export { default as AladinPanel } from "./AladinPanel";
export { useOverlays } from "./useOverlays";
export { mjdNow } from "./motion";
export type { CanvasGeom } from "./draw";

/** Draw and click handlers for BlinkCanvas, for the frame taken at `mjd`. */
export function useOverlayCanvas(
  overlays: OverlaysState,
  view: { ra: number; dec: number },
  mjd: number,
) {
  const { active, followMotion, selected, setSelected } = overlays;
  const selectedId = selected?.source.id ?? null;
  const markersFor = useCallback(
    (geom: CanvasGeom) => projectMarkers(active, view, geom, mjd, followMotion),
    [active, view, mjd, followMotion],
  );

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, geom: CanvasGeom) => {
      if (active.length) drawMarkers(ctx, markersFor(geom), selectedId, geom.side);
    },
    [active.length, markersFor, selectedId],
  );

  const pick = useCallback(
    (x: number, y: number, geom: CanvasGeom) => {
      const m = active.length ? pickMarker(markersFor(geom), x, y) : null;
      setSelected(m ? { layer: m.layer, source: m.src } : null);
      return m !== null;
    },
    [active.length, markersFor, setSelected],
  );

  return useMemo(() => ({ draw, pick }), [draw, pick]);
}
