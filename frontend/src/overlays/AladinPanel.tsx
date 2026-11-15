// Optional reference view of the same patch in Aladin Lite (CDS, Strasbourg),
// with other surveys (WISE, 2MASS, DSS) to compare against. The library is
// about 2 MB, so it is only downloaded when the panel is opened.
import { useEffect, useRef, useState } from "react";
import { IRSA_BASE } from "../data/irsa";

const ALADIN_URL = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";

// IRSA's all-sky SPHEREx DR1 map. It is a 102-colour cube; Aladin Lite shows
// its first colour. IRSA sends no CORS headers, so it goes through our proxy.
const SPHEREX_HIPS = "/data/hips/SPHEREx/spherex_allsky_cube";
const spherexHips = () =>
  IRSA_BASE.startsWith("http") ? IRSA_BASE + SPHEREX_HIPS : window.location.origin + IRSA_BASE + SPHEREX_HIPS;

const SURVEYS = [
  { id: "spherex", label: "SPHEREx DR1 all-sky map (0.75 µm)" },
  { id: "CDS/P/allWISE/color", label: "WISE (infrared colour)" },
  { id: "CDS/P/2MASS/color", label: "2MASS (near infrared)" },
  { id: "CDS/P/DSS2/color", label: "DSS (visible, 1950s to 1990s)" },
  { id: "CDS/P/PanSTARRS/DR1/color-z-zg-g", label: "Pan-STARRS (visible)" },
];

interface Props {
  ra: number;
  dec: number;
  fov: number; // arcmin
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AladinLib = any;
let libPromise: Promise<AladinLib> | null = null;

function loadAladin(): Promise<AladinLib> {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ ALADIN_URL)
      .then(async (m) => {
        const A = m.default;
        await A.init;
        return A;
      })
      .catch((err) => {
        libPromise = null;
        throw err;
      });
  }
  return libPromise;
}

const DEFAULT_SURVEY = "CDS/P/allWISE/color";
/** Survey id or HiPS address that Aladin understands. */
const hipsFor = (id: string, local = true) =>
  id === "spherex" ? (local ? spherexHips() : `https://irsa.ipac.caltech.edu${SPHEREX_HIPS}`) : id;

export function aladinLink(ra: number, dec: number, fov: number, survey = DEFAULT_SURVEY) {
  const target = encodeURIComponent(`${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`);
  return `https://aladin.cds.unistra.fr/AladinLite/?target=${target}&fov=${(fov / 60).toFixed(4)}&survey=${encodeURIComponent(hipsFor(survey, false))}`;
}

export default function AladinPanel({ ra, dec, fov }: Props) {
  const [open, setOpen] = useState(false);
  const [survey, setSurvey] = useState(DEFAULT_SURVEY);
  const [error, setError] = useState<string | null>(null);
  const divRef = useRef<HTMLDivElement>(null);
  const aladin = useRef<AladinLib>(null);

  // create the widget the first time the panel opens
  useEffect(() => {
    if (!open || aladin.current || !divRef.current) return;
    let cancelled = false;
    loadAladin()
      .then((A) => {
        if (cancelled || !divRef.current) return;
        aladin.current = A.aladin(divRef.current, {
          survey: hipsFor(survey),
          fov: fov / 60,
          target: `${ra} ${dec}`,
          cooFrame: "ICRSd",
          showReticle: true,
          showLayersControl: false,
          showGotoControl: false,
          showFullscreenControl: false,
          showShareControl: false,
          showSimbadPointerControl: true,
          showCooGridControl: false,
          showProjectionControl: false,
          showFrame: false,
          showZoomControl: true,
        });
        setError(null);
      })
      .catch(() => !cancelled && setError("Could not load Aladin Lite. Use the link below instead."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // follow the main viewer
  useEffect(() => {
    if (!aladin.current) return;
    aladin.current.gotoRaDec(ra, dec);
    aladin.current.setFoV(fov / 60);
  }, [ra, dec, fov]);

  useEffect(() => {
    aladin.current?.setImageSurvey(hipsFor(survey));
  }, [survey]);

  return (
    <details className="aladin-panel" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Compare with other sky surveys</summary>
      <label className="aladin-survey">
        Survey
        <select value={survey} onChange={(e) => setSurvey(e.target.value)}>
          {SURVEYS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </label>
      <div ref={divRef} className="aladin-view" />
      {error && <p className="overlay-error">{error}</p>}
      <p className="hint">
        Aladin Lite by CDS, Strasbourg.{" "}
        <a href={aladinLink(ra, dec, fov, survey)} target="_blank" rel="noreferrer">Open full screen</a>
      </p>
    </details>
  );
}
