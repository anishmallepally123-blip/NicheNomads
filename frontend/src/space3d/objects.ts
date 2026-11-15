// What the 3D map shows: the challenge targets plus a few famous stars so
// people have something familiar to steer by. Distances are in light-years.
import { TARGETS } from "../data/targets";
import { curatedNear } from "../describe/curated";

export type Category = "movers" | "variables" | "landmarks";

export const CATEGORIES: { id: Category; label: string; color: string }[] = [
  { id: "movers", label: "Fast movers", color: "--color-accent" },
  { id: "variables", label: "Variable stars", color: "--color-cool" },
  { id: "landmarks", label: "Familiar stars", color: "--color-muted" },
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

export const OBJECTS: MapObject[] = [...targets, ...landmarks];

/** Squash distance so 4 and 2,000 light-years both fit on one screen. */
export const scaleLy = (ly: number) => 6 * Math.log10(1 + ly);

/** Equatorial direction to x/y/z with north up (+y) and RA 0h along +x. */
export function position(o: { ra: number; dec: number; ly: number }): [number, number, number] {
  const r = scaleLy(o.ly);
  const a = (o.ra * Math.PI) / 180;
  const d = (o.dec * Math.PI) / 180;
  return [r * Math.cos(d) * Math.cos(a), r * Math.sin(d), -r * Math.cos(d) * Math.sin(a)];
}
