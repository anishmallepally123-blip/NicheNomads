import { useEffect, useMemo, useState } from "react";
import Controls from "./components/Controls";
import StatusBar from "./components/StatusBar";
import ViewerOverlay from "./components/ViewerOverlay";
import BlinkCanvas from "./viewer/BlinkCanvas";
import PlayerControls from "./viewer/PlayerControls";
import { useFrames } from "./viewer/useFrames";
import { usePlayer } from "./viewer/usePlayer";
import { DEFAULT_STATE, useUrlState } from "./state/urlState";
import { formatDec, formatRa } from "./lib/sky";

const IMAGE_SIZE = 384; // pixels requested from the backend per frame

export default function App() {
  const [state, update] = useUrlState();
  const [reloadKey, setReloadKey] = useState(0);
  const [invert, setInvert] = useState(false);
  const [showMarker, setShowMarker] = useState(true);
  const [copied, setCopied] = useState(false);

  const view = useMemo(
    () => ({ ra: state.ra, dec: state.dec, fov: state.fov }),
    [state.ra, state.dec, state.fov],
  );
  const frames = useFrames(view, state.band, IMAGE_SIZE, reloadKey);
  const player = usePlayer(frames.frames.length);
  const current = frames.frames[player.index] ?? null;

  // Keyboard: space = play/pause, arrows = step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        player.toggle();
      } else if (e.key === "ArrowLeft") player.step(-1);
      else if (e.key === "ArrowRight") player.step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  return (
    <div className={state.embed ? "app embed" : "app"}>
      <a className="skip-link" href="#viewer">Skip to the viewer</a>
      {!state.embed && (
        <header className="topbar">
          <div className="brand">
            <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
              <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(-25 16 16)" />
              <circle cx="16" cy="16" r="3.2" fill="currentColor" />
              <circle cx="26.5" cy="11" r="1.8" className="logo-mover" />
            </svg>
            <div>
              <h1>SPHEREx Blink</h1>
              <p className="tagline">Planet X hunter · NASA Space Apps 2026</p>
            </div>
          </div>
          <p className="intro">
            Flip through NASA SPHEREx infrared images of one patch of sky over time. Stars stay put.
            Anything that moves between frames could be a nearby object.
          </p>
        </header>
      )}

      {!state.embed && <Controls state={state} bands={frames.list?.bands ?? []} onChange={update} />}

      <main>
        <section className="viewer" id="viewer" aria-label="Blink viewer">
          <div className="stage">
            <BlinkCanvas
              frame={current}
              view={view}
              invert={invert}
              showMarker={showMarker}
              onRecenter={(ra, dec) => update({ ra, dec })}
            />
            <ViewerOverlay
              frames={frames}
              band={state.band}
              onRetry={() => setReloadKey((k) => k + 1)}
              onBand={(band) => update({ band })}
              onExample={() => update({ ra: DEFAULT_STATE.ra, dec: DEFAULT_STATE.dec, band: DEFAULT_STATE.band })}
            />
          </div>
          <PlayerControls player={player} frames={frames.frames} />
        </section>

        <aside>
          <h2>This view</h2>
          <dl>
            <dt>RA</dt>
            <dd>{formatRa(state.ra)} <span className="muted">({state.ra.toFixed(5)}°)</span></dd>
            <dt>Dec</dt>
            <dd>{formatDec(state.dec)} <span className="muted">({state.dec.toFixed(5)}°)</span></dd>
            <dt>Field</dt>
            <dd>{state.fov}′ × {state.fov}′, north up, east left</dd>
          </dl>
          <label className="check">
            <input type="checkbox" checked={showMarker} onChange={(e) => setShowMarker(e.target.checked)} />
            Mark the target position
          </label>
          <label className="check">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            Invert colours
          </label>
          <p className="hint">
            Scroll to zoom, drag to pan, double-click to re-centre. Space plays or pauses, arrow keys step
            one frame.
          </p>
          <p className="hint">
            Each SPHEREx exposure sees a slightly different wavelength at this spot, so brightness can
            change from frame to frame even for ordinary stars.
          </p>
          <button
            className="copy"
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              });
            }}
            title="Copy a link to exactly this view"
          >
            <span aria-live="polite">{copied ? "Link copied ✓" : "Copy link to this view"}</span>
          </button>
        </aside>
      </main>

      <StatusBar frames={frames} onRefresh={() => setReloadKey((k) => k + 1)} />

      {!state.embed && (
        <footer className="credits">
          SPHEREx data: NASA/JPL-Caltech, served by the{" "}
          <a href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
            NASA/IPAC Infrared Science Archive
          </a>
          . Built for the NASA Space Apps Challenge: Planet X and SPHEREx.
        </footer>
      )}
    </div>
  );
}
