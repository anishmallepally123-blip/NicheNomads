// Add / subtract images. Subtracting a reference makes everything that stays
// put disappear, so a moving object shows up as a light/dark pair.
import type { LoadedFrame } from "../api/client";
import type { UpdateFn, ViewState } from "../state/urlState";

interface Props {
  state: ViewState;
  frames: LoadedFrame[];
  current: LoadedFrame | null;
  label: string | null;
  onChange: UpdateFn;
}

const REF_LABELS: Record<string, string> = {
  median: "Median of all frames (best for movers)",
  mean: "Average of all frames",
  prev: "Previous frame",
  first: "First frame",
};

export default function ImageOpsPanel({ state, frames, current, label, onChange }: Props) {
  const pinned = !(state.ref in REF_LABELS);
  const pinnedIndex = pinned ? frames.findIndex((f) => f.obs_id === state.ref) : -1;

  return (
    <div className="image-ops">
      <div className="segmented" role="radiogroup" aria-label="Image arithmetic">
        {(
          [
            ["none", "Normal"],
            ["diff", "Subtract"],
            ["sum", "Add"],
          ] as const
        ).map(([op, text]) => (
          <button
            key={op}
            role="radio"
            aria-checked={state.op === op}
            className={state.op === op ? "active" : ""}
            onClick={() => onChange({ op })}
          >
            {text}
          </button>
        ))}
      </div>

      {state.op === "diff" && (
        <>
          <label className="stack">
            Subtract
            <select value={pinned ? "pinned" : state.ref} onChange={(e) => e.target.value !== "pinned" && onChange({ ref: e.target.value })}>
              {Object.entries(REF_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
              {pinned && (
                <option value="pinned">
                  Pinned frame {pinnedIndex >= 0 ? pinnedIndex + 1 : "(not loaded)"}
                </option>
              )}
            </select>
          </label>
          <button
            disabled={!current}
            onClick={() => current && onChange({ ref: current.obs_id })}
            title="Use the frame on screen as the reference for all others"
          >
            Pin this frame as reference
          </button>
          <label className="stack">
            Contrast ×{state.gain}
            <input
              type="range" min={1} max={12} step={0.5} value={state.gain}
              onChange={(e) => onChange({ gain: Number(e.target.value) })}
            />
          </label>
        </>
      )}

      {state.op === "sum" && (
        <label className="stack">
          Average {state.n} frames at a time
          <input
            type="range" min={2} max={Math.max(2, Math.min(20, frames.length || 20))} step={1} value={state.n}
            onChange={(e) => onChange({ n: Number(e.target.value) })}
          />
        </label>
      )}

      {label && <p className="hint ops-label">{label}</p>}
      {state.op === "diff" && (
        <p className="hint">
          Grey means no change. A mover appears as a bright spot where it is now and a dark spot where it
          was in the reference.
        </p>
      )}
      {state.op === "sum" && (
        <p className="hint">Averaging nearby frames lowers the noise, so fainter objects show up.</p>
      )}
    </div>
  );
}
