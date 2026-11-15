// "Brightness over time" card: measures one star in every SPHEREx exposure
// and plots how its brightness changes from visit to visit.
import { useEffect, useMemo, useRef, useState } from "react";
import Info from "../glossary/Info";
import { formatDec, formatRa } from "../lib/sky";
import { buildCurve, curveCsv, type Curve } from "./curve";
import LightCurveChart from "./LightCurveChart";
import { measureStar, type Measured } from "./measure";
import type { LightCurveState } from "./useLightCurve";
import "./lightcurve.css";

type Async<T> = { status: "idle" } | { status: "loading" } | { status: "done"; value: T } | { status: "error"; message: string };

function verdict(c: Curve) {
  const saturated = c.missing.filter((m) => m.reason.startsWith("too bright")).length;
  if (saturated > (c.points.length + c.missing.length) / 2 && c.points.length < 20)
    return c.points.length
      ? "This star is too bright for SPHEREx in most exposures (its pixels fill up), so only a few could be measured. Treat the curve as a rough guide."
      : "This star is too bright for SPHEREx: its pixels fill up in every exposure, so its brightness can't be measured. SPHEREx is built for faint things.";
  if (c.raw) return "Raw fluxes mix colours, so some of the spread is just the star's colour. Switch raw off to compare like with like.";
  if (c.visits.length < 2) return "SPHEREx has only visited this spot once so far, so there is nothing to compare yet.";
  if (c.swing === null) return "Too few clean exposures per visit to say whether it changed.";
  const big = c.visits.filter((v) => v.n >= 3);
  const noise = 3 * Math.max(...big.map((v) => v.err));
  if (c.swing > Math.max(noise, 5))
    return `Its brightness changed by about ${c.swing.toFixed(0)}% between visits, well beyond the error bars. That looks like a real change.`;
  return `Between visits it stayed within about ${Math.max(c.swing, 1).toFixed(0)}%, which is inside the measurement noise. It looks steady here.`;
}

function missingNote(c: Curve) {
  if (!c.missing.length) return "";
  const counts = new Map<string, number>();
  for (const m of c.missing) counts.set(m.reason, (counts.get(m.reason) ?? 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`);
  return ` Not measured (crosses): ${parts.join("; ")}.`;
}

export default function LightCurvePanel({ lc, bands }: { lc: LightCurveState; bands: number[] }) {
  const { target } = lc;
  const [result, setResult] = useState<Async<Measured>>({ status: "idle" });
  const [band, setBand] = useState(0);
  const [raw, setRaw] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const measure = () => {
    setResult({ status: "loading" });
    setProgress(null);
    measureStar(target.ra, target.dec, (done, total) => setProgress([done, total]))
      .then((value) => setResult({ status: "done", value }))
      .catch((err) => setResult({ status: "error", message: String(err.message ?? err) }));
  };

  // picking a star measures it straight away; on a phone, scroll back here after a moment
  useEffect(() => {
    if (!target.picked) return setResult({ status: "idle" });
    measure();
    const card = root.current;
    if (card && card.getBoundingClientRect().top > window.innerHeight) {
      const t = window.setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "start" }), 900);
      return () => window.clearTimeout(t);
    }
  }, [target.ra, target.dec, target.picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const curve = useMemo(() => (result.status === "done" ? buildCurve(result.value, band, raw) : null), [result, band, raw]);
  const m = result.status === "done" ? result.value : null;
  const shown = curve ? curve.points.length + curve.missing.length : 0;

  return (
    <div className="lightcurve" ref={root}>
      <h2>Brightness over time<Info term="lightcurve" /></h2>
      <p className="lc-target">
        {target.picked ? "Your star" : "Centre of the view"}:{" "}
        <span className="mono">{formatRa(target.ra)} {formatDec(target.dec)}</span>
      </p>
      <div className="lc-row">
        <button className={lc.picking ? "lc-pick active" : "lc-pick"} onClick={() => lc.setPicking(!lc.picking)} aria-pressed={lc.picking}>
          {lc.picking ? "Now click a star…" : "Pick a star"}
        </button>
        {target.picked && <button onClick={lc.clear}>Use the centre</button>}
        <button className="primary" onClick={measure} disabled={result.status === "loading"}>
          {result.status === "loading" ? "Measuring…" : "Measure"}
        </button>
      </div>

      {result.status === "idle" && (
        <p className="hint">
          Press Pick a star and click one in the picture, or Measure the centre. You get a chart of how its brightness
          changed between SPHEREx visits. Try it on RW Aurigae or R Draconis, which really do change.
        </p>
      )}
      {result.status === "loading" && (
        <p className="hint">
          {progress ? `Measured ${progress[0]} of ${progress[1]} exposures. ` : "Finding exposures… "}
          A new star takes a minute or two.
        </p>
      )}
      {result.status === "error" && <p className="hint warn">{result.message}</p>}
      {curve && (
        <>
          <div className="lc-row">
            <select value={band} onChange={(e) => setBand(Number(e.target.value))} aria-label="Which bands to show">
              <option value={0}>All six bands</option>
              {(bands.length ? bands : [1, 2, 3, 4, 5, 6]).map((b) => (
                <option key={b} value={b}>Band {b} only</option>
              ))}
            </select>
            <label className="check lc-raw">
              <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw µJy
            </label>
          </div>
          {curve.points.length > 0 ? (
            <LightCurveChart curve={curve} />
          ) : (
            <p className="hint warn">No exposure in this choice could be measured.</p>
          )}
          <p className="hint">
            {(curve.points.length > 0 || curve.missing.length > 0) && <strong className="lc-verdict">{verdict(curve)} </strong>}
            {curve.points.length} of {shown} exposures plotted, in {curve.visits.length} visit{curve.visits.length === 1 ? "" : "s"}.
            {!raw && curve.points.length > 0 && " Each one is compared with the average at its own colour, so 100% means normal for this star."}
            {missingNote(curve)}
            {m && m.available > m.total &&
              ` SPHEREx has ${m.available.toLocaleString()} exposures here, so an even sample of ${m.total} across every visit and band was measured.`}{" "}
            <a href={curveCsv(curve)} download="light_curve.csv">Download CSV</a>
          </p>
        </>
      )}
    </div>
  );
}
