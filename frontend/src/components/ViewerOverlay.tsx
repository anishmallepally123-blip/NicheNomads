// Sits on top of the sky canvas and explains what is happening while there is
// nothing to blink yet: searching the archive, downloading the first pictures,
// no data here, or an error. Disappears as soon as the first frame is ready.
import type { FramesState } from "../viewer/useFrames";

interface Props {
  frames: FramesState;
  band: number;
  onRetry: () => void;
  onBand: (band: number) => void;
  onExample: () => void;
}

export default function ViewerOverlay({ frames, band, onRetry, onBand, onExample }: Props) {
  const { list, loaded, total, loading, error } = frames;
  const waiting = !error && frames.frames.length === 0 && (loading || !list);

  if (frames.frames.length > 0) return null;

  if (error) {
    return (
      <div className="overlay" role="alert">
        <div className="overlay-card">
          <span className="overlay-icon error-icon" aria-hidden="true">!</span>
          <h3>The archive did not answer</h3>
          <p>{friendlyError(error)}</p>
          <div className="overlay-actions">
            <button className="primary" onClick={onRetry}>Try again</button>
          </div>
        </div>
      </div>
    );
  }

  if (waiting) {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    return (
      <div className="overlay" aria-live="polite" aria-busy="true">
        <div className="overlay-card">
          <div className="orbit" aria-hidden="true"><i /></div>
          <h3>{list ? `Found ${total} exposures. Downloading…` : "Searching the sky…"}</h3>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={list ? pct : undefined} aria-label="Download progress">
            <span className={list ? "" : "indeterminate"} style={list ? { width: `${Math.max(pct, 3)}%` } : undefined} />
          </div>
        </div>
      </div>
    );
  }

  // Finished loading but nothing to show.
  const others = (list?.bands ?? []).filter((b) => b.detector !== band && b.count > 0);
  const noneAnywhere = !list || list.total === 0;
  return (
    <div className="overlay" role="status">
      <div className="overlay-card">
        <span className="overlay-icon" aria-hidden="true">∅</span>
        {noneAnywhere ? (
          <>
            <h3>No SPHEREx images here yet</h3>
            <p>
              SPHEREx maps the whole sky every six months, and new data reaches the archive in
              batches. Try again later, or start with a known target.
            </p>
            <div className="overlay-actions">
              <button className="primary" onClick={onExample}>Show WISE 0855</button>
              <button onClick={onRetry}>Check for new data</button>
            </div>
          </>
        ) : (
          <>
            <h3>Nothing usable in band D{band}</h3>
            <p>
              {list && list.count > 0
                ? "The exposures in this band only clip the edge of this patch."
                : "No exposure in this band covers this patch yet."}{" "}
              {others.length > 0 && "These bands have data:"}
            </p>
            {others.length > 0 && (
              <div className="overlay-actions">
                {others.map((b) => (
                  <button key={b.detector} onClick={() => onBand(b.detector)}>
                    D{b.detector} · {b.count} frames
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function friendlyError(message: string) {
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "We could not reach our server. Check your connection, then try again.";
  }
  if (/busy|503|502|timeout/i.test(message)) {
    return "NASA's archive is busy right now. Waiting a few seconds and trying again usually works.";
  }
  return message;
}
