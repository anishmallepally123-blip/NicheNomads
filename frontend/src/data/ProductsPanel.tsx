// Side-panel section: the parts of a SPHEREx exposure file you can look at,
// which data release the frame on screen comes from, and IRSA's own SPHEREx
// tools for going further.
import type { LoadedFrame } from "../api/client";
import Info from "../glossary/Info";
import type { Plane, UpdateFn } from "../state/urlState";
import { productsAt } from "./irsa";

const IRSA = "https://irsa.ipac.caltech.edu";

const PLANE_LABELS: [Plane, string][] = [
  ["sky", "Sky"],
  ["zodi", "Background"],
  ["noise", "Noise"],
  ["flags", "Problem pixels"],
];

const PLANE_HINTS: Record<Plane, string> = {
  sky: "The picture with the zodiacal glow taken away and problem pixels patched.",
  zodi: "SPHEREx's model of sunlight scattered by dust in the solar system. It is what gets subtracted from every picture.",
  noise: "How uncertain each pixel is, from the variance map in the file. Brighter means less trustworthy.",
  flags: "White pixels carry a problem flag (cosmic ray hit, dead pixel, glare) and are left out of measurements.",
};

const TOOLS: [string, string, string][] = [
  ["SPHEREx Data Explorer", "/applications/spherex", "Search and preview every SPHEREx product."],
  ["Spectrophotometry Tool", "/applications/spherex/tool-spectrophotometry", "IRSA's official spectrum for a position."],
  ["Mosaic Tool", "/applications/spherex/tool-mosaic", "Stitch many exposures into one deep picture."],
  ["Cutout Tool", "/data/SPHEREx/docs/cutout_tool.html", "Cut small pieces out of the full files."],
  ["Source Discovery Tool", "https://caltech-ipac.github.io/irsa-tutorials/spherex-source-discovery-tool-demo/", "Find sources with SPHEREx data alone."],
  ["Moving Object Search (MOST)", "/applications/MOST", "Find SPHEREx pictures of an asteroid or comet."],
  ["SPHEREx catalogues", "/cgi-bin/Gator/nph-scan?mission=irsa&submit=Select&projshort=SPHEREX", "Tables, including the SPLICES ice targets."],
  ["Comet 3I/ATLAS", "/data/SPHEREx/docs/comet3iatlas/index.html", "SPHEREx pictures of the interstellar comet."],
  ["Spectral calibrations", "/data/SPHEREx/docs/spherex_spectral_calibrations.html", "Channel maps and response curves."],
  ["Cloud copies (AWS)", "/cloud_access/#spherex", "Every file, free to read from Amazon S3."],
  ["Explanatory Supplement", "/data/SPHEREx/docs/SPHEREx_Expsupp.pdf", "The full handbook (PDF)."],
];

/** "spherex_dr1" -> "Data Release 1", "spherex_qr2" -> "Quick Release 2". */
export function releaseName(collection: string) {
  const m = /(dr|qr)(\d+)/i.exec(collection);
  if (!m) return collection;
  return `${m[1].toLowerCase() === "dr" ? "Data Release" : "Quick Release"} ${m[2]}`;
}

interface Props {
  plane: Plane;
  frame: LoadedFrame | null;
  view: { ra: number; dec: number };
  onChange: UpdateFn;
}

export default function ProductsPanel({ plane, frame, view, onChange }: Props) {
  // known once the image search for this view has come back, which is before any frame shows
  const cube = frame ? productsAt(view.ra, view.dec).find((p) => p.type === "cube") : undefined;
  const file = frame?.access_url.split("/").pop()?.split("?")[0];
  return (
    <div className="products">
      <h2>What's in each exposure<Info term="spectralImage" /></h2>
      <div className="segmented" role="radiogroup" aria-label="Part of the exposure to show">
        {PLANE_LABELS.map(([p, text]) => (
          <button
            key={p}
            role="radio"
            aria-checked={plane === p}
            className={plane === p ? "active" : ""}
            onClick={() => onChange({ plane: p })}
          >
            {text}
          </button>
        ))}
      </div>
      <p className="hint">
        {PLANE_HINTS[plane]}
        {plane !== "sky" && <Info term={plane === "zodi" ? "zodi" : plane === "noise" ? "variance" : "flags"} />}
      </p>

      {frame && (
        <dl>
          <dt>Release<Info term="release" /></dt>
          <dd>
            {releaseName(frame.collection)}
            {frame.release_date && <span className="muted"> · public {frame.release_date.slice(0, 10)}</span>}
          </dd>
          <dt>File</dt>
          <dd className="products-file">
            <a href={frame.access_url} target="_blank" rel="noreferrer" title="The whole exposure as IRSA serves it, all planes included">
              {file ?? "Download"}
            </a>
            <div className="muted">Full exposure, about 65 MB of FITS<Info term="fits" /></div>
          </dd>
          {cube && (
            <>
              <dt>All-sky cube<Info term="cube" /></dt>
              <dd className="products-file">
                <a href={cube.access_url} target="_blank" rel="noreferrer">{releaseName(cube.collection)} cube for this patch</a>
                <div className="muted">
                  All 102 colours stacked{cube.size_kb ? `, about ${Math.round(cube.size_kb / 1024)} MB` : ""}
                </div>
              </dd>
            </>
          )}
        </dl>
      )}

      <details className="products-tools">
        <summary>IRSA's SPHEREx tools</summary>
        <ul>
          {TOOLS.map(([name, href, what]) => (
            <li key={name}>
              <a href={href.startsWith("http") ? href : IRSA + href} target="_blank" rel="noreferrer">{name}</a>
              <span className="muted"> {what}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
