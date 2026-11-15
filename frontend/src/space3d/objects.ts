// What the 3D map shows: the challenge targets plus a few famous stars so
// people have something familiar to steer by. Distances are in light-years.
import { TARGETS } from "../data/targets";
import { curatedNear } from "../describe/curated";

export type Category = "movers" | "variables" | "landmarks" | "imap";

export const CATEGORIES: { id: Category; label: string; color: string }[] = [
  { id: "movers", label: "Fast movers", color: "--color-accent" },
  { id: "variables", label: "Variable stars", color: "--color-cool" },
  { id: "landmarks", label: "Familiar stars", color: "--color-muted" },
  { id: "imap", label: "IMAP: our heliosphere", color: "--color-sky-mw" },
];

export interface MapObject {
  id: string;
  name: string;
  category: Category;
  ra: number;
  dec: number;
  ly: number;
  kind: string;
  note: string;
  band?: number;
  /** Fixed map position, for things that are a direction rather than a star. */
  at?: [number, number, number];
  /** Replaces the "N light-years from the Sun" line. */
  distText?: string;
  /** Not something to open in the sky viewer. */
  noViewer?: boolean;
}

// The curated text gives rounded distances; these are the numbers we plot.
const TARGET_LY: Record<string, number> = { wise0855: 7.4, barnard: 6, epsindb: 11.9, rwaur: 500, rdra: 2000 };
const TARGET_CAT: Record<string, Category> = {
  wise0855: "movers", barnard: "movers", epsindb: "movers", rwaur: "variables", rdra: "variables",
};

const targets: MapObject[] = TARGETS.map((t) => {
  const c = curatedNear(t.ra, t.dec);
  return {
    id: t.id, name: t.name, category: TARGET_CAT[t.id] ?? "movers",
    ra: t.ra, dec: t.dec, ly: TARGET_LY[t.id] ?? 100,
    kind: c?.kind ?? "Challenge target", note: c?.text ?? t.note, band: t.suggested_band,
  };
});

const landmarks: MapObject[] = [
  { id: "alphacen", name: "Alpha Centauri", ra: 219.9, dec: -60.835, ly: 4.37, kind: "Closest star system", note: "Three stars, including Proxima Centauri, the closest star to the Sun." },
  { id: "sirius", name: "Sirius", ra: 101.287, dec: -16.716, ly: 8.6, kind: "Brightest star at night", note: "A hot white star with a tiny white dwarf partner." },
  { id: "vega", name: "Vega", ra: 279.235, dec: 38.784, ly: 25, kind: "Bright summer star", note: "A young blue-white star ringed by dust, the zero point of many brightness scales." },
  { id: "betelgeuse", name: "Betelgeuse", ra: 88.793, dec: 7.407, ly: 550, kind: "Red supergiant", note: "Orion's shoulder. A huge, cool star near the end of its life." },
].map((o) => ({ ...o, category: "landmarks" as const }));

/** Ecliptic longitude/latitude (degrees) to RA/Dec (J2000). */
function eclToEq(lon: number, lat: number): { ra: number; dec: number } {
  const r = Math.PI / 180, e = 23.4393 * r, l = lon * r, b = lat * r;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  return { ra: ((ra / r) % 360 + 360) % 360, dec: dec / r };
}

/** Where the interstellar wind comes from: neutral helium inflow measured by
 *  IBEX (McComas et al. 2015), ecliptic longitude 255.7 deg, latitude 5.1 deg.
 *  NASA's IMAP (launched 2025) is measuring it again with IMAP-Lo. */
export const UPWIND = eclToEq(255.7, 5.1);
/** Heliosphere nose radius on the map. The real one (~120 au) would be a
 *  speck, so it is drawn enlarged. */
export const HELIO_R = 1.1;

const unit = (ra: number, dec: number): [number, number, number] => {
  const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(a), Math.sin(d), -Math.cos(d) * Math.sin(a)];
};
export const UPWIND_DIR = unit(UPWIND.ra, UPWIND.dec);
const along = (k: number) => UPWIND_DIR.map((c) => c * k) as [number, number, number];

const imap: MapObject[] = [
  {
    id: "heliosphere", name: "Heliosphere", category: "imap", ...UPWIND, ly: 0.0019, at: along(HELIO_R),
    kind: "The Sun's bubble (drawn enlarged)", distText: "Nose about 120 au away, 0.002 light-years",
    note: "The solar wind blows a bubble into the gas between the stars. Its edge, the heliopause, is about 120 au " +
      "from the Sun on the side facing the interstellar wind, with a long tail behind. NASA's IMAP, parked near " +
      "the Sun-Earth L1 point, maps this edge by catching neutral atoms that fly in from it.",
    noViewer: true,
  },
  {
    id: "isnwind", name: "Interstellar wind", category: "imap", ...UPWIND, ly: 0, at: along(4.2),
    kind: "Direction, not a star", distText: "Neutral helium arriving at about 26 km/s",
    note: "The Sun moves through a thin interstellar cloud, so its atoms stream past us like a wind. This arrow " +
      "points to where it comes from (in Ophiuchus, near the galactic centre direction). IMAP-Lo samples these atoms " +
      "to learn what the cloud is made of. Open it in the viewer to see that patch of sky.",
  },
];

export const OBJECTS: MapObject[] = [...targets, ...landmarks, ...imap];

/** Squash distance so 4 and 2,000 light-years both fit on one screen. */
export const scaleLy = (ly: number) => 6 * Math.log10(1 + ly);

/** Equatorial direction to x/y/z with north up (+y) and RA 0h along +x. */
export function position(o: { ra: number; dec: number; ly: number; at?: [number, number, number] }): [number, number, number] {
  if (o.at) return o.at;
  const r = scaleLy(o.ly);
  const a = (o.ra * Math.PI) / 180;
  const d = (o.dec * Math.PI) / 180;
  return [r * Math.cos(d) * Math.cos(a), r * Math.sin(d), -r * Math.cos(d) * Math.sin(a)];
}
