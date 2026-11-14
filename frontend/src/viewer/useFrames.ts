// Loads the list of exposures for a view, then downloads their pictures a few
// at a time. Frames become playable as soon as they arrive.
import { useEffect, useState } from "react";
import { fetchFrames, loadFrameImage, type FrameList, type LoadedFrame, type View } from "../api/client";

const PARALLEL = 6;
const MIN_COVERAGE = 0.6; // drop frames where the patch is mostly off the detector

export interface FramesState {
  list: FrameList | null;
  frames: LoadedFrame[]; // time ordered
  loaded: number; // pictures finished (including skipped ones)
  total: number;
  loading: boolean;
  error: string | null;
}

const EMPTY: FramesState = { list: null, frames: [], loaded: 0, total: 0, loading: true, error: null };

export function useFrames(view: View, band: number, size: number, reloadKey: number): FramesState {
  const [state, setState] = useState<FramesState>(EMPTY);

  useEffect(() => {
    const abort = new AbortController();
    setState(EMPTY);

    (async () => {
      const list = await fetchFrames(view, band, reloadKey > 0, abort.signal);
      setState((s) => ({ ...s, list, total: list.frames.length, loading: list.frames.length > 0 }));

      const queue = [...list.frames];
      const worker = async () => {
        for (let info = queue.shift(); info; info = queue.shift()) {
          let frame: LoadedFrame | null = null;
          try {
            frame = await loadFrameImage(info, view, size, abort.signal);
          } catch (err) {
            if (abort.signal.aborted) return;
            console.warn(err);
          }
          if (abort.signal.aborted) return;
          setState((s) => {
            const frames =
              frame && frame.coverage >= MIN_COVERAGE
                ? [...s.frames, frame].sort((a, b) => a.mjd - b.mjd)
                : s.frames;
            const loaded = s.loaded + 1;
            return { ...s, frames, loaded, loading: loaded < s.total };
          });
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    })().catch((err) => {
      if (!abort.signal.aborted) {
        setState((s) => ({ ...s, loading: false, error: String(err.message ?? err) }));
      }
    });

    return () => abort.abort();
  }, [view.ra, view.dec, view.fov, band, size, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
