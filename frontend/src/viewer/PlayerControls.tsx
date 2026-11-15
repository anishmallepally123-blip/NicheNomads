import type { LoadedFrame } from "../api/client";
import type { Player } from "./usePlayer";
import { formatDate } from "../lib/sky";

interface Props {
  player: Player;
  frames: LoadedFrame[];
}

export default function PlayerControls({ player, frames }: Props) {
  const frame = frames[player.index] ?? null;
  const disabled = frames.length === 0;
  return (
    <div className="player">
      <div className="player-row">
        <button onClick={() => player.step(-1)} disabled={disabled} title="Previous frame (←)">◀ Prev</button>
        <button className="primary" onClick={player.toggle} disabled={disabled} title="Play or pause (space)">
          {player.playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={() => player.step(1)} disabled={disabled} title="Next frame (→)">Next ▶</button>
        <label className="speed">
          Speed
          <input
            type="range" min={1} max={15} step={1} value={player.fps}
            onChange={(e) => player.setFps(Number(e.target.value))}
          />
          <span>{player.fps} fps</span>
        </label>
      </div>
      <input
        className="scrubber"
        type="range" min={0} max={Math.max(0, frames.length - 1)} value={player.index}
        onChange={(e) => player.setIndex(Number(e.target.value))}
        disabled={disabled}
        aria-label="Frame"
      />
      <div className="frame-info">
        {frame ? (
          <>
            <strong>
              Frame {player.index + 1} of {frames.length}
            </strong>
            <span>{formatDate(frame.date)}</span>
            {frame.wavelength !== null && <span>{frame.wavelength.toFixed(2)} µm</span>}
            <span className="muted">{frame.obs_id}</span>
          </>
        ) : (
          <span className="muted">No frames yet</span>
        )}
      </div>
    </div>
  );
}
