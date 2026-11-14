// Quality flags: which SPHEREx pixels to trust.
//
// Every SPHEREx image has a FLAGS plane: a bitmask per pixel, with each bit
// named in the header (MSKNnnnn = name, MSKDnnnn = description). Names are read
// from the header, so a release that moves bits keeps working.
// Not every flag means "bad": SOURCE marks known stars (40-50 % of pixels),
// FULLSAMPLE and OUTLIER are informational. BAD_FLAGS is the conservative set
// used for photometry in the IRSA SPHEREx tutorials: those pixels are left out
// of co-adds and spectra and only filled in for display.
import type { Header, Hdu } from "./fits";

export const BAD_FLAGS = [
  "TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA",
  "HOT", "COLD", "NONLINEAR", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT",
  "STREAK", "PERSIST", "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO",
];

// DR1 bit numbers, only used when a header has no MSKN keywords.
const DEFAULT_BITS: Record<number, string> = {
  0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC",
  9: "MISSING_DATA", 10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS",
  15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE",
  22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM",
  27: "SNOWBALL", 28: "HALO",
};

/** {bit: [name, description]} from the FLAGS header. */
export function flagDefinitions(h?: Header): Map<number, [string, string]> {
  const defs = new Map<number, [string, string]>();
  for (const key of Object.keys(h ?? {})) {
    const m = key.match(/^MSKN(\d+)$/);
    if (m) defs.set(Number(m[1]), [String(h![key]).trim(), String(h![`MSKD${m[1]}`] ?? "").trim()]);
  }
  if (!defs.size) for (const [b, n] of Object.entries(DEFAULT_BITS)) defs.set(Number(b), [n, ""]);
  return new Map([...defs].sort((a, b) => a[0] - b[0]));
}

export function badBitmask(h?: Header): number {
  let mask = 0;
  for (const [bit, [name]] of flagDefinitions(h)) if (BAD_FLAGS.includes(name)) mask |= 1 << bit;
  return mask;
}

export function flagValues(flags: Hdu): Int32Array {
  return flags.ints ?? Int32Array.from(flags.data);
}

/** Flag names set in one pixel value. */
export function namesIn(value: number, h?: Header): string[] {
  return [...flagDefinitions(h)].filter(([bit]) => (value >>> bit) & 1).map(([, [name]]) => name);
}

export interface FlagCount {
  bit: number;
  name: string;
  description: string;
  pixels: number;
  fraction: number;
  bad: boolean;
}

/** How many pixels carry each flag. */
export function summarize(values: Int32Array, h?: Header): FlagCount[] {
  const total = Math.max(1, values.length);
  const out: FlagCount[] = [];
  for (const [bit, [name, description]] of flagDefinitions(h)) {
    let n = 0;
    for (const v of values) if ((v >>> bit) & 1) n++;
    if (n) out.push({ bit, name, description, pixels: n, fraction: Math.round((n / total) * 1e4) / 1e4, bad: BAD_FLAGS.includes(name) });
  }
  return out;
}
