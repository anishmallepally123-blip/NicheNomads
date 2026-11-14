import { useEffect, useMemo, useState } from "react";
import Controls from "./components/Controls";
import StatusBar from "./components/StatusBar";
import BlinkCanvas from "./viewer/BlinkCanvas";
import PlayerControls from "./viewer/PlayerControls";
import { useFrames } from "./viewer/useFrames";
import { usePlayer } from "./viewer/usePlayer";
import { useUrlState } from "./state/urlState";
import { formatDec, formatRa } from "./lib/sky";

const IMAGE_SIZE = 384; // pixels requested from the backend per frame

export default function App() {
  const [state, update] = useUrlState();
  const [reloadKey, setReloadKey] = useState(0);
  const [invert, setInvert] = useState(false);
  const [showMarker, setShowMarker] = useState(true);

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
      {!state.embed && (
        <header>
          <h1>SPHEREx Blink</h1>
          <p>
            Flip through NASA SPHEREx infrared images of one patch of sky over time. Stars stay put.
            Anything that moves between frames could be a nearby object.
          </p>
        </header>
      )}

      {!state.embed && <Controls state={state} bands={frames.list?.bands ?? []} onChange={update} />}

      <main>
        <section className="viewer">
          <BlinkCanvas
            frame={current}
            view={view}
            invert={invert}
            showMarker={showMarker}
            onRecenter={(ra, dec) => update({ ra, dec })}
          />
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
            onClick={() => navigator.clipboard?.writeText(window.location.href)}
            title="Copy a link to exactly this view"
          >
            Copy link to this view
          </button>
        </aside>
      </main>

      <StatusBar frames={frames} onRefresh={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}
