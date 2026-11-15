// Search box helper shared by the homepage and the viewer. Coordinates and
// the built-in target names are read straight away, with no model call.
// Anything else ("fast brown dwarf near Orion", "the closest star") goes to
// Niche, the small model running in the browser, which names an object. We
// then look that name up in SIMBAD and use SIMBAD's position (moved along its
// proper motion to today).
import { resolve, TARGETS } from "../data/targets";
import { lookupName } from "../describe/simbad";
import { mjdNow, positionAt } from "../overlays/motion";
import { askNiche, NicheUnavailable, parseJsonReply } from "./niche";

export interface SearchHit {
  ra: number;
  dec: number;
  name: string | null;
  band?: number;
  /** Set when Niche picked the place: one sentence saying why. */
  why?: string;
}

const J2000_MJD = 51544.5;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export async function smartResolve(query: string, signal?: AbortSignal): Promise<SearchHit> {
  let plainError: Error;
  try {
    const hit = resolve(query);
    const known = TARGETS.find((t) => t.ra === hit.ra && t.dec === hit.dec);
    return { ...hit, band: known?.suggested_band };
  } catch (err) {
    plainError = err as Error;
  }
  // Numbers only: it was meant as coordinates, so show the parsing error.
  if (!/[a-z]{3}/i.test(query)) throw plainError;

  let text: string;
  try {
    text = await askNiche(
      [
        {
          role: "system",
          content:
            "The user describes something in the sky. Name the one real astronomical object that fits best. " +
            "If one of these built-in targets fits, use its exact name: " +
            TARGETS.map((t) => `${t.name} (${t.note.split(". ")[0]})`).join("; ") +
            '. Reply with JSON only, like {"name": "Proxima Centauri", "why": "It is the closest star to the Sun."}. ' +
            "The name must be one the SIMBAD database knows. The why is one short sentence. " +
            'If nothing fits, reply {"name": null, "why": "<short reason>"}.',
        },
        { role: "user", content: query.slice(0, 200) },
      ],
      80,
    );
  } catch (err) {
    if (err instanceof NicheUnavailable) {
      throw new Error(`${err.message} Search still takes coordinates like 133.7951 -7.2451, or a name like Barnard's Star.`);
    }
    throw err;
  }

  // A small model's guesses need checking: we only accept a built-in target
  // or a name SIMBAD can find, and always take SIMBAD's position, never one
  // the model remembers.
  const pick = parseJsonReply<{ name?: string | null; why?: string }>(text);
  const name = typeof pick?.name === "string" ? pick.name.trim().slice(0, 80) : "";
  if (!name) throw new Error(pick?.why ?? "Couldn't find anything that matches. Try other words, a name, or coordinates.");
  const why = typeof pick?.why === "string" ? pick.why.slice(0, 200) : undefined;

  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = TARGETS.find((t) => norm(t.name) === norm(name) || norm(t.id) === norm(name));
  if (target) return { ra: target.ra, dec: target.dec, name: target.name, band: target.suggested_band, why };

  const found = await lookupName(name, signal).catch(() => null);
  if (!found) throw new Error(`Niche suggested "${name}", but SIMBAD doesn't know that name. Try other words, a name, or coordinates.`);
  // SIMBAD positions are J2000; fast movers have drifted since.
  const now = positionAt(found.ra, found.dec, found.pmra, found.pmdec, J2000_MJD, mjdNow());
  return { ra: round6(now.ra), dec: round6(now.dec), name: found.name, why };
}

// The "why" sentence survives the jump from the homepage to the viewer.
const NOTE_KEY = "nsd-search-note";
export function rememberSearchNote(hit: SearchHit) {
  try {
    if (hit.why) sessionStorage.setItem(NOTE_KEY, JSON.stringify({ ra: hit.ra, dec: hit.dec, why: hit.why }));
    else sessionStorage.removeItem(NOTE_KEY);
  } catch {
    /* storage blocked: the note is optional */
  }
}
export function readSearchNote(ra: number, dec: number): string | null {
  try {
    const n = JSON.parse(sessionStorage.getItem(NOTE_KEY) ?? "null") as { ra: number; dec: number; why: string } | null;
    return n && Math.abs(n.ra - ra) < 1e-4 && Math.abs(n.dec - dec) < 1e-4 ? n.why : null;
  } catch {
    return null;
  }
}
