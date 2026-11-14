// Share and embed: copy a link, or an <iframe> snippet for this exact view.
import { useState } from "react";
import { absoluteUrl, type ViewState } from "../state/urlState";

interface Props {
  state: ViewState;
}

export default function EmbedPanel({ state }: Props) {
  const [showPlayer, setShowPlayer] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const link = absoluteUrl(state, { embed: false });
  const embedUrl = absoluteUrl(state, { embed: true, controls: showPlayer });
  const snippet =
    `<iframe src="${embedUrl}" width="560" height="${showPlayer ? 680 : 560}" ` +
    `style="border:0" title="SPHEREx Blink" loading="lazy" allow="fullscreen"></iframe>`;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="embed-panel">
      <button onClick={() => copy("link", link)} title="Copy a link to exactly this view">
        {copied === "link" ? "Copied ✓" : "Copy link to this view"}
      </button>
      <details>
        <summary>Embed on another site</summary>
        <label className="check">
          <input type="checkbox" checked={showPlayer} onChange={(e) => setShowPlayer(e.target.checked)} />
          Show play / frame controls
        </label>
        <textarea readOnly value={snippet} rows={4} onFocus={(e) => e.currentTarget.select()} aria-label="Embed code" />
        <div className="row">
          <button onClick={() => copy("embed", snippet)}>{copied === "embed" ? "Copied ✓" : "Copy embed code"}</button>
          <a href={embedUrl} target="_blank" rel="noreferrer">Preview</a>
        </div>
      </details>
    </div>
  );
}
