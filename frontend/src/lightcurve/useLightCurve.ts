// Which star the light curve is for. By default the centre of the view; in
// "pick" mode the next click on the picture chooses a star instead.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanvasGeom } from "../overlays";
import { offsetToSky, skyToOffset } from "../lib/sky";

export interface LightCurveTarget {
  ra: number;
  dec: number;
  picked: boolean;
}

export function useLightCurve(view: { ra: number; dec: number }) {
  const [picked, setPicked] = useState<{ ra: number; dec: number } | null>(null);
  const [picking, setPicking] = useState(false);

  // a new view starts again from its centre
  useEffect(() => {
    setPicked(null);
    setPicking(false);
  }, [view.ra, view.dec]);

  const target: LightCurveTarget = picked ? { ...picked, picked: true } : { ra: view.ra, dec: view.dec, picked: false };

  /** Returns true when the click was used, so other click handlers can skip it. */
  const pick = useCallback(
    (x: number, y: number, geom: CanvasGeom) => {
      if (!picking) return false;
      const s = geom.arcsecPerCanvasPx;
      setPicked(offsetToSky(view.ra, view.dec, (geom.centerX - x) * s, (geom.centerY - y) * s));
      setPicking(false);
      return true;
    },
    [picking, view.ra, view.dec],
  );

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, geom: CanvasGeom) => {
      if (!picked) return;
      const o = skyToOffset(view.ra, view.dec, picked.ra, picked.dec);
      if (!o) return;
      const x = geom.centerX - o.east / geom.arcsecPerCanvasPx;
      const y = geom.centerY - o.north / geom.arcsecPerCanvasPx;
      ctx.save();
      ctx.strokeStyle = "#ffb347";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
    },
    [picked, view.ra, view.dec],
  );

  // on a phone the picture can be far above the card: bring it into view
  const startPicking = useCallback((on: boolean) => {
    setPicking(on);
    const viewer = document.getElementById("viewer");
    if (on && viewer && viewer.getBoundingClientRect().top < 0) viewer.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return useMemo(
    () => ({ target, picking, setPicking: startPicking, clear: () => setPicked(null), pick, draw }),
    [target.ra, target.dec, target.picked, picking, pick, draw, startPicking], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

export type LightCurveState = ReturnType<typeof useLightCurve>;
