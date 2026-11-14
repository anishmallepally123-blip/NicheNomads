// Brightness against date. Faint dots are single exposures, big dots with
// error bars are the average of each visit, and the little crosses along the
// bottom are exposures that could not be measured.
import { useMemo, useState } from "react";
import { BAND_COLORS } from "../data/SpectrumChart";
import type { Curve } from "./curve";

const W = 360;
const H = 240;
const M = { left: 46, right: 10, top: 10, bottom: 50 };
const MISS_Y = H - M.bottom + 12;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const mjdToDate = (mjd: number) => new Date((mjd - 40587) * 86400000);
const dateToMjd = (d: Date) => d.getTime() / 86400000 + 40587;
const day = (mjd: number) => mjdToDate(mjd).toISOString().slice(0, 10);

function niceStep(range: number) {
  const raw = range / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

export default function LightCurveChart({ curve }: { curve: Curve }) {
  const [hover, setHover] = useState<string | null>(null);
  const all = [...curve.points.map((p) => p.mjd), ...curve.missing.map((m) => m.mjd)];
  const pad = Math.max(5, (Math.max(...all) - Math.min(...all)) * 0.04);
  const xMin = Math.min(...all) - pad;
  const xMax = Math.max(...all) + pad;

  const { yMin, yMax } = useMemo(() => {
    // scale to the visits plus most single points, so one wild exposure can't flatten the rest
    const vals = curve.visits.flatMap((v) => [v.value - v.err, v.value + v.err]);
    const singles = curve.points.map((p) => p.value).sort((a, b) => a - b);
    if (singles.length > 4) vals.push(singles[Math.floor(singles.length * 0.03)], singles[Math.ceil(singles.length * 0.97) - 1]);
    if (!curve.raw) vals.push(100);
    if (!vals.length) return { yMin: 0, yMax: 200 };
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const p = (hi - lo) * 0.08 || 10;
    return { yMin: lo - p, yMax: hi + p };
  }, [curve]);

  const sx = (mjd: number) => M.left + ((mjd - xMin) / (xMax - xMin)) * (W - M.left - M.right);
  const sy = (v: number) => H - M.bottom - ((v - yMin) / (yMax - yMin)) * (H - M.top - M.bottom);
  const clampY = (v: number) => Math.max(M.top, Math.min(H - M.bottom, sy(v)));
  const step = niceStep(yMax - yMin);
  const yTicks: number[] = [];
  for (let t = Math.ceil(yMin / step) * step; t <= yMax; t += step) yTicks.push(t);
  const fmt = (v: number) => (curve.raw && Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

  // month ticks, labelled every few months so they never crowd
  const xTicks: { mjd: number; label: string }[] = [];
  const start = mjdToDate(xMin);
  const spanMonths = (xMax - xMin) / 30.4;
  const every = spanMonths > 14 ? 3 : spanMonths > 6 ? 2 : 1;
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); dateToMjd(d) < xMax; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const m = d.getUTCMonth();
    if (m % every) continue;
    xTicks.push({ mjd: dateToMjd(d), label: m === 0 || xTicks.length === 0 ? `${MONTHS[m]} ${String(d.getUTCFullYear()).slice(2)}` : MONTHS[m] });
  }
  const unit = curve.raw ? "µJy" : "%";

  return (
    <div className="lc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Light curve: brightness against date">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={M.left - 6} y={sy(t) + 4} textAnchor="end">{fmt(t)}</text>
          </g>
        ))}
        {!curve.raw && <line x1={M.left} x2={W - M.right} y1={sy(100)} y2={sy(100)} className="average" />}
        {xTicks.map((t) => (
          <g key={t.mjd}>
            <line x1={sx(t.mjd)} x2={sx(t.mjd)} y1={H - M.bottom} y2={H - M.bottom + 4} className="tick" />
            <text x={sx(t.mjd)} y={H - M.bottom + 30} textAnchor="middle">{t.label}</text>
          </g>
        ))}
        <text transform={`translate(12 ${(M.top + H - M.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="axis-title">
          {curve.raw ? "Flux density (µJy)" : "Brightness vs its average (%)"}
        </text>

        {curve.points.map((p) => (
          <circle key={p.id} cx={sx(p.mjd)} cy={clampY(p.value)} r={1.7} fill={BAND_COLORS[p.detector - 1]} opacity={0.4}>
            <title>{`${day(p.mjd)}, D${p.detector} at ${p.wavelength?.toFixed(2) ?? "?"} µm: ${p.value.toFixed(0)} ± ${p.err.toFixed(0)} ${unit}`}</title>
          </circle>
        ))}
        {curve.missing.map((m) => (
          <g key={m.id} className="lc-miss" transform={`translate(${sx(m.mjd)} ${MISS_Y})`}>
            <path d="M-2.5 -2.5 L2.5 2.5 M-2.5 2.5 L2.5 -2.5" />
            <title>{`${day(m.mjd)}, D${m.detector}: ${m.reason}`}</title>
          </g>
        ))}
        {curve.visits.map((v) => {
          const x = sx(v.mjd);
          const label =
            `${day(v.first)}${v.last - v.first >= 1 ? ` to ${day(v.last)}` : ""}: ` +
            `${v.value.toFixed(curve.raw ? 0 : 1)} ± ${v.err.toFixed(curve.raw ? 0 : 1)} ${unit} from ${v.n} exposure${v.n === 1 ? "" : "s"}`;
          return (
            <g key={v.mjd} onMouseEnter={() => setHover(label)} onMouseLeave={() => setHover(null)} onClick={() => setHover(label)}>
              <line x1={x} x2={x} y1={clampY(v.value - v.err)} y2={clampY(v.value + v.err)} className="lc-err" />
              <circle cx={x} cy={clampY(v.value)} r={4} className="lc-visit" />
              <rect x={x - 7} y={M.top} width={14} height={H - M.top - M.bottom} fill="transparent">
                <title>{label}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="lc-legend">
        <span><i className="dot" />Visit average</span>
        <span><i className="small" />One exposure</span>
        {curve.missing.length > 0 && <span><i className="cross">×</i>Not measured</span>}
      </div>
      <p className="hint lc-hover">{hover ?? "Point at or tap a big dot for its date and value."}</p>
    </div>
  );
}
