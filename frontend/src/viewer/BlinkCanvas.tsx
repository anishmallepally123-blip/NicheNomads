// The picture itself: draws one frame on a canvas with map-style navigation
// (smooth wheel and button zoom, drag with a little glide, pinch on touch,
// keyboard), a live RA/Dec readout under the pointer, and a button to fetch
// fresh images for whatever area is on screen.
// Extension point: built-in marks (reticle, scale bar, compass) draw in
// drawOverlays(). Other layers (catalogue overlays) plug in through the
// `drawExtra` and `onPick` props, which get the same `geom` object.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LoadedFrame, View } from "../api/client";
import { formatDec, formatFov, formatRa, offsetToSky } from "../lib/sky";
import { FOV_MAX, FOV_MIN, ZOOM_MAX, ZOOM_MIN } from "../state/urlState";

interface Props {
  frame: LoadedFrame | null;
  /** Picture to draw instead of frame.image (e.g. a difference image). */
  image?: CanvasImageSource | null;
  view: View;
  invert: boolean;
  showMarker: boolean;
  /** On-screen zoom requested from outside (URL); 1 = whole field fits. */
  zoom?: number;
  /** Reports the zoom once an animation settles, so it can go in the URL. */
  onZoomChange?: (zoom: number) => void;
  /** Called when the user asks to re-centre the view on a new sky position. */
  onRecenter: (ra: number, dec: number) => void;
  /** Called when the user asks for new images of the area on screen. */
  onLoadView?: (ra: number, dec: number, fov: number) => void;
  /** Upper limit for the canvas side in CSS pixels (embeds with little height). */
  maxSide?: number;
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
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export default function BlinkCanvas({
  frame,
  image,
  view,
  invert,
  showMarker,
  zoom: zoomProp = 1,
  onZoomChange,
  onRecenter,
  onLoadView,
  maxSide,
  drawExtra,
  onPick,
  children,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(512);
  const side = Math.max(200, Math.min(width, maxSide ?? Infinity));
  const [t, setT] = useState<Transform>(() => ({ ...HOME, zoom: clampZoom(zoomProp) }));
  const [hover, setHover] = useState<{ ra: number; dec: number } | null>(null);

  // Animation: `goal` is where the view is heading, `t` is what is drawn.
  const tRef = useRef(t);
  tRef.current = t;
  const goal = useRef<Transform>(t);
  const raf = useRef(0);
  const sideRef = useRef(side);
  sideRef.current = side;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  const zoomPropRef = useRef(zoomProp);
  zoomPropRef.current = zoomProp;
  const settle = useCallback((final: Transform) => {
    if (Math.abs(final.zoom - zoomPropRef.current) > 0.01) onZoomChangeRef.current?.(final.zoom);
  }, []);

  const animateTo = useCallback(
    (target: Transform) => {
      goal.current = clampPan(target, sideRef.current);
      cancelAnimationFrame(raf.current);
      if (reducedMotion()) {
        setT(goal.current);
        settle(goal.current);
        return;
      }
      const tick = () => {
        const cur = tRef.current;
        const g = goal.current;
        const k = 0.22;
        const zoom = Math.exp(Math.log(cur.zoom) + (Math.log(g.zoom) - Math.log(cur.zoom)) * k);
        const next = { zoom, x: cur.x + (g.x - cur.x) * k, y: cur.y + (g.y - cur.y) * k };
        const done =
          Math.abs(Math.log(g.zoom / zoom)) < 0.002 && Math.abs(g.x - next.x) < 0.3 && Math.abs(g.y - next.y) < 0.3;
        if (done) {
          tRef.current = g;
          setT(g);
          settle(g);
          return;
        }
        tRef.current = next;
        setT(next);
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [settle],
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const jumpTo = useCallback((target: Transform) => {
    cancelAnimationFrame(raf.current);
    const c = clampPan(target, sideRef.current);
    goal.current = c;
    tRef.current = c;
    setT(c);
  }, []);

  // A new field of view or centre starts again from the requested zoom.
  useEffect(() => {
    jumpTo({ zoom: clampZoom(zoomPropRef.current), x: 0, y: 0 });
  }, [view.ra, view.dec, view.fov, jumpTo]);

  // Zoom changed from outside (Back button, embed API): glide there.
  useEffect(() => {
    const g = goal.current;
    const z = clampZoom(zoomProp);
    if (Math.abs(z - g.zoom) / g.zoom > 0.01) {
      const r = z / g.zoom;
      animateTo({ zoom: z, x: g.x * r, y: g.y * r });
    }
  }, [zoomProp, animateTo]);

  // Keep the canvas square and as large as its container allows.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
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
    (cx: number, cy: number, tr: Transform = tRef.current) => {
      const scale = (view.fov * 60) / (side * tr.zoom);
      const east = -(cx - side / 2 - tr.x) * scale;
      const north = -(cy - side / 2 - tr.y) * scale;
      return offsetToSky(view.ra, view.dec, east, north);
    },
    [side, view.ra, view.dec, view.fov],
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

    const picture = image ?? frame?.image ?? null;
    if (picture) {
      ctx.imageSmoothingEnabled = t.zoom < 3; // show honest pixels when zoomed in
      ctx.filter = invert ? "invert(1)" : "none";
      ctx.drawImage(picture, left, top, drawn, drawn);
      ctx.filter = "none";
    }
    if (t.zoom < 1) {
      // outline of the loaded field when zoomed out past it
      ctx.strokeStyle = "rgba(148, 160, 189, 0.5)";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(left, top, drawn, drawn);
      ctx.setLineDash([]);
    }
    const geom = { side, centerX: side / 2 + t.x, centerY: side / 2 + t.y, arcsecPerCanvasPx };
    drawExtra?.(ctx, geom);
    drawOverlays(ctx, geom, showMarker);
  }, [frame, image, side, t, invert, showMarker, arcsecPerCanvasPx, drawExtra]);

  // ---- zoom helpers ------------------------------------------------------
  /** Zoom by k around a canvas point given relative to the canvas centre. */
  const zoomAround = useCallback(
    (k: number, mx = 0, my = 0, animate = true) => {
      const g = animate ? goal.current : tRef.current;
      const zoom = clampZoom(g.zoom * k);
      const r = zoom / g.zoom;
      // keep the sky under the pointer fixed while zooming
      const next = { zoom, x: mx - (mx - g.x) * r, y: my - (my - g.y) * r };
      if (animate) animateTo(next);
      else jumpTo(next);
    },
    [animateTo, jumpTo],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const g = goal.current;
      animateTo({ ...g, x: g.x + dx, y: g.y + dy });
    },
    [animateTo],
  );

  const reset = useCallback(() => animateTo(HOME), [animateTo]);

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    // trackpads send many small deltas, mouse wheels a few big ones
    const k = Math.exp(-Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 33 : 1))) * 0.0018);
    zoomAround(k, e.clientX - rect.left - side / 2, e.clientY - rect.top - side / 2);
  };

  // ---- pointer: drag, glide, pinch, hover readout ------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ moved: boolean; vx: number; vy: number; time: number } | null>(null);
  const pinch = useRef<{ dist: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(raf.current);
    goal.current = tRef.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    } else {
      drag.current = { moved: false, vx: 0, vy: 0, time: performance.now() };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse") setHover(canvasToSky(e.clientX - rect.left, e.clientY - rect.top));
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2 - rect.left - side / 2;
      const my = (a.y + b.y) / 2 - rect.top - side / 2;
      if (pinch.current.dist > 0) zoomAround(dist / pinch.current.dist, mx, my, false);
      pinch.current.dist = dist;
      if (drag.current) drag.current.moved = true;
      return;
    }

    const d = drag.current;
    if (!d) return;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    const now = performance.now();
    const dt = Math.max(1, now - d.time);
    d.vx = 0.7 * d.vx + 0.3 * (dx / dt);
    d.vy = 0.7 * d.vy + 0.3 * (dy / dt);
    d.time = now;
    const cur = tRef.current;
    jumpTo({ ...cur, x: cur.x + dx, y: cur.y + dy });
    if (e.pointerType === "mouse") setHover(canvasToSky(e.clientX - rect.left, e.clientY - rect.top));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size > 0) return;
    const d = drag.current;
    drag.current = null;
    // a click without dragging: let overlays pick a marker
    if (d && !d.moved && onPick && e.type === "pointerup") {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cur = tRef.current;
      onPick(e.clientX - rect.left, e.clientY - rect.top, {
        side, centerX: side / 2 + cur.x, centerY: side / 2 + cur.y,
        arcsecPerCanvasPx: (view.fov * 60) / (side * cur.zoom),
      });
    }
    // a short glide after a flick, like a map
    if (d && d.moved && performance.now() - d.time < 80 && Math.hypot(d.vx, d.vy) > 0.15) {
      const cur = tRef.current;
      animateTo({ ...cur, x: cur.x + d.vx * 220, y: cur.y + d.vy * 220 });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sky = canvasToSky(e.clientX - rect.left, e.clientY - rect.top);
    onRecenter(sky.ra, sky.dec);
  };

  // ---- keyboard: + / - zoom, 0 reset, Shift+arrows or WASD pan ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      const step = sideRef.current * 0.2;
      const pans: Record<string, [number, number]> = {
        w: [0, step], s: [0, -step], a: [step, 0], d: [-step, 0],
      };
      if (e.shiftKey) {
        Object.assign(pans, {
          ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [step, 0], ArrowRight: [-step, 0],
        });
      }
      if (e.key === "+" || e.key === "=") zoomAround(1.5);
      else if (e.key === "-" || e.key === "_") zoomAround(1 / 1.5);
      else if (e.key === "0") reset();
      else if (pans[e.key] ?? pans[e.key.toLowerCase()]) {
        const [dx, dy] = pans[e.key] ?? pans[e.key.toLowerCase()];
        panBy(dx, dy);
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // capture phase, so Shift+arrows pan instead of stepping frames
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoomAround, reset, panBy]);

  // ---- "load images for this view" ---------------------------------------
  const panned = Math.abs(t.x) > 4 || Math.abs(t.y) > 4;
  const zoomed = t.zoom > 1.15 || t.zoom < 0.87;
  const newFov = Math.min(FOV_MAX, Math.max(FOV_MIN, view.fov / t.zoom));
  const fovChanges = Math.abs(newFov - view.fov) / view.fov > 0.1;
  let loadLabel: string | null = null;
  if (zoomed && fovChanges) {
    loadLabel = t.zoom > 1 ? `Load sharper images of this ${formatFov(newFov)} area` : `Load a wider ${formatFov(newFov)} field`;
  } else if (panned) loadLabel = "Load images centred here";

  const loadView = () => {
    const sky = canvasToSky(side / 2, side / 2);
    if (onLoadView) onLoadView(sky.ra, sky.dec, zoomed && fovChanges ? +newFov.toFixed(3) : view.fov);
    else onRecenter(sky.ra, sky.dec);
  };

  return (
    <div className="canvas-wrap" ref={wrapRef} style={maxSide ? { maxWidth: side } : undefined}>
      <canvas
        ref={canvasRef}
        style={{ width: side, height: side }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        aria-label="SPHEREx image of the selected sky patch"
      />
      <div className="map-buttons">
        <button onClick={() => zoomAround(1.5)} title="Zoom in (+)" aria-label="Zoom in">+</button>
        <button onClick={() => zoomAround(1 / 1.5)} title="Zoom out (−)" aria-label="Zoom out">−</button>
        <button onClick={reset} title="Fit the whole field (0)" aria-label="Reset view">⌂</button>
        <span className="zoom-level" aria-live="polite">×{t.zoom < 10 ? t.zoom.toFixed(1) : Math.round(t.zoom)}</span>
      </div>
      <div className="readout" aria-live="off">
        {hover ? (
          <>
            <span>{formatRa(hover.ra)}</span>
            <span>{formatDec(hover.dec)}</span>
            <span className="muted">{hover.ra.toFixed(5)}°, {hover.dec.toFixed(5)}°</span>
          </>
        ) : (
          <span className="muted">
            {formatFov(view.fov / t.zoom)} across
          </span>
        )}
      </div>
      {loadLabel && (
        <button className="recenter" onClick={loadView}>
          {loadLabel}
        </button>
      )}
      {children}
    </div>
  );
}

function clampPan(t: Transform, side: number): Transform {
  // never let the picture leave the canvas completely
  const limit = (side * Math.max(1, t.zoom)) / 2;
  return {
    zoom: clampZoom(t.zoom),
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
  const choices = [5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  const barArcsec = choices.reduce((a, b) => (Math.abs(b - targetArcsec) < Math.abs(a - targetArcsec) ? b : a));
  const barPx = barArcsec / arcsecPerCanvasPx;
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, side - 18);
  ctx.lineTo(16 + barPx, side - 18);
  ctx.stroke();
  ctx.font = "15px VT323, monospace";
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
