// "Where am I on the sky?" panel: a clickable all-sky locator map (RA/Dec grid,
// Milky Way plane, ecliptic, test targets) plus arrow buttons that step the
// view one field north, south, east or west.
import { useMemo, useState } from "react";
import type { Target } from "../api/client";
import { eclipticToEquatorial, formatDec, formatRa, galacticToEquatorial, offsetToSky } from "../lib/sky";

interface Props {
  ra: number;
  dec: number;
  fov: number; // arcmin
  targets: Target[];
  onJump: (ra: number, dec: number) => void;
}

const W = 248;
const H = 124;
// Plate carrée with RA increasing to the left (as on the sky), 24h at the left edge.
const x = (ra: number) => ((360 - ra) / 360) * W;
const y = (dec: number) => ((90 - dec) / 180) * H;

/** Polyline through sky points, broken where it wraps around RA 0h. */
function skyPath(points: { ra: number; dec: number }[]): string {
  let d = "";
  let prevX: number | null = null;
  for (const p of points) {
    const px = x(p.ra);
    const py = y(p.dec);
    d += prevX === null || Math.abs(px - prevX) > W / 2 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`;
    prevX = px;
  }
  return d;
}

export default function SkyNavigator({ ra, dec, fov, targets, onJump }: Props) {
  const [hover, setHover] = useState<{ ra: number; dec: number } | null>(null);

  const guides = useMemo(() => {
    const steps = Array.from({ length: 181 }, (_, i) => i * 2);
    return {
      galactic: skyPath(steps.map((l) => galacticToEquatorial(l, 0))),
      ecliptic: skyPath(steps.map((l) => eclipticToEquatorial(l))),
    };
  }, []);

  const fromEvent = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    return { ra: (((360 - fx * 360) % 360) + 360) % 360, dec: Math.max(-90, Math.min(90, 90 - fy * 180)) };
  };

  // one step = most of a field, so neighbouring views overlap a little
  const step = (fov * 60 * 0.8);
  const nudge = (east: number, north: number) => {
    const p = offsetToSky(ra, dec, east * step, north * step);
    onJump(p.ra, Math.max(-90, Math.min(90, p.dec)));
  };

  return (
    <div className="sky-nav">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="sky-map"
        role="img"
        aria-label="All-sky map. Click anywhere to jump there."
        onClick={(e) => {
          const p = fromEvent(e);
          onJump(+p.ra.toFixed(5), +p.dec.toFixed(5));
        }}
        onMouseMove={(e) => setHover(fromEvent(e))}
        onMouseLeave={() => setHover(null)}
      >
        <rect width={W} height={H} rx="6" className="sky-bg" />
        {[-60, -30, 0, 30, 60].map((d) => (
          <line key={`d${d}`} x1={0} x2={W} y1={y(d)} y2={y(d)} className={d === 0 ? "grid eq" : "grid"} />
        ))}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <line key={`h${h}`} y1={0} y2={H} x1={x(h * 15)} x2={x(h * 15)} className="grid" />
        ))}
        {[0, 6, 12, 18].map((h) => (
          <text key={`t${h}`} x={x(h * 15) + 2} y={H - 3} className="grid-label">{h}h</text>
        ))}
        <path d={guides.galactic} className="milky-way" />
        <path d={guides.ecliptic} className="ecliptic" />
        {targets.map((t) => (
          <circle key={t.id} cx={x(t.ra)} cy={y(t.dec)} r={2.5} className="target-dot">
            <title>{t.name}</title>
          </circle>
        ))}
        <g className="you-are-here" transform={`translate(${x(ra)},${y(dec)})`}>
          <circle r={5} />
          <line x1={-9} x2={-5} y1={0} y2={0} />
          <line x1={5} x2={9} y1={0} y2={0} />
          <line y1={-9} y2={-5} x1={0} x2={0} />
          <line y1={5} y2={9} x1={0} x2={0} />
        </g>
      </svg>
      <div className="sky-legend">
        {hover ? (
          <span>
            {formatRa(hover.ra)} {formatDec(hover.dec)} · click to go
          </span>
        ) : (
          <span>
            <i className="swatch mw" /> Milky Way <i className="swatch ec" /> Ecliptic <i className="swatch tg" /> Test targets
          </span>
        )}
      </div>

      <div className="nudge" role="group" aria-label="Step the view by one field">
        <button onClick={() => nudge(0, 1)} title="Step north" className="n">N ▲</button>
        <button onClick={() => nudge(1, 0)} title="Step east (left on the sky)" className="e">◀ E</button>
        <button onClick={() => nudge(-1, 0)} title="Step west (right on the sky)" className="w">W ▶</button>
        <button onClick={() => nudge(0, -1)} title="Step south" className="s">S ▼</button>
      </div>
    </div>
  );
}
