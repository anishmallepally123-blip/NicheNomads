// Sky coordinates <-> pixel positions for SPHEREx images (FITS TAN-SIP WCS).
// Pixel positions are FITS style: the centre of the first pixel is (1, 1).

import type { Header } from "./fits";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Gnomonic (TAN) projection: sky -> plane, degrees. xi points east, eta north. */
export function tanProject(ra: number, dec: number, ra0: number, dec0: number): [number, number] {
  const a = (ra - ra0) * D2R;
  const d = dec * D2R;
  const d0 = dec0 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
  const xi = (Math.cos(d) * Math.sin(a)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc;
  return [xi * R2D, eta * R2D];
}

/** Inverse of tanProject. */
export function tanDeproject(x: number, y: number, ra0: number, dec0: number): [number, number] {
  const xi = x * D2R;
  const eta = y * D2R;
  const d0 = dec0 * D2R;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  let ra = ra0 + Math.atan2(xi, den) * R2D;
  ra = ((ra % 360) + 360) % 360;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) * R2D;
  return [ra, dec];
}

type Poly = { order: number; c: Float64Array };

function readPoly(h: Header, name: string): Poly | null {
  const order = Number(h[`${name}_ORDER`] ?? 0);
  if (!order) return null;
  const c = new Float64Array((order + 1) * (order + 1));
  for (let p = 0; p <= order; p++)
    for (let q = 0; p + q <= order; q++) c[p * (order + 1) + q] = Number(h[`${name}_${p}_${q}`] ?? 0);
  return { order, c };
}

function evalPoly(poly: Poly, u: number, v: number): number {
  const n = poly.order + 1;
  let sum = 0;
  let up = 1;
  for (let p = 0; p < n; p++) {
    let vq = 1;
    for (let q = 0; p + q < n; q++) {
      sum += poly.c[p * n + q] * up * vq;
      vq *= v;
    }
    up *= u;
  }
  return sum;
}

export class SipWcs {
  private crpix: [number, number];
  private crval: [number, number];
  private cd: [number, number, number, number];
  private inv: [number, number, number, number];
  private a: Poly | null;
  private b: Poly | null;
  private ap: Poly | null;
  private bp: Poly | null;

  constructor(h: Header) {
    const n = (k: string, d = 0) => (typeof h[k] === "number" ? (h[k] as number) : d);
    this.crpix = [n("CRPIX1"), n("CRPIX2")];
    this.crval = [n("CRVAL1"), n("CRVAL2")];
    if ("CD1_1" in h) {
      this.cd = [n("CD1_1"), n("CD1_2"), n("CD2_1"), n("CD2_2")];
    } else {
      const c1 = n("CDELT1", 1);
      const c2 = n("CDELT2", 1);
      this.cd = [c1 * n("PC1_1", 1), c1 * n("PC1_2"), c2 * n("PC2_1"), c2 * n("PC2_2", 1)];
    }
    const [a, b, c, d] = this.cd;
    const det = a * d - b * c;
    this.inv = [d / det, -b / det, -c / det, a / det];
    const sip = String(h.CTYPE1 ?? "").endsWith("-SIP");
    this.a = sip ? readPoly(h, "A") : null;
    this.b = sip ? readPoly(h, "B") : null;
    this.ap = sip ? readPoly(h, "AP") : null;
    this.bp = sip ? readPoly(h, "BP") : null;
  }

  pixToWorld(px: number, py: number): [number, number] {
    let u = px - this.crpix[0];
    let v = py - this.crpix[1];
    if (this.a && this.b) {
      const du = evalPoly(this.a, u, v);
      const dv = evalPoly(this.b, u, v);
      u += du;
      v += dv;
    }
    const [a, b, c, d] = this.cd;
    return tanDeproject(a * u + b * v, c * u + d * v, this.crval[0], this.crval[1]);
  }

  worldToPix(ra: number, dec: number): [number, number] {
    const [x, y] = tanProject(ra, dec, this.crval[0], this.crval[1]);
    const [a, b, c, d] = this.inv;
    const U = a * x + b * y;
    const V = c * x + d * y;
    let u = U;
    let v = V;
    if (this.ap && this.bp) {
      u = U + evalPoly(this.ap, U, V);
      v = V + evalPoly(this.bp, U, V);
    } else if (this.a && this.b) {
      // no inverse polynomial in the file: solve u + A(u, v) = U by iteration
      for (let i = 0; i < 20; i++) {
        u = U - evalPoly(this.a, u, v);
        v = V - evalPoly(this.b, u, v);
      }
    }
    return [u + this.crpix[0], v + this.crpix[1]];
  }
}
