// Turns catalogue sources into canvas markers for one frame, draws them, and
// finds the marker under a click.
import type { CatalogResult, CatalogSource, LayerKey } from "./api";
import { FAST_PM, positionAt, skyToOffset, totalPm } from "./motion";

/** Where the picture sits on the canvas (given by BlinkCanvas). */
export interface CanvasGeom {
  side: number;
  centerX: number; // canvas position of the view's RA/Dec
  centerY: number;
  arcsecPerCanvasPx: number;
}

export interface Marker {
  layer: LayerKey;
  src: CatalogSource;
  x: number; // canvas position at the frame's date
  y: number;
  fromX: number; // canvas position at the catalogue's epoch
  fromY: number;
  fast: boolean;
  dim: boolean; // probably an artefact
  radius: number;
}

export const LAYER_STYLE: Record<LayerKey, { color: string; label: string }> = {
  gaia: { color: "#4dd8ff", label: "Gaia DR3" },
  wise: { color: "#ff9f43", label: "CatWISE2020" },
  ices: { color: "#7cf2a6", label: "SPLICES ice sources" },
  movers: { color: "#ff5cdb", label: "Known fast movers" },
};
const FAST_COLOR = "#ff5cdb";
const SELECTED_COLOR = "#ffd166";

function radiusFor(mag: number | null, layer: LayerKey): number {
  if (layer === "movers") return 11;
  if (mag === null) return 3;
  const bright = layer === "gaia" ? 8 : 6; // magnitude that gets the biggest marker
  return Math.max(2.5, Math.min(9, 9 - (mag - bright) * 0.6));
}

export function projectMarkers(
  layers: CatalogResult[],
  view: { ra: number; dec: number },
  geom: CanvasGeom,
  mjd: number,
  followMotion: boolean,
): Marker[] {
  const out: Marker[] = [];
  const s = geom.arcsecPerCanvasPx;
  const margin = 20;
  const toCanvas = (ra: number, dec: number) => {
    const o = skyToOffset(view.ra, view.dec, ra, dec);
    return o ? { x: geom.centerX - o.east / s, y: geom.centerY - o.north / s } : null;
  };
  for (const layer of layers) {
    for (const src of layer.sources) {
      const epoch = src.epoch_mjd ?? layer.epoch_mjd ?? mjd;
      const useMotion = followMotion && src.pm_ok !== false;
      const now = useMotion ? positionAt(src.ra, src.dec, src.pmra, src.pmdec, epoch, mjd) : src;
      const p = toCanvas(now.ra, now.dec);
      if (!p || p.x < -margin || p.y < -margin || p.x > geom.side + margin || p.y > geom.side + margin) continue;
      const from = useMotion ? toCanvas(src.ra, src.dec) ?? p : p;
      out.push({
        layer: layer.catalog,
        src,
        x: p.x,
        y: p.y,
        fromX: from.x,
        fromY: from.y,
        fast: layer.catalog === "movers" || (src.pm_ok !== false && totalPm(src.pmra, src.pmdec) >= FAST_PM),
        dim: !!src.spurious,
        radius: radiusFor(src.mag, layer.catalog),
      });
    }
  }
  return out;
}

export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  markers: Marker[],
  selectedId: string | null,
  side: number,
) {
  ctx.save();
  // ordinary sources first, fast movers and the selection on top
  const ordered = [...markers].sort((a, b) => Number(a.fast) - Number(b.fast));
  for (const m of ordered) {
    const color = m.fast ? FAST_COLOR : LAYER_STYLE[m.layer].color;
    ctx.strokeStyle = color;
    ctx.globalAlpha = m.fast ? 1 : m.dim ? 0.35 : 0.8;
    ctx.lineWidth = m.fast ? 1.8 : 1.1;

    if (m.fast && Math.hypot(m.x - m.fromX, m.y - m.fromY) > 3) {
      // dashed trail from where the catalogue measured it to where it is now
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(m.fromX, m.fromY);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(m.fromX, m.fromY, 2, 0, 2 * Math.PI);
      ctx.stroke();
    }

    ctx.beginPath();
    if (m.layer === "ices") {
      // diamonds for ice targets
      const r = m.radius * 1.2;
      ctx.moveTo(m.x, m.y - r);
      ctx.lineTo(m.x + r, m.y);
      ctx.lineTo(m.x, m.y + r);
      ctx.lineTo(m.x - r, m.y);
      ctx.closePath();
    } else if (m.layer === "wise") {
      // squares for WISE so overlapping Gaia circles stay readable
      const r = m.radius * 0.9;
      ctx.rect(m.x - r, m.y - r, 2 * r, 2 * r);
    } else {
      ctx.arc(m.x, m.y, m.radius, 0, 2 * Math.PI);
    }
    ctx.stroke();

    if (m.layer === "movers" && m.src.name) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = FAST_COLOR;
      ctx.font = "12px system-ui, sans-serif";
      // put the label on whichever side of the marker has room
      const w = ctx.measureText(m.src.name).width;
      const right = m.x + m.radius + 4 + w <= side - 4;
      ctx.fillText(m.src.name, right ? m.x + m.radius + 4 : m.x - m.radius - 4 - w, m.y - m.radius);
    }
  }

  const sel = selectedId ? markers.find((m) => m.src.id === selectedId) : undefined;
  if (sel) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = SELECTED_COLOR;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sel.x, sel.y, sel.radius + 5, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}

/** The marker closest to a click, if one is within reach. */
export function pickMarker(markers: Marker[], x: number, y: number): Marker | null {
  let best: Marker | null = null;
  let bestD = Infinity;
  for (const m of markers) {
    const reach = Math.max(8, m.radius + 3);
    const d = Math.hypot(m.x - x, m.y - y);
    // a known mover wins ties, it is what people are looking for
    const score = m.layer === "movers" ? d - 4 : d;
    if (d <= reach && score < bestD) {
      best = m;
      bestD = score;
    }
  }
  return best;
}
