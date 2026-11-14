// "Live" strip: how fresh the data is, loading progress, refresh button.
import type { FramesState } from "../viewer/useFrames";
import { formatDate } from "../lib/sky";

interface Props {
  frames: FramesState;
  onRefresh: () => void;
}

export default function StatusBar({ frames, onRefresh }: Props) {
  const { list, loaded, total, loading, error } = frames;
  return (
    <div className="status">
      {error ? (
        <span className="error" role="alert">Could not load data: {error}</span>
      ) : !list ? (
        <span>Asking the NASA archive which SPHEREx images cover this spot…</span>
      ) : list.total === 0 ? (
        <span>SPHEREx has no public images of this position yet.</span>
      ) : (
        <>
          <span className="live">
            <i className="dot" /> Latest observation here: {list.latest ? formatDate(list.latest.date) : "n/a"}
          </span>
          <span className="muted">
            {list.total} exposures in all bands · source {list.latest?.collection.replace("spherex_", "SPHEREx ").toUpperCase()}
          </span>
          {loading && (
            <span className="progress">
              Loading {loaded}/{total}
              <progress value={loaded} max={total || 1} />
            </span>
          )}
        </>
      )}
      <button onClick={onRefresh} title="Ask the archive again for new observations">↻ Check for new data</button>
    </div>
  );
}
