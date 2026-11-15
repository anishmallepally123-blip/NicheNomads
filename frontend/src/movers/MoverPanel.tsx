// "Find movers" card: runs the visit-to-visit subtraction (find.ts), lists
// the candidates, marks them on the picture, and asks Claude for a short note
// on each one. Detection works without Claude; only the notes need it.
import { useCallback, useEffect, useState } from "react";
import type { LoadedFrame } from "../api/client";
import type { CatalogResult, LayerKey } from "../overlays/api";
import { mjdNow, positionAt, skyToOffset, totalPm } from "../overlays/motion";
import { askClaude, NotSetUp, parseJsonReply } from "../ai/claude";
import { findMovers, type MoverCandidate, type MoverResult } from "./find";
import Info from "../glossary/Info";
import "../ai/ai.css";

interface Geom {
  side: number;
  centerX: number;
  centerY: number;
  arcsecPerCanvasPx: number;
}

export interface MoversState {
  result: MoverResult | null;
  show: boolean;
  selected: number | null;
  notes: Record<number, string>;
  claude: "idle" | "busy" | "done" | "off" | "error";
  claudeMessage: string | null;
}

const IDLE: MoversState = { result: null, show: true, selected: null, notes: {}, claude: "idle", claudeMessage: null };

/** Nearest catalogue star with a measured motion, within 6 arcsec. */
function catalogueMatch(c: MoverCandidate, layers: Partial<Record<LayerKey, CatalogResult>>) {
  let best: { catalog: string; name: string | null; pm_mas_yr: number; sep_arcsec: number; mag: number | null } | null = null;
  const now = mjdNow();
  for (const layer of Object.values(layers)) {
    if (!layer) continue;
    for (const s of layer.sources) {
      const p = s.pm_ok === false ? s : positionAt(s.ra, s.dec, s.pmra, s.pmdec, s.epoch_mjd ?? layer.epoch_mjd ?? now, now);
      const o = skyToOffset(c.ra, c.dec, p.ra, p.dec);
      if (!o) continue;
      const sep = Math.hypot(o.east, o.north);
      if (sep < 6 && (!best || sep < best.sep_arcsec)) {
        best = { catalog: layer.label, name: s.name ?? null, pm_mas_yr: Math.round(totalPm(s.pmra, s.pmdec)), sep_arcsec: +sep.toFixed(1), mag: s.mag };
      }
    }
  }
  return best;
}

export function useMovers(
  frames: LoadedFrame[],
  view: { ra: number; dec: number; fov: number },
  band: number,
  layers: Partial<Record<LayerKey, CatalogResult>>,
  fieldName: string | null,
) {
  const [state, setState] = useState<MoversState>(IDLE);
  useEffect(() => setState(IDLE), [view.ra, view.dec, view.fov, band]);

  const run = useCallback(async () => {
    const result = findMovers(frames, view);
    setState({ ...IDLE, result, claude: result.candidates.length ? "busy" : "idle" });
    if (!result.candidates.length) return;
    const input = {
      field: { name: fieldName, ra: +view.ra.toFixed(4), dec: +view.dec.toFixed(4), field_arcmin: view.fov, detector: band },
      visits: result.visits,
      candidates: result.candidates.map((c) => ({
        id: c.id,
        shift_arcsec: +c.shiftArcsec.toFixed(1),
        direction: c.direction,
        days_between_first_and_last: Math.round(c.days),
        rate_arcsec_per_year: Math.round(c.ratePerYear),
        seen_in_steps: c.steps.length,
        times_more_than_normal_star_wobble: Math.round(c.snr),
        very_bright: c.bright,
        nearby_catalogue_star: catalogueMatch(c, layers),
      })),
    };
    try {
      const reply = parseJsonReply<{ notes?: { id: number; text: string }[] }>(await askClaude("movers", input));
      const notes: Record<number, string> = {};
      for (const n of reply?.notes ?? []) if (typeof n.text === "string") notes[n.id] = n.text;
      setState((s) => (s.result === result ? { ...s, notes, claude: "done" } : s));
    } catch (err) {
      const off = err instanceof NotSetUp;
      setState((s) =>
        s.result === result ? { ...s, claude: off ? "off" : "error", claudeMessage: err instanceof Error ? err.message : String(err) } : s,
      );
    }
  }, [frames, view, band, layers, fieldName]);

  // Circles where each candidate is now, with an arrow from where it was.
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, g: Geom) => {
      const r = state.result;
      if (!r || !state.show || !r.candidates.length) return;
      const k = r.arcsecPerPx / g.arcsecPerCanvasPx;
      const c = (r.size - 1) / 2;
      const toCanvas = (x: number, y: number) => [g.centerX + (x - c) * k, g.centerY + (y - c) * k];
      ctx.save();
      ctx.font = "600 12px system-ui, sans-serif";
      for (const m of r.candidates) {
        const sel = m.id === state.selected;
        const [x, y] = toCanvas(m.x, m.y);
        const [fx, fy] = toCanvas(m.fromX, m.fromY);
        ctx.strokeStyle = sel ? "#ffffff" : "#ffb020";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = sel ? 2.5 : 1.75;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(fx, fy, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, sel ? 12 : 10, 0, Math.PI * 2);
        ctx.stroke();
        const len = Math.hypot(x - fx, y - fy);
        if (len > 4) {
          const ux = (x - fx) / len;
          const uy = (y - fy) / len;
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.lineTo(x - ux * 10, y - uy * 10);
          ctx.stroke();
        }
        ctx.fillText(String(m.id), x + 13, y - 9);
      }
      ctx.restore();
    },
    [state.result, state.show, state.selected],
  );

  return { state, setState, run, draw };
}

