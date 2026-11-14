// The picture itself: draws one frame on a canvas with pan and zoom.
// Extension point: built-in marks (reticle, scale bar, compass) draw in
// drawOverlays(). Other layers (catalogue overlays) plug in through the
// `drawExtra` and `onPick` props, which get the same `geom` object.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LoadedFrame, View } from "../api/client";
import { offsetToSky } from "../lib/sky";

interface Props {
  frame: LoadedFrame | null;
  view: View;
  invert: boolean;
  showMarker: boolean;
  /** Called when the user asks to re-centre the view on a new sky position. */
  onRecenter: (ra: number, dec: number) => void;
  /** Extra drawing on top of the picture, under the built-in marks. */
  drawExtra?: (ctx: CanvasRenderingContext2D, geom: Geom) => void;
  /** A click (not a drag) on the canvas, in canvas pixels. */
  onPick?: (x: number, y: number, geom: Geom) => void;
  /** Rendered on top of the canvas, e.g. an info card. */
  children?: ReactNode;
}

interface Transform {
  zoom: number; // 1 = whole field fits the canvas
  x: number; // pan, in canvas pixels
  y: number;
}

const HOME: Transform = { zoom: 1, x: 0, y: 0 };
const MAX_ZOOM = 12;

export default function BlinkCanvas({ frame, view, invert, showMarker, onRecenter, drawExtra, onPick, children }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState(512);
  const [t, setT] = useState<Transform>(HOME);
  const drag = useRef<{ px: number; py: number; moved: boolean } | null>(null);

  // A new field of view or centre starts from the un-zoomed picture again.
  useEffect(() => setT(HOME), [view.ra, view.dec, view.fov]);

  // Keep the canvas square and as large as its container allows.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSide(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stop the page from scrolling while the wheel zooms the picture.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    canvas.addEventListener("wheel", stop, { passive: false });
    return () => canvas.removeEventListener("wheel", stop);
  }, []);

  const arcsecPerCanvasPx = (view.fov * 60) / (side * t.zoom);

  /** Canvas pixel -> sky position (north up, east left). */
  const canvasToSky = useCallback(
    (cx: number, cy: number) => {
      const east = -(cx - side / 2 - t.x) * arcsecPerCanvasPx;
      const north = -(cy - side / 2 - t.y) * arcsecPerCanvasPx;
      return offsetToSky(view.ra, view.dec, east, north);
    },
    [side, t, arcsecPerCanvasPx, view.ra, view.dec],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = side * dpr;
    canvas.height = side * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, side, side);

    const drawn = side * t.zoom;
    const left = side / 2 + t.x - drawn / 2;
    const top = side / 2 + t.y - drawn / 2;

    if (frame) {
      ctx.imageSmoothingEnabled = t.zoom < 3; // show honest pixels when zoomed in
      ctx.filter = invert ? "invert(1)" : "none";
      ctx.drawImage(frame.image, left, top, drawn, drawn);
      ctx.filter = "none";
    }
    const geom = { side, centerX: side / 2 + t.x, centerY: side / 2 + t.y, arcsecPerCanvasPx };
    drawExtra?.(ctx, geom);
    drawOverlays(ctx, geom, showMarker);
  }, [frame, side, t, invert, showMarker, arcsecPerCanvasPx, drawExtra]);

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left - side / 2;
    const my = e.clientY - rect.top - side / 2;
    setT((prev) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, prev.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      const k = zoom / prev.zoom;
      // keep the sky under the cursor fixed while zooming
      return clampPan({ zoom, x: mx - (mx - prev.x) * k, y: my - (my - prev.y) * k }, side);
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    d.px = e.clientX;
    d.py = e.clientY;
    setT((prev) => clampPan({ ...prev, x: prev.x + dx, y: prev.y + dy }, side));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !onPick || e.type !== "pointerup") return;
    const rect = canvasRef.current!.getBoundingClientRect();
    onPick(e.clientX - rect.left, e.clientY - rect.top, {
      side, centerX: side / 2 + t.x, centerY: side / 2 + t.y, arcsecPerCanvasPx,
    });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sky = canvasToSky(e.clientX - rect.left, e.clientY - rect.top);
    onRecenter(sky.ra, sky.dec);
  };

  const zoomBy = (k: number) =>
    setT((prev) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, prev.zoom * k));
      const r = zoom / prev.zoom;
      return clampPan({ zoom, x: prev.x * r, y: prev.y * r }, side);
    });

  const panned = Math.abs(t.x) > 4 || Math.abs(t.y) > 4;

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: side, height: side }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        aria-label="SPHEREx image of the selected sky patch"
      />
      <div className="map-buttons">
        <button onClick={() => zoomBy(1.5)} title="Zoom in" aria-label="Zoom in">+</button>
        <button onClick={() => zoomBy(1 / 1.5)} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={() => setT(HOME)} title="Reset view" aria-label="Reset view">⌂</button>
      </div>
      {panned && (
        <button
          className="recenter"
          onClick={() => {
            const sky = canvasToSky(side / 2, side / 2);
            onRecenter(sky.ra, sky.dec);
          }}
        >
          Load images centred here
        </button>
      )}
      {children}
    </div>
  );
}

function clampPan(t: Transform, side: number): Transform {
  // never let the picture leave the canvas completely
  const limit = (side * t.zoom) / 2;
  return {
    zoom: t.zoom,
    x: Math.min(limit, Math.max(-limit, t.x)),
    y: Math.min(limit, Math.max(-limit, t.y)),
  };
}

export interface Geom {
  side: number;
  centerX: number; // canvas position of the view's RA/Dec
  centerY: number;
  arcsecPerCanvasPx: number;
}

function drawOverlays(ctx: CanvasRenderingContext2D, geom: Geom, showMarker: boolean) {
  const { side, centerX, centerY, arcsecPerCanvasPx } = geom;

  if (showMarker) {
    // open reticle on the requested coordinates
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 1.5;
    const gap = 10;
    const len = 14;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(centerX + dx * gap, centerY + dy * gap);
      ctx.lineTo(centerX + dx * (gap + len), centerY + dy * (gap + len));
    }
    ctx.stroke();
  }

  // scale bar: a round number of arcsec/arcmin about a fifth of the width
  const targetArcsec = side * 0.2 * arcsecPerCanvasPx;
  const choices = [5, 10, 20, 30, 60, 120, 300, 600, 1200];
  const barArcsec = choices.reduce((a, b) => (Math.abs(b - targetArcsec) < Math.abs(a - targetArcsec) ? b : a));
  const barPx = barArcsec / arcsecPerCanvasPx;
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, side - 18);
  ctx.lineTo(16 + barPx, side - 18);
  ctx.stroke();
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(barArcsec >= 60 ? `${barArcsec / 60}′` : `${barArcsec}″`, 16, side - 24);

  // compass: north up, east left
  const cx = side - 34;
  const cy = 44;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - 22);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx - 22, cy);
  ctx.stroke();
  ctx.fillText("N", cx - 4, cy - 26);
  ctx.fillText("E", cx - 34, cy + 4);
}
