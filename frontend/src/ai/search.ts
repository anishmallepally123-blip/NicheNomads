// Search box helper shared by the homepage and the viewer. Coordinates and
// the built-in target names are read straight away, with no Claude call.
// Anything else ("fast brown dwarf near Orion", "the closest star") goes to
// Claude, which picks an object. If SIMBAD knows that object we use SIMBAD's
// position (moved along its proper motion to today), because a model's
// remembered coordinates can be a little off.
import { resolve, TARGETS } from "../data/targets";
import { lookupName } from "../describe/simbad";
import { mjdNow, positionAt } from "../overlays/motion";
import { askClaude, NotSetUp, parseJsonReply } from "./claude";

export interface SearchHit {
  ra: number;
  dec: number;
  name: string | null;
  band?: number;
  /** Set when Claude picked the place: one sentence saying why. */
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
    text = await askClaude(
      "search",
      {
        query: query.slice(0, 200),
        targets: TARGETS.map((t) => ({ id: t.id, name: t.name, ra: t.ra, dec: t.dec, about: t.note.split(". ")[0] })),
      },
      signal,
    );
  } catch (err) {
    if (err instanceof NotSetUp) {
      throw new Error(
        "Plain-English search isn't switched on yet. Try coordinates like 133.7951 -7.2451, or a test target name like Barnard's Star.",
      );
    }
    throw err;
  }

  const pick = parseJsonReply<{ name: string | null; simbad?: string; ra?: number; dec?: number; target_id?: string | null; why?: string }>(text);
  if (!pick || !pick.name) throw new Error(pick?.why ?? "Couldn't find anything that matches. Try other words or coordinates.");
  const why = pick.why?.slice(0, 200);

  const target = TARGETS.find((t) => t.id === pick.target_id);
  if (target) return { ra: target.ra, dec: target.dec, name: target.name, band: target.suggested_band, why };

  const found = await lookupName(pick.simbad || pick.name, signal).catch(() => null);
  if (found) {
    // SIMBAD positions are J2000; fast movers have drifted since.
    const now = positionAt(found.ra, found.dec, found.pmra, found.pmdec, J2000_MJD, mjdNow());
    return { ra: round6(now.ra), dec: round6(now.dec), name: found.name, why };
  }

  const ra = Number(pick.ra);
  const dec = Number(pick.dec);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || Math.abs(dec) > 90) {
    throw new Error(`Claude suggested ${pick.name}, but we couldn't get a position for it.`);
  }
  return { ra: round6(ra), dec: round6(dec), name: pick.name, why: `${why ?? ""} (Position from Claude, not checked against SIMBAD.)`.trim() };
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