interface Props {
  movers: ReturnType<typeof useMovers>;
  frames: LoadedFrame[];
  loading: boolean;
  onCentre: (ra: number, dec: number) => void;
}

export default function MoverPanel({ movers, frames, loading, onCentre }: Props) {
  const { state, setState, run } = movers;
  const r = state.result;
  return (
    <section className="movers" aria-live="polite">
      <h2>Find movers<Info term="properMotion" /></h2>
      <p className="hint">
        Stacks the pictures from each visit, finds every dot, and follows it from visit to visit. Dots that drift
        in a straight line, much more than the other stars wobble, are listed here. Runs in your browser on the
        frames already loaded.
      </p>
      <div className="movers-actions">
        <button type="button" className="primary" onClick={run} disabled={frames.length < 4}>
          {r ? "Search again" : "Find movers"}
        </button>
        {r && r.candidates.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={state.show} onChange={(e) => setState((s) => ({ ...s, show: e.target.checked }))} />
            Mark them on the picture
          </label>
        )}
        {loading && frames.length >= 4 && <span className="muted">More frames are still loading.</span>}
      </div>
      {r?.note && <p className="muted">{r.note}</p>}
      {r && !r.note && (
        <p className="muted">
          {r.candidates.length
            ? `${r.candidates.length} candidate${r.candidates.length > 1 ? "s" : ""}`
            : "Nothing moved clearly"}{" "}
          across {r.visits.length} visits ({r.visits[0].from} to {r.visits[r.visits.length - 1].to}).
          {!r.candidates.length && " Try a bigger field, another band, or wait for all frames."}
        </p>
      )}
      {r && r.candidates.length > 0 && (
        <ol className="movers-list">
          {r.candidates.map((m) => (
            <li key={m.id} className={m.id === state.selected ? "active" : undefined}>
              <div className="movers-head">
                <button
                  type="button"
                  className="link"
                  onClick={() => setState((s) => ({ ...s, selected: s.selected === m.id ? null : m.id }))}
                  title="Highlight on the picture"
                >
                  <b>#{m.id}</b> moved {m.shiftArcsec.toFixed(1)}″ {m.direction}
                </button>
                <span className="movers-badge" title="How many visits it was seen in">{m.steps.length + 1} visits</span>
              </div>
              <span className="muted">
                about {m.ratePerYear >= 100 ? Math.round(m.ratePerYear) : m.ratePerYear.toFixed(1)}″ a year over {Math.round(m.days)} days
                {m.bright ? " · very bright, may be an artefact" : ""}
              </span>{" "}
              <button type="button" className="link" onClick={() => onCentre(m.ra, m.dec)}>Centre here</button>
              {state.notes[m.id] && <p className="movers-note">{state.notes[m.id]}</p>}
            </li>
          ))}
        </ol>
      )}
      {state.claude === "busy" && <p className="muted">Asking Niche to describe each one…</p>}
      {state.claude === "done" && Object.keys(state.notes).length > 0 && (
        <p className="ai-credit">Notes written by Niche from the numbers above. Treat them as a first guess.</p>
      )}
      {(state.claude === "off" || state.claude === "error") && (
        <p className="ai-off">{state.claudeMessage} Detection still works; only the notes are missing.</p>
      )}
    </section>
  );
}
