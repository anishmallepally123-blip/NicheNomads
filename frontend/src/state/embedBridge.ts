// Talks to the page around an embedded viewer (an <iframe>) with postMessage.
//
// The viewer announces every view change:
//   { type: "spherex-blink:view", state: {...}, frame: { obs_id, date, index, count } | null, url }
// The host page can steer it:
//   iframe.contentWindow.postMessage({ type: "spherex-blink:set", ra: 56.75, dec: 24.12, fov: 20 }, "*")
//   iframe.contentWindow.postMessage({ type: "spherex-blink:play" }, "*")   // also "pause", "step" (+ delta)
// Every value goes through the same checks as URL parameters, so bad input is ignored.
import { useEffect, useRef } from "react";
import type { LoadedFrame } from "../api/client";
import type { Player } from "../viewer/usePlayer";
import { absoluteUrl, parseUrl, toQuery, type UpdateFn, type ViewState } from "./urlState";

const SETTABLE: (keyof ViewState)[] = [
  "ra", "dec", "fov", "band", "zoom", "op", "plane", "ref", "n", "gain", "invert", "marker", "controls",
];

export function useEmbedBridge(
  state: ViewState,
  update: UpdateFn,
  player: Player,
  current: LoadedFrame | null,
  frameCount: number,
) {
  const inFrame = window.parent !== window;
  const playerRef = useRef(player);
  playerRef.current = player;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!inFrame) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      const p = playerRef.current;
      switch (msg.type) {
        case "spherex-blink:set": {
          const raw: Partial<ViewState> = {};
          for (const k of SETTABLE) if (k in msg) (raw as Record<string, unknown>)[k] = msg[k];
          // Round-trip through the URL parser to validate and clamp everything.
          const clean = parseUrl("?" + toQuery({ ...stateRef.current, ...raw }));
          const patch: Partial<ViewState> = {};
          for (const k of SETTABLE) if (k in raw) (patch as Record<string, unknown>)[k] = clean[k];
          update(patch);
          break;
        }
        case "spherex-blink:play":
          p.setPlaying(true);
          break;
        case "spherex-blink:pause":
          p.setPlaying(false);
          break;
        case "spherex-blink:step":
          p.step(Number.isFinite(msg.delta) ? Math.round(msg.delta) : 1);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [inFrame, update]);

  // Announce changes, at most a few times a second (playback changes frames quickly).
  useEffect(() => {
    if (!inFrame) return;
    const timer = window.setTimeout(() => {
      window.parent.postMessage(
        {
          type: "spherex-blink:view",
          state,
          frame: current
            ? { obs_id: current.obs_id, date: current.date, index: player.index, count: frameCount }
            : null,
          url: absoluteUrl(state, { embed: false }),
        },
        "*",
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [inFrame, state, current, player.index, frameCount]);
}
