// Minimal FITS reader for SPHEREx cutouts, in the browser.
//
// A SPHEREx cutout holds IMAGE, FLAGS, VARIANCE, ZODI, then a ~4 MB PSF table
// and a small wavelength table. We only need the first few image extensions,
// so the download is read as a stream and stopped as soon as they have
// arrived. That turns a ~4 MB download into a few kB.

export type Header = Record<string, string | number | boolean>;

export interface Hdu {
  name: string;
  header: Header;
  nx: number;
  ny: number;
  data: Float32Array; // row 0 = FITS row 1 (south for north-up images)
}

const BLOCK = 2880;

function parseCard(card: string, header: Header) {
  const key = card.slice(0, 8).trim();
  let body: string;
  let name = key;
  if (card.slice(8, 10) === "= ") {
    body = card.slice(10);
  } else if (key === "HIERARCH") {
    const eq = card.indexOf("=");
    if (eq < 0) return;
    name = card.slice(9, eq).trim();
    body = card.slice(eq + 1);
  } else {
    return;
  }
  body = body.trim();
  if (body.startsWith("'")) {
    const end = body.indexOf("'", 1);
    header[name] = body.slice(1, end < 0 ? undefined : end).trim();
    return;
  }
  const raw = body.split("/")[0].trim();
  if (raw === "T" || raw === "F") header[name] = raw === "T";
  else if (raw !== "" && !Number.isNaN(Number(raw))) header[name] = Number(raw);
  else header[name] = raw;
}

/** Grows as bytes arrive from the network. */
class ByteStream {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private start = 0; // absolute offset of chunks[0][0]
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(end: number) {
    while (this.start + this.length < end) {
      if (this.done) throw new Error("Cutout file ended early");
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value) {
        this.chunks.push(value);
        this.length += value.length;
      }
    }
  }

  async read(offset: number, size: number): Promise<Uint8Array> {
    await this.fill(offset + size);
    const out = new Uint8Array(size);
    let pos = this.start;
    let written = 0;
    for (const c of this.chunks) {
      const from = Math.max(offset, pos);
      const to = Math.min(offset + size, pos + c.length);
      if (to > from) {
        out.set(c.subarray(from - pos, to - pos), written);
        written += to - from;
      }
      pos += c.length;
      if (pos >= offset + size) break;
    }
    // drop chunks we will never look at again
    while (this.chunks.length && this.start + this.chunks[0].length <= offset + size) {
      this.start += this.chunks[0].length;
      this.length -= this.chunks[0].length;
      this.chunks.shift();
    }
    return out;
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

function toFloat(bytes: Uint8Array, bitpix: number, count: number, header: Header): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count);
  const bscale = typeof header.BSCALE === "number" ? header.BSCALE : 1;
  const bzero = typeof header.BZERO === "number" ? header.BZERO : 0;
  for (let i = 0; i < count; i++) {
    let v: number;
    switch (bitpix) {
      case -32: v = view.getFloat32(i * 4); break;
      case -64: v = view.getFloat64(i * 8); break;
      case 32: v = view.getInt32(i * 4); break;
      case 16: v = view.getInt16(i * 2); break;
      case 8: v = view.getUint8(i); break;
      default: throw new Error(`Unsupported BITPIX ${bitpix}`);
    }
    out[i] = bitpix > 0 ? v * bscale + bzero : v;
  }
  return out;
}

/**
 * Read HDUs from a FITS response until every name in `wanted` has been seen,
 * then stop downloading. Returns the wanted HDUs that were found.
 */
export async function readFitsHdus(res: Response, wanted: string[]): Promise<Record<string, Hdu>> {
  if (!res.body) throw new Error("No response body");
  const stream = new ByteStream(res.body.getReader());
  const found: Record<string, Hdu> = {};
  let offset = 0;
  try {
    for (let index = 0; wanted.some((w) => !(w in found)); index++) {
      const header: Header = {};
      let ended = false;
      while (!ended) {
        const block = await stream.read(offset, BLOCK);
        offset += BLOCK;
        if (index === 0 && offset === BLOCK && String.fromCharCode(...block.subarray(0, 6)) !== "SIMPLE") {
          const text = new TextDecoder().decode(block).trim().slice(0, 120);
          throw new Error(text || "Not a FITS file");
        }
        for (let i = 0; i < 36; i++) {
          const card = String.fromCharCode(...block.subarray(i * 80, i * 80 + 80));
          if (card.startsWith("END ")) {
            ended = true;
            break;
          }
          parseCard(card, header);
        }
      }
      const naxis = Number(header.NAXIS ?? 0);
      const bitpix = Number(header.BITPIX ?? 8);
      let count = naxis > 0 ? 1 : 0;
      for (let i = 1; i <= naxis; i++) count *= Number(header[`NAXIS${i}`]);
      const bytes = (count * Math.abs(bitpix)) / 8 + Number(header.PCOUNT ?? 0);
      const name = String(header.EXTNAME ?? (index === 0 ? "PRIMARY" : "")).trim();
      if (wanted.includes(name) && naxis === 2 && header.XTENSION !== "BINTABLE") {
        const data = await stream.read(offset, (count * Math.abs(bitpix)) / 8);
        found[name] = {
          name,
          header,
          nx: Number(header.NAXIS1),
          ny: Number(header.NAXIS2),
          data: toFloat(data, bitpix, count, header),
        };
      }
      offset += Math.ceil(bytes / BLOCK) * BLOCK;
      // SPHEREx puts every image before the tables, so a table means we are done
      if (header.XTENSION === "BINTABLE") break;
    }
  } finally {
    stream.cancel(); // skip the rest of the file (mostly the PSF table)
  }
  return found;
}
