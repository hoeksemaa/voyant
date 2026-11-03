// Input-referred noise of the ADS1299, from datasheet SBAS499C, Tables 1–4
// ("Input-Referred Noise (µVRMS, µVPP) in Normal Mode, 5-V Analog Supply and 4.5-V Reference").
// Rows: DR[2:0] = 000 … 110 (16 kSPS … 250 SPS). Columns: GAIN[2:0] = 000 … 110 (×1 … ×24).
// All 49 cells. DR 111 and GAIN 111 are "do not use": they have no row or column.

/** µV rms. NOISE_UVRMS[dr][gain], both as register codes. */
export const NOISE_UVRMS: readonly (readonly number[])[] = [
  //  ×1     ×2     ×4    ×6    ×8    ×12   ×24
  [21.7, 10.85, 5.6, 3.87, 3.05, 2.27, 1.66], // 000: 16000 SPS
  [6.93, 3.65, 1.98, 1.31, 1.11, 0.92, 0.8], //  001:  8000 SPS
  [4.33, 2.28, 1.24, 0.93, 0.79, 0.65, 0.56], // 010:  4000 SPS
  [3.06, 1.61, 0.88, 0.66, 0.56, 0.46, 0.4], //  011:  2000 SPS
  [2.17, 1.14, 0.62, 0.46, 0.39, 0.32, 0.28], // 100:  1000 SPS
  [1.53, 0.81, 0.44, 0.33, 0.28, 0.23, 0.2], //  101:   500 SPS
  [1.08, 0.57, 0.31, 0.23, 0.2, 0.16, 0.14], //  110:   250 SPS
];

/** µV peak-to-peak, same layout (the tables use at least 1000 readings). */
export const NOISE_UVPP: readonly (readonly number[])[] = [
  [151.89, 75.94, 39.23, 27.1, 21.32, 15.89, 11.64],
  [48.53, 25.52, 13.87, 9.19, 7.8, 6.41, 5.57],
  [30.34, 15.95, 8.66, 6.5, 5.52, 4.53, 3.94],
  [21.45, 11.29, 6.13, 4.6, 3.9, 3.2, 2.79],
  [15.17, 7.98, 4.34, 3.25, 2.76, 2.26, 1.97],
  [10.73, 5.65, 3.07, 2.3, 1.95, 1.61, 1.39],
  [7.59, 3.99, 2.16, 1.62, 1.38, 1.13, 0.98],
];

/** −3-dB bandwidth (Hz) for each DR code, from the same tables. */
export const BANDWIDTH_HZ = [4193, 2096, 1048, 524, 262, 131, 65];

/** Chip noise in µV rms for a gain code and a DR code (both 0–6). */
export function noiseUvRms(gainCode: number, drCode: number): number {
  const row = NOISE_UVRMS[drCode];
  if (!row || row[gainCode] === undefined) throw new Error(`no noise cell for gain ${gainCode}, DR ${drCode}`);
  return row[gainCode];
}
