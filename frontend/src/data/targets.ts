// Test targets from the challenge page, plus coordinate parsing.
// To add a target, add one entry to TARGETS. Coordinates are ICRS degrees.

export interface Target {
  id: string;
  name: string;
  ra: number;
  dec: number;
  note: string;
  suggested_band: number;
}

/** Read "08h55m10.8s", "08:55:10.8" or "08 55 10.8" style text as a number of
 *  hours/degrees. Returns NaN when it cannot. */
function sexagesimal(text: string): number {
  const t = text.trim();
  const sign = t.startsWith("-") ? -1 : 1;
  const parts = t.replace(/^[+-]/, "").split(/[hdms:°'"\s]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return NaN;
  const [a, b = 0, c = 0] = parts;
  return sign * (a + b / 60 + c / 3600);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Turn user text into [ra_deg, dec_deg].
 * Accepts "133.795 -7.245" (degrees), "08h55m10.8s -07d14m42s" and
 * "08:55:10.8 -07:14:42" (hours for RA when written with h or colons).
 * Throws when the text cannot be read.
 */
export function parseCoordinates(input: string): [number, number] {
  const text = input.trim().replace(/,/g, " ");
  if (!text) throw new Error("Empty coordinates");
  const isSexa = /[hms:]/.test(text);
  let raText: string;
  let decText: string;
  const tokens = text.split(/\s+/);
  if (tokens.length === 2) {
    [raText, decText] = tokens;
  } else if (tokens.length === 6) {
    raText = tokens.slice(0, 3).join(":");
    decText = tokens.slice(3).join(":");
  } else {
    // "08h55m10s -07d14m42s" with odd spacing: split before the sign of Dec
    const m = text.match(/^(.*?\S)\s*([+-]\s*\d.*)$/);
    if (!m) throw new Error(`Could not read coordinates: "${input}"`);
    [raText, decText] = [m[1], m[2].replace(/\s+/, "")];
  }
  let ra = isSexa || tokens.length === 6 ? sexagesimal(raText) * 15 : Number(raText);
  const dec = isSexa || tokens.length === 6 ? sexagesimal(decText) : Number(decText);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90 || ra < 0 || ra > 360) {
    throw new Error(`Could not read coordinates: "${input}"`);
  }
  ra = ra % 360;
  return [ra, dec];
}

function target(id: string, name: string, coord: string, note: string, band: number): Target {
  const [ra, dec] = parseCoordinates(coord);
  return { id, name, ra: round6(ra), dec: round6(dec), note, suggested_band: band };
}

// Fast movers are no longer at their catalogue (J2000) positions. Barnard's Star
// and Epsilon Indi B are listed near where they are in 2026 so they sit inside
// the default view. WISE 0855 uses the exact coordinates from the challenge page.
export const TARGETS: Target[] = [
  target("wise0855", "WISE 0855-0714", "08h55m10.831s -07d14m42.53s",
    "Very cold brown dwarf 7.4 light years away, moving about 8 arcsec per year. " +
      "These are the challenge's 2014 coordinates, so today it sits roughly 1.6 arcmin " +
      "to the west (right) of the marker.", 6),
  target("barnard", "Barnard's Star", "17h57m47.10s +04d46m00.3s",
    "Fastest moving star in the sky, about 10 arcsec per year (approximate 2026 position).", 3),
  target("epsindb", "Epsilon Indi B", "22h04m23.0s -56d48m04s",
    "Brown dwarf pair orbiting Epsilon Indi, moving about 4.7 arcsec per year " +
      "(approximate 2026 position).", 3),
  target("rwaur", "RW Aurigae", "05h07m49.54s +30d24m05.1s",
    "Young variable star that dims unpredictably.", 2),
  target("rdra", "R Draconis", "16h32m40.23s +66d45m17.9s",
    "Mira variable with a period of about 246 days.", 3),
];

export function findTarget(text: string): Target | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = norm(text);
  for (const t of TARGETS) {
    const names = [t.id, norm(t.name)];
    if (names.includes(key) || (key.length >= 4 && names.some((n) => n.startsWith(key)))) return t;
  }
  return null;
}

/** What the user typed (a target name or coordinates) -> position. */
export function resolve(q: string): { ra: number; dec: number; name: string | null } {
  const known = findTarget(q);
  if (known) return { ra: known.ra, dec: known.dec, name: known.name };
  const [ra, dec] = parseCoordinates(q);
  return { ra: round6(ra), dec: round6(dec), name: null };
}
