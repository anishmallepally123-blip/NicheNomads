// Which catalogue layers are on, their data for the current view, and the
// marker the user clicked. Layer choices are remembered in localStorage.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCatalog, type CatalogResult, type CatalogSource, type LayerKey } from "./api";

export const LAYER_KEYS: LayerKey[] = ["gaia", "wise", "ices", "movers"];

export interface LayerStatus {
  loading: boolean;
  error: string | null;
}

export interface Selection {
  layer: LayerKey;
  source: CatalogSource;
}

export interface OverlaysState {
  enabled: Record<LayerKey, boolean>;
  setEnabled: (key: LayerKey, on: boolean) => void;
  followMotion: boolean;
  setFollowMotion: (on: boolean) => void;
  results: Partial<Record<LayerKey, CatalogResult>>;
  status: Partial<Record<LayerKey, LayerStatus>>;
  /** Results of the layers that are switched on and loaded. */
  active: CatalogResult[];
  selected: Selection | null;
  setSelected: (s: Selection | null) => void;
}

const STORE_KEY = "spherex-overlays";
const DEFAULTS = { enabled: { gaia: false, wise: false, ices: false, movers: true }, followMotion: true };

function load(): typeof DEFAULTS {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return { enabled: { ...DEFAULTS.enabled, ...v.enabled }, followMotion: v.followMotion ?? true };
    }
  } catch {
    /* private window or bad data: use defaults */
  }
  return DEFAULTS;
}

export function useOverlays(view: { ra: number; dec: number; fov: number }): OverlaysState {
  const [prefs, setPrefs] = useState(load);
  const [results, setResults] = useState<Partial<Record<LayerKey, CatalogResult>>>({});
  const [status, setStatus] = useState<Partial<Record<LayerKey, LayerStatus>>>({});
  const [selected, setSelected] = useState<Selection | null>(null);
  const viewKey = `${view.ra},${view.dec},${view.fov}`;
  const currentView = useRef(viewKey);
  const requested = useRef(new Set<string>()); // "viewKey|layer" already asked for

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs]);

  // A new view throws away old catalogue answers and the selection.
  useEffect(() => {
    currentView.current = viewKey;
    requested.current.clear();
    setResults({});
    setStatus({});
    setSelected(null);
  }, [viewKey]);

  // Fetch each switched-on layer once per view.
  useEffect(() => {
    for (const key of LAYER_KEYS) {
      const id = `${viewKey}|${key}`;
      if (!prefs.enabled[key] || requested.current.has(id)) continue;
      requested.current.add(id);
      setStatus((s) => ({ ...s, [key]: { loading: true, error: null } }));
      fetchCatalog(key, view.ra, view.dec, view.fov)
        .then((r) => {
          if (currentView.current !== viewKey) return; // the user moved on
          setResults((prev) => ({ ...prev, [key]: r }));
          setStatus((s) => ({ ...s, [key]: { loading: false, error: null } }));
        })
        .catch((err: Error) => {
          if (currentView.current !== viewKey) return;
          requested.current.delete(id); // switching the layer off and on retries
          setStatus((s) => ({ ...s, [key]: { loading: false, error: err.message } }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.enabled, viewKey]);

  const setEnabled = useCallback((key: LayerKey, on: boolean) => {
    setPrefs((p) => ({ ...p, enabled: { ...p.enabled, [key]: on } }));
    if (!on) setSelected((s) => (s?.layer === key ? null : s));
  }, []);

  const setFollowMotion = useCallback((on: boolean) => setPrefs((p) => ({ ...p, followMotion: on })), []);

  const active = useMemo(
    () => LAYER_KEYS.filter((k) => prefs.enabled[k] && results[k]).map((k) => results[k]!),
    [prefs.enabled, results],
  );

  return {
    enabled: prefs.enabled,
    setEnabled,
    followMotion: prefs.followMotion,
    setFollowMotion,
    results,
    status,
    active,
    selected,
    setSelected,
  };
}
