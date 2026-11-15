// Spectrum plot: flux against wavelength. Small faint dots are single
// exposures, big dots with error bars are the 102-channel averages.
import { useMemo, useState } from "react";
import type { Spectrum } from "./api";

export const BAND_COLORS = ["#56b4e9", "#2fbf8f", "#f0e442", "#e69f00", "#ff7a45", "#e58fc4"];

const W = 360;
const H = 250;
const M = { left: 44, right: 8, top: 10, bottom: 36 };
const X_MIN = 0.7;
const X_MAX = 5.1;

function niceStep(range: number) {
  const raw = range / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

export default function SpectrumChart({ spectrum }: { spectrum: Spectrum }) {
  const [hover, setHover] = useState<string | null>(null);

  const { yMin, yMax } = useMemo(() => {
    const vals = spectrum.channels.flatMap((c) => [c.flux_ujy - c.flux_err_ujy, c.flux_ujy + c.flux_err_ujy]);
    if (vals.length === 0) return { yMin: -1, yMax: 1 };
    const lo = Math.min(0, ...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.06 || 1;
    return { yMin: lo - pad, yMax: hi + pad };
  }, [spectrum]);

  const sx = (w: number) => M.left + ((w - X_MIN) / (X_MAX - X_MIN)) * (W - M.left - M.right);
  const sy = (f: number) => H - M.bottom - ((f - yMin) / (yMax - yMin)) * (H - M.top - M.bottom);
  const step = niceStep(yMax - yMin);
  const yTicks: number[] = [];
  for (let t = Math.ceil(yMin / step) * step; t <= yMax; t += step) yTicks.push(t);
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `${Math.round(v)}`);

  return (
    <div className="spectrum-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spectrum: flux density against wavelength">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} className={t === 0 ? "zero" : "grid"} />
            <text x={M.left - 6} y={sy(t) + 4} textAnchor="end">{fmt(t)}</text>
          </g>
        ))}
        {[1, 2, 3, 4, 5].map((w) => (
          <g key={w}>
            <line x1={sx(w)} x2={sx(w)} y1={H - M.bottom} y2={H - M.bottom + 4} className="tick" />
            <text x={sx(w)} y={H - M.bottom + 17} textAnchor="middle">{w}</text>
          </g>
        ))}
        <text x={(M.left + W - M.right) / 2} y={H - 4} textAnchor="middle" className="axis-title">
          Wavelength (µm)
        </text>
        <text transform={`translate(13 ${(M.top + H - M.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="axis-title">
          Flux density (µJy)
        </text>

        {spectrum.points.map((p) =>
          p.ok && p.wavelength !== null && p.flux_ujy !== undefined && p.flux_ujy >= yMin && p.flux_ujy <= yMax ? (
            <circle key={p.id} cx={sx(p.wavelength)} cy={sy(p.flux_ujy)} r={1.6}
              fill={BAND_COLORS[p.detector - 1]} opacity={0.35} />
          ) : null,
        )}
        {spectrum.channels.map((c) => {
          const color = BAND_COLORS[c.band - 1];
          const x = sx(c.wavelength);
          const label =
            `Channel ${c.index + 1} of 102 (band ${c.band}): ${c.wavelength.toFixed(3)} µm, ` +
            `${c.flux_ujy.toFixed(0)} ± ${c.flux_err_ujy.toFixed(0)} µJy from ${c.n} exposure${c.n === 1 ? "" : "s"}`;
          return (
            <g key={c.index} onMouseEnter={() => setHover(label)} onMouseLeave={() => setHover(null)}>
              <line x1={x} x2={x} y1={sy(c.flux_ujy - c.flux_err_ujy)} y2={sy(c.flux_ujy + c.flux_err_ujy)}
                stroke={color} strokeWidth={1.2} opacity={0.8} />
              <circle cx={x} cy={sy(c.flux_ujy)} r={3.2} fill={color} stroke="#0a0d16" strokeWidth={0.8} />
              <rect x={x - 5} y={M.top} width={10} height={H - M.top - M.bottom} fill="transparent">
                <title>{label}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="spectrum-legend">
        {BAND_COLORS.map((c, i) => (
          <span key={c}><i style={{ background: c }} />D{i + 1}</span>
        ))}
      </div>
      <p className="hint spectrum-hover">{hover ?? "Point at a dot for its values. Faint dots are single exposures."}</p>
    </div>
  );
}
