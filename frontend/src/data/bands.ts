// The 102 SPHEREx spectral channels: 6 detectors (bands) x 17 channels of
// equal resolving power, spaced evenly in log(wavelength) inside each band.
// Band edges and R are the published DR1 values. Channel index (0..101) =
// 17 * (band - 1) + (channel - 1).

export const CHANNELS_PER_BAND = 17;

export const BANDS: Record<number, [number, number, number]> = {
  1: [0.75, 1.09, 39],
  2: [1.1, 1.62, 41],
  3: [1.63, 2.41, 41],
  4: [2.42, 3.82, 35],
  5: [3.83, 4.41, 112],
  6: [4.42, 5.0, 128],
};

export function channelEdges(band: number): number[] {
  const [lo, hi] = BANDS[band];
  return Array.from({ length: CHANNELS_PER_BAND + 1 }, (_, i) => lo * (hi / lo) ** (i / CHANNELS_PER_BAND));
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function allChannels() {
  return Object.keys(BANDS).flatMap((b) => {
    const band = Number(b);
    const e = channelEdges(band);
    return Array.from({ length: CHANNELS_PER_BAND }, (_, ch) => ({
      index: CHANNELS_PER_BAND * (band - 1) + ch,
      band,
      channel: ch + 1,
      wave_min: r4(e[ch]),
      wave_max: r4(e[ch + 1]),
      wave_center: r4(Math.sqrt(e[ch] * e[ch + 1])),
      resolving_power: BANDS[band][2],
    }));
  });
}

/** Channel (1..17) of a wavelength inside a band, or null if outside. */
export function channelOf(band: number, wave: number | null | undefined): number | null {
  if (wave == null || !Number.isFinite(wave) || !BANDS[band]) return null;
  const e = channelEdges(band);
  // the filter edges in real frames sit a little outside the nominal limits
  if (wave < e[0]) return wave > e[0] * 0.98 ? 1 : null;
  if (wave >= e[CHANNELS_PER_BAND]) return wave < e[CHANNELS_PER_BAND] * 1.02 ? CHANNELS_PER_BAND : null;
  let i = 0;
  while (wave >= e[i + 1]) i++;
  return i + 1;
}

export const globalIndex = (band: number, channel: number) => CHANNELS_PER_BAND * (band - 1) + (channel - 1);
