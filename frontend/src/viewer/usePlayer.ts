// Playback state for the blink: which frame is showing, play/pause, speed.
import { useCallback, useEffect, useState } from "react";

export interface Player {
  index: number;
  playing: boolean;
  fps: number;
  setIndex: (i: number) => void;
  step: (delta: number) => void;
  toggle: () => void;
  setFps: (fps: number) => void;
}

export function usePlayer(frameCount: number): Player {
  const [index, setIndexRaw] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(4);

  useEffect(() => {
    if (!playing || frameCount < 2) return;
    const timer = window.setInterval(() => setIndexRaw((i) => (i + 1) % frameCount), 1000 / fps);
    return () => window.clearInterval(timer);
  }, [playing, fps, frameCount]);

  const setIndex = useCallback((i: number) => {
    setPlaying(false);
    setIndexRaw(i);
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (frameCount === 0) return;
      setPlaying(false);
      setIndexRaw((i) => (((i + delta) % frameCount) + frameCount) % frameCount);
    },
    [frameCount],
  );

  const toggle = useCallback(() => setPlaying((p) => !p), []);

  return {
    index: frameCount ? Math.min(index, frameCount - 1) : 0,
    playing,
    fps,
    setIndex,
    step,
    toggle,
    setFps,
  };
}
