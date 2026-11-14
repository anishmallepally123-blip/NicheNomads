// "Explain this" button under "What's here?": sends the facts we already
// have about the view to Claude and shows a short plain-English explanation.
import { useEffect, useState } from "react";
import type { Description } from "../describe/useDescription";
import { plainType } from "../describe/simbad";
import type { LoadedFrame } from "../api/client";
import { askClaude, NotSetUp } from "./claude";
import "./ai.css";

interface Props {
  ra: number;
  dec: number;
  fov: number;
  band: number;
  d: Description;
  frames: LoadedFrame[];
}

type State = { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "off"; text: string } | { kind: "error"; text: string };

export default function ExplainButton({ ra, dec, fov, band, d, frames }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // A new place means a new explanation.
  useEffect(() => setState({ kind: "idle" }), [ra, dec]);

  const explain = async () => {
    setState({ kind: "busy" });
    const waves = frames.map((f) => f.wavelength).filter((w): w is number => w !== null);
    const facts = {
      ra: +ra.toFixed(5),
      dec: +dec.toFixed(5),
      field_arcmin: fov,
      our_notes: d.curated ? { name: d.curated.name, kind: d.curated.kind, distance: d.curated.distance, text: d.curated.text } : null,
      simbad_centre: d.highlight
        ? { name: d.highlight.name, type: plainType(d.highlight.otype), sep_arcsec: Math.round(d.highlight.separationArcsec), spectral_type: d.highlight.spType, parallax_mas: d.highlight.parallaxMas, redshift: d.highlight.redshift }
        : null,
      simbad_others: d.others.map((o) => `${o.name} (${plainType(o.otype).split(",")[0]})`),
      spherex: {
        detector: band,
        frames: frames.length,
        first: frames[0]?.date ?? null,
        last: frames[frames.length - 1]?.date ?? null,
        wavelength_um: waves.length ? [+Math.min(...waves).toFixed(2), +Math.max(...waves).toFixed(2)] : null,
      },
    };
    try {
      setState({ kind: "done", text: await askClaude("explain", facts) });
    } catch (err) {
      if (err instanceof NotSetUp) setState({ kind: "off", text: err.message });
      else setState({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="ai-explain" aria-live="polite">
      {state.kind !== "done" && (
        <button type="button" onClick={explain} disabled={state.kind === "busy" || d.loading}>
          {state.kind === "busy" ? "Asking Claude…" : "Explain this in plain English"}
        </button>
      )}
      {state.kind === "done" && (
        <div className="ai-answer">
          <p>{state.text}</p>
          <p className="ai-credit">Written by Claude from the catalogue facts above. It can make mistakes.</p>
        </div>
      )}
      {state.kind === "off" && <p className="ai-off">{state.text} The rest of the site works as normal.</p>}
      {state.kind === "error" && <p className="ai-off">{state.text}</p>}
    </div>
  );
}
