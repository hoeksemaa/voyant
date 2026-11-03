// The ADS1299 model: registers + wiring + body → the chip's digital output.
//
// simulate(setup, bank) follows the signal from the electrodes to the codes:
//   electrodes → pins (bias loop, mains hum, floating inputs, diode clamps)
//   → input MUX → PGA (gain, common-mode window) → modulator range
//   → sinc3 decimation filter (DR) → chip noise (datasheet Tables 1–4) → 24-bit codes.
// Everything that does not depend on the registers is cached per setup, and every random
// part is seeded, so the same (setup, bank) always gives the same output, bit for bit.
//
// Speed: when no clamp can act on a channel, the chain is linear, so the model combines
// cached filtered electrode traces (one pass over the output samples). Other channels
// (floating pins, saturation, faults) go sample by sample at the base rate.
//
// Datasheet: TI SBAS499C (reference/ads1299-datasheet.pdf).

import type { AnalogIn, Bank, ChannelOut, ChannelStatus, Flag, Setup, SimResult } from "./types";
import { GAINS, RATES, VREF } from "./registers";
import {
  AVDD_UV,
  bodyFor,
  DIODE_CLAMP_UV,
  DISPLAY_RATE,
  drift,
  electrodeOn,
  FS,
  MAINS_HZ,
  MID_UV,
  PAD,
  PGA_HEADROOM_UV,
  type Body,
  type FloatNode,
} from "./body";
import { noiseUvRms } from "./noise";
import { gaussArray, rng } from "./rng";

// ---- tuning constants ---------------------------------------------------------------------------

export const VREF_UV = VREF * 1e6;
/** Room mains on the body with the bias amp on but no feedback (open loop), µV amplitude. */
export const CM_OPEN_UV = 50e3;
/** Bias loop gain for each input in the bias average: G = LOOP_K × N (datasheet Eq. 11: Rf × N / R). */
export const LOOP_K = 7;
/** The bias amp output stays this far from the rails, µV. */
export const BIAS_SWING_UV = 0.05e6;
/** Broadband pickup on a floating pin, µV rms (on top of its mains and drift). */
export const FLOAT_NOISE_UV = 2e3;
/** Chip temperature for MUX 100, °C (the datasheet says self-heating reads high). */
export const TEMP_C = 30;
export const DVDD_UV = 3.3e6;

/** For tests: linear = false sends every channel through the sample-by-sample path. */
export const modelOptions = { linear: true };

const CODE_FS = 2 ** 23; // 24-bit two's complement: 800000h … 7FFFFFh
const PIN_LO = -DIODE_CLAMP_UV; // input diodes hold a pin about 0.5 V past a rail
const PIN_HI = AVDD_UV + DIODE_CLAMP_UV;
const PGA_LO = PGA_HEADROOM_UV; // PGA outputs stay 200 mV from the rails (datasheet 9.3.1.3.1)
const PGA_HI = AVDD_UV - PGA_HEADROOM_UV;
const F_CLK = 2.048e6;
const W60 = (2 * Math.PI * MAINS_HZ) / FS; // rad per base sample
const DISPLAY_DECIM = FS / DISPLAY_RATE;

const MUX_NAME = [
  "the electrode input",
  "a shorted input",
  "the bias measurement input",
  "the supply",
  "the temperature sensor",
  "the test signal",
  "the bias drive",
  "the bias drive",
];

// ---- per-setup cache (nothing here depends on the registers) -----------------------------------

interface SetupCache {
  body: Body;
  sin: Float64Array; // sin(2π·60·t + mainsPhase)
  cos: Float64Array;
  zero: Float64Array;
  floatNoise: Float64Array | null; // shared broadband pickup, unit rms; each node reads its own offset (lazy)
  nodes: Map<string, Float64Array>; // floating node key → µV relative to mid-supply
  stats: Map<string, { mean: number; min: number; max: number }>; // source key → stats of e
  filt: Map<string, Float64Array>; // `${key}|${D}` → sinc3 output of a source trace
  disp: Map<string, Float32Array>; // key → display trace (DISPLAY_RATE)
  chipNoise: Map<string, Float64Array>; // `${ch}:${dr}` → unit normal, one per output sample
  bad: Map<string, Float64Array>; // `${ch}:${dr}` → full-scale garbage, −1 … +1
}

const caches = new WeakMap<Setup, SetupCache>();
const NODE_STRIDE = 997;

function cacheFor(s: Setup): SetupCache {
  let c = caches.get(s);
  if (c) return c;
  const body = bodyFor(s);
  const n = body.n;
  const sin = new Float64Array(n);
  const cos = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ph = W60 * (i - PAD) + body.mainsPhase;
    sin[i] = Math.sin(ph);
    cos[i] = Math.cos(ph);
  }
  c = {
    body,
    sin,
    cos,
    zero: new Float64Array(n),
    floatNoise: null,
    nodes: new Map(),
    stats: new Map(),
    filt: new Map(),
    disp: new Map(),
    chipNoise: new Map(),
    bad: new Map(),
  };
  caches.set(s, c);
  return c;
}

/** Floating pins pick up broadband interference too (RF, harmonics, movement), below ~1 kHz. */
function floatNoise(c: SetupCache, s: Setup): Float64Array {
  if (c.floatNoise) return c.floatNoise;
  const n = c.body.n;
  const raw = gaussArray(`${s.id}:floatnoise`, n + 20 * NODE_STRIDE + 2000);
  const a = Math.exp((-2 * Math.PI * 1000) / FS);
  let y = 0;
  let ss = 0;
  for (let i = 0; i < raw.length; i++) {
    y = a * y + (1 - a) * raw[i];
    raw[i] = y;
    if (i >= 2000) ss += y * y;
  }
  const k = 1 / Math.sqrt(ss / (raw.length - 2000));
  const out = raw.subarray(2000);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  c.floatNoise = out;
  return out;
}

/** A floating node as an array: mains (own size and phase) + drift + broadband pickup. */
function nodeArray(c: SetupCache, s: Setup, key: string, p: FloatNode, slot: number, noiseUv: number): Float64Array {
  let x = c.nodes.get(key);
  if (x) return x;
  const n = c.body.n;
  x = new Float64Array(n);
  const d = p.phase - c.body.mainsPhase;
  const ks = p.amp * Math.cos(d);
  const kc = p.amp * Math.sin(d);
  const off = (slot % 20) * NODE_STRIDE;
  const fn = noiseUv ? floatNoise(c, s) : c.zero;
  const offN = noiseUv ? off : 0;
  // The drift is slow: compute it every 16 samples and interpolate.
  const STEP = 16;
  let d0 = drift(p, -PAD / FS);
  for (let j = 0; j < n; j += STEP) {
    const j1 = Math.min(j + STEP, n - 1);
    const d1 = drift(p, (j1 - PAD) / FS);
    const span = j1 - j || 1;
    const end = Math.min(j + STEP, n);
    for (let i = j; i < end; i++) {
      x[i] = ks * c.sin[i] + kc * c.cos[i] + d0 + ((d1 - d0) * (i - j)) / span + noiseUv * fn[i + offN];
    }
    d0 = d1;
  }
  c.nodes.set(key, x);
  return x;
}

function pinSlot(pin: string): number {
  const m = /^IN(\d)([PN])$/.exec(pin);
  return m ? (Number(m[1]) - 1) * 2 + (m[2] === "N" ? 1 : 0) : 17;
}

function stats(c: SetupCache, key: string, e: Float64Array) {
  let st = c.stats.get(key);
  if (st) return st;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < e.length; i++) {
    const v = e[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (i >= PAD && i < e.length - PAD) sum += v;
  }
  st = { mean: sum / (e.length - 2 * PAD), min, max };
  c.stats.set(key, st);
  return st;
}

function unitNoise(c: SetupCache, s: Setup, ch: number, dr: number, len: number): Float64Array {
  const key = `${ch}:${dr}`;
  let u = c.chipNoise.get(key);
  if (!u) {
    u = gaussArray(`${s.id}:chip:${ch}:${dr}`, len);
    c.chipNoise.set(key, u);
  }
  return u;
}

/** Codes with no meaning: the modulator saturates often, so about 1 sample in 4 sits at a rail. */
function garbage(c: SetupCache, s: Setup, ch: number, dr: number, len: number): Float64Array {
  const key = `${ch}:${dr}`;
  let g = c.bad.get(key);
  if (!g) {
    const r = rng(`${s.id}:invalid:${ch}:${dr}`);
    g = new Float64Array(len);
    for (let k = 0; k < len; k++) g[k] = Math.max(-1, Math.min(1, 1.3 * (2 * r.next() - 1)));
    c.bad.set(key, g);
  }
  return g;
}

// ---- digital filter -----------------------------------------------------------------------------

let s1Buf = new Float64Array(0);
let s2Buf = new Float64Array(0);

/**
 * sinc3 decimation (datasheet 9.3.2.1, Eq. 6: three cascaded moving sums of length D),
 * then one output every D input samples. Output k is centered on input sample start + k·D,
 * so output sample k belongs to time k / rate at every data rate (group delay removed).
 * Cost: about 3 operations per input sample.
 */
export function sinc3Decimate(x: Float64Array, D: number, start: number, nOut: number): Float64Array {
  const y = new Float64Array(nOut);
  if (D === 1) {
    for (let k = 0; k < nOut; k++) y[k] = x[start + k];
    return y;
  }
  const h = Math.round(1.5 * (D - 1)); // causal filter: center = m − 1.5 (D − 1)
  const lo = start + h - 3 * D + 3; // first input sample used
  const hi = start + (nOut - 1) * D + h; // last input sample used
  const len = hi - lo + 1;
  if (s1Buf.length < len) {
    s1Buf = new Float64Array(len);
    s2Buf = new Float64Array(len);
  }
  const s1 = s1Buf;
  const s2 = s2Buf;
  // s1[j] = sum of x over [lo + j − D + 1, lo + j]; valid from j = D − 1.
  let acc = 0;
  for (let j = 0; j < len; j++) {
    acc += x[lo + j];
    if (j >= D) acc -= x[lo + j - D];
    s1[j] = acc;
  }
  acc = 0;
  for (let j = D - 1; j < len; j++) {
    acc += s1[j];
    if (j >= 2 * D - 1) acc -= s1[j - D];
    s2[j] = acc;
  }
  const scale = 1 / (D * D * D);
  for (let k = 0; k < nOut; k++) {
    const m = start + k * D + h - lo;
    let s = 0;
    for (let j = m - D + 1; j <= m; j++) s += s2[j];
    y[k] = s * scale;
  }
  return y;
}

/** Display trace: mean of each block of DISPLAY_DECIM base samples, centered on k / DISPLAY_RATE. */
function displayDecimate(x: Float64Array, n0: number): Float32Array {
  const m = Math.floor(n0 / DISPLAY_DECIM);
  const out = new Float32Array(m);
  const half = DISPLAY_DECIM / 2;
  for (let k = 0; k < m; k++) {
    const c0 = PAD + k * DISPLAY_DECIM - half;
    let s = 0;
    for (let j = 0; j < DISPLAY_DECIM; j++) s += x[c0 + j];
    out[k] = s / DISPLAY_DECIM;
  }
  return out;
}

function filtOf(c: SetupCache, key: string, e: Float64Array, D: number, nOut: number): Float64Array {
  const k = `${key}|${D}`;
  let f = c.filt.get(k);
  if (!f) {
    f = sinc3Decimate(e, D, PAD, nOut);
    c.filt.set(k, f);
  }
  return f;
}

function dispOf(c: SetupCache, key: string, e: Float64Array): Float32Array {
  let f = c.disp.get(key);
  if (!f) {
    f = displayDecimate(e, c.body.n0);
    c.disp.set(key, f);
  }
  return f;
}

// ---- wiring -------------------------------------------------------------------------------------

/**
 * What drives a pin. Pin voltage (absolute, µV vs AVSS) =
 *   w · body(t) + base + e(t) − c · cmAC(t)
 * electrode: w = 1, base = 0, e = electrode potential vs the body, c = its mains coupling.
 * bias drive: w = 1, e = 0, c = 0 (BIASOUT holds the body).
 * floating:  w = 0, base = mid-supply, e = the floating node, c = 0.
 */
interface Src {
  kind: "elec" | "float" | "bias";
  w: number;
  base: number;
  e: Float64Array;
  c: number;
  mean: number;
  min: number;
  max: number;
  label: string; // electrode id, or "open"
  key: string; // identity: cache key and SRB2 groups
}

function elecSrc(c: SetupCache, id: string): Src {
  const e = c.body.elec.get(id)!;
  const st = stats(c, `e:${id}`, e);
  return { kind: "elec", w: 1, base: 0, e, c: c.body.coupling.get(id) ?? 0, ...st, label: id, key: `e:${id}` };
}

function floatSrc(c: SetupCache, s: Setup, pin: string): Src {
  const p = c.body.floatPin.get(pin) ?? c.body.floatPin.get("IN1P")!;
  const e = nodeArray(c, s, `pin:${pin}`, p, pinSlot(pin), FLOAT_NOISE_UV);
  return { kind: "float", w: 0, base: MID_UV, e, c: 0, mean: 0, min: 0, max: 0, label: "open", key: `f:${pin}` };
}

function pinSrc(c: SetupCache, s: Setup, pin: string): Src {
  const el = electrodeOn(s, pin);
  return el ? elecSrc(c, el.id) : floatSrc(c, s, pin);
}

interface Chan {
  n: number;
  pd: boolean;
  g: number; // gain code 0–7
  srb2: boolean;
  mux: number;
}

const chanOf = (bank: Bank, n: number): Chan => {
  const v = bank[0x04 + n] & 0xff;
  return { n, pd: (v & 0x80) !== 0, g: (v >> 4) & 7, srb2: (v & 0x08) !== 0, mux: v & 7 };
};

/** ["IN3P", …, "IN8P"] → "IN3P–IN8P" when the pins are in a row. */
function pinList(pins: string[]): string {
  if (pins.length <= 2) return pins.join(" and ");
  const nums = pins.map((p) => Number(p[2]));
  const run = nums.every((v, i) => i === 0 || v === nums[i - 1] + 1) && pins.every((p) => p[3] === pins[0][3]);
  return run ? `${pins[0]}–${pins[pins.length - 1]}` : `${pins.slice(0, -1).join(", ")}, and ${pins[pins.length - 1]}`;
}

/** [3, 4, 5, 6] → "CH3–CH6"; [1, 4] → "CH1 and CH4". */
function chList(chs: number[]): string {
  if (chs.length >= 3 && chs.every((v, i) => i === 0 || v === chs[i - 1] + 1)) return `CH${chs[0]}–CH${chs[chs.length - 1]}`;
  if (chs.length <= 2) return chs.map((n) => `CH${n}`).join(" and ");
  return `${chs.slice(0, -1).map((n) => `CH${n}`).join(", ")}, and CH${chs[chs.length - 1]}`;
}

const mvText = (uv: number): string => {
  const v = uv / 1e3;
  return v >= 100 ? `${Math.round(v * 10) / 10}` : `${Math.round(v * 100) / 100}`;
};

// ---- body state for one call ----------------------------------------------------------------------

/**
 * The body (absolute µV vs AVSS) and the common-mode AC part that reaches the pins through the
 * electrode couplings. "simple": body = base + res·sin60, cmAC = res·sin60 (the normal loop).
 */
interface BodyState {
  simple: boolean;
  base: number;
  res: number;
  body: Float64Array;
  cm: Float64Array;
  bmin: number;
  bmax: number;
  cmMax: number;
  ready: boolean; // body and cm arrays hold the values
}

let bodyBuf = new Float64Array(0);
let cmBuf = new Float64Array(0);
let xBuf = new Float64Array(0);
let aBuf = new Float64Array(0);

function scratch(n: number) {
  if (bodyBuf.length !== n) {
    bodyBuf = new Float64Array(n);
    cmBuf = new Float64Array(n);
    xBuf = new Float64Array(n);
    aBuf = new Float64Array(n);
  }
}

// ---- the model ----------------------------------------------------------------------------------

export function simulate(s: Setup, bank: Bank): SimResult {
  const c = cacheFor(s);
  const B = c.body;
  const n = B.n;
  const n0 = B.n0;
  const flags: Flag[] = [];
  const act = (text: string, reg?: string, ch?: number) => flags.push({ level: "act", reg, ch, text });
  const watch = (text: string, reg?: string, ch?: number) => flags.push({ level: "watch", reg, ch, text });

  // -- chip-level settings (CONFIG1, CONFIG2, CONFIG3) --
  const c1 = bank[0x01] & 0xff;
  const c2 = bank[0x02] & 0xff;
  const c3 = bank[0x03] & 0xff;
  const dr = c1 & 7;
  const rate = dr < 7 ? RATES[dr] : RATES[6];
  const D = FS / rate;
  const nOut = Math.round(s.duration * rate);
  let chipInvalid = false;
  if (!(c1 & 0x80)) {
    act("CONFIG1 bit 7 is reserved and must be 1. The chip output is not valid.", "CONFIG1");
    chipInvalid = true;
  }
  if (((c1 >> 3) & 3) !== 2) {
    act("CONFIG1 bits 4:3 are reserved and must be 10. The chip output is not valid.", "CONFIG1");
    chipInvalid = true;
  }
  if (dr === 7) {
    act('CONFIG1 DR = 111 is "do not use". The chip output is not valid.', "CONFIG1");
    chipInvalid = true;
  }
  if (!(c3 & 0x80)) {
    act(
      "CONFIG3 PD_REFBUF is 0, so the internal reference buffer is off. The X8 has no external reference on VREFP, so no code is valid.",
      "CONFIG3",
    );
    chipInvalid = true;
  }
  if (((c3 >> 5) & 3) !== 3) {
    act("CONFIG3 bits 6:5 are reserved and must be 11. The chip output is not valid.", "CONFIG3");
    chipInvalid = true;
  }
  const biasOn = (c3 & 0x04) !== 0;
  const refInt = (c3 & 0x08) !== 0;
  if (!biasOn) {
    act(
      "CONFIG3 PD_BIAS is 0, so the bias drive is off. Nothing holds the body: it picks up large 60 Hz hum and drifts to a rail.",
      "CONFIG3",
    );
  }
  if (!refInt) {
    act(
      biasOn
        ? "CONFIG3 BIASREF_INT is 0, so the bias drive follows the BIASREF pin. That pin floats on the X8. The bias drive pushes the body to a rail, and the inputs saturate."
        : "CONFIG3 BIASREF_INT is 0, so the bias reference comes from the BIASREF pin. That pin floats on the X8.",
      "CONFIG3",
    );
  }

  // -- channels and pins --
  const chans = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => chanOf(bank, k));
  const P: Src[] = [];
  const N: Src[] = [];
  for (const ch of chans) {
    P.push(pinSrc(c, s, `IN${ch.n}P`));
    N.push(s.montage === "srb1" ? pinSrc(c, s, "SRB1") : pinSrc(c, s, `IN${ch.n}N`));
  }
  const baseP = P.slice();

  // SRB2 closed: the INxP pins of those channels join one net (nothing else is on SRB2 here).
  const srb2 = chans.filter((ch) => ch.srb2 && !ch.pd);
  if (srb2.length === 1) {
    watch(
      `SRB2 is closed on CH${srb2[0].n} only. Nothing else is on the SRB2 net, so this has no effect.`,
      `CH${srb2[0].n}SET`,
      srb2[0].n,
    );
  } else if (srb2.length >= 2) {
    const members = srb2.map((ch) => P[ch.n - 1]);
    const elecs = members.filter((m) => m.kind === "elec");
    let joined: Src;
    if (elecs.length === 0) joined = members[0];
    else if (elecs.length === 1) joined = elecs[0];
    else {
      const e = new Float64Array(n);
      for (const m of elecs) for (let i = 0; i < n; i++) e[i] += m.e[i] / elecs.length;
      const key = elecs.map((m) => m.key).join("+");
      joined = {
        kind: "elec",
        w: 1,
        base: 0,
        e,
        c: elecs.reduce((a, m) => a + m.c, 0) / elecs.length,
        ...stats(c, key, e),
        label: elecs.map((m) => m.label).join("+"),
        key,
      };
    }
    for (const ch of srb2) P[ch.n - 1] = joined;
    watch(
      `SRB2 is closed on ${chList(srb2.map((ch) => ch.n))}. Their INxP pins connect together, so they read the same input.`,
      `CH${srb2[0].n}SET`,
    );
  }

  // -- bias loop: which inputs feed the bias average (BIAS_SENSP/N) --
  const sensed: Src[] = [];
  const floatsIn: Src[] = [];
  const maskFloat: Record<string, string[]> = { BIAS_SENSP: [], BIAS_SENSN: [] };
  const maskIdle: Record<string, { pin: string; ch: number; off: boolean }[]> = { BIAS_SENSP: [], BIAS_SENSN: [] };
  let srb1Count = 0;
  for (const [reg, addr, side] of [
    ["BIAS_SENSP", 0x0d, "P"],
    ["BIAS_SENSN", 0x0e, "N"],
  ] as const) {
    const m = bank[addr] & 0xff;
    for (let b = 0; b < 8; b++) {
      if (!(m & (1 << b))) continue;
      const ch = chans[b];
      const pin = `IN${b + 1}${side}`;
      if (ch.pd || ch.mux !== 0) {
        maskIdle[reg].push({ pin, ch: ch.n, off: ch.pd });
        continue;
      }
      const src = side === "P" ? P[b] : N[b];
      if (src.kind === "elec") {
        sensed.push(src);
        if (side === "N" && s.montage === "srb1") srb1Count++;
      } else {
        floatsIn.push(src);
        maskFloat[reg].push(pin);
      }
    }
  }
  const nLoop = sensed.length;
  if (biasOn) {
    for (const reg of ["BIAS_SENSP", "BIAS_SENSN"] as const) {
      const pins = maskFloat[reg];
      if (pins.length) {
        act(
          `${reg} includes ${pinList(pins)}, but no electrode is on ${pins.length > 1 ? "these pins" : "that pin"}. The bias drive puts the floating input noise into the body, and into every channel.`,
          reg,
          pins.length === 1 ? Number(pins[0][2]) : undefined,
        );
      }
      for (const off of [true, false]) {
        const idle = maskIdle[reg].filter((x) => x.off === off);
        if (!idle.length) continue;
        const one = idle.length === 1;
        const who = chList(idle.map((x) => x.ch));
        const why = off ? `${who} ${one ? "is" : "are"} off` : `${who} ${one ? "does" : "do"} not read the electrode input (MUX is not 000)`;
        watch(
          `${reg} includes ${pinList(idle.map((x) => x.pin))}, but ${why}. ${one ? "That bit has" : "Those bits have"} no effect.`,
          reg,
          one ? idle[0].ch : undefined,
        );
      }
    }
    if (srb1Count >= 2) {
      watch(
        `BIAS_SENSN senses the SRB1 electrode ${srb1Count} times. The bias average gives too much weight to the reference electrode.`,
        "BIAS_SENSN",
      );
    }
    if (refInt && nLoop === 0 && floatsIn.length === 0) {
      watch(
        "BIAS_SENSP and BIAS_SENSN select no electrode. The bias drive holds the DC level, but it does not reduce the 60 Hz hum.",
        "BIAS_SENSP",
      );
    }
  }

  // -- the body --
  scratch(n);
  const S = c.sin;
  const C = c.cos;
  const meanSensed = nLoop ? sensed.reduce((a, x) => a + x.mean, 0) / nLoop : 0;
  const res = CM_OPEN_UV / (1 + LOOP_K * nLoop); // residual mains with the loop closed
  const st: BodyState = {
    simple: true,
    base: MID_UV - meanSensed,
    res,
    body: bodyBuf,
    cm: cmBuf,
    bmin: MID_UV - meanSensed - res,
    bmax: MID_UV - meanSensed + res,
    cmMax: res,
    ready: false,
  };
  if (!biasOn || !refInt || floatsIn.length > 0) {
    st.simple = false;
    st.ready = true;
    const body = bodyBuf;
    const cm = cmBuf;
    const swLo = BIAS_SWING_UV;
    const swHi = AVDD_UV - BIAS_SWING_UV;
    if (!biasOn) {
      // No bias drive: the body floats. Large hum; the DC level runs into a rail.
      const p = B.floatBody;
      const d = p.phase - B.mainsPhase;
      const ks = p.amp * Math.cos(d);
      const kc = p.amp * Math.sin(d);
      const dc = nodeArray(c, s, "body", { ...p, amp: 0 }, 18, 0);
      for (let i = 0; i < n; i++) {
        const ac = ks * S[i] + kc * C[i];
        cm[i] = ac;
        body[i] = MID_UV + dc[i] + ac;
      }
    } else if (!refInt) {
      // BIASREF floats: the loop drives the body toward that pin. Past the amp's swing, the
      // amp saturates and the loop opens (full open-loop hum).
      const p = B.floatRef;
      const d = p.phase - B.mainsPhase;
      const ks = p.amp * Math.cos(d);
      const kc = p.amp * Math.sin(d);
      const refDc = nodeArray(c, s, "biasref", { ...p, amp: 0 }, 19, 0);
      for (let i = 0; i < n; i++) {
        const target = MID_UV + refDc[i] - meanSensed;
        if (target > swLo && target < swHi) {
          const ac = (res + ks) * S[i] + kc * C[i]; // the loop copies BIASREF's mains too
          body[i] = target + ac;
          cm[i] = ac;
        } else {
          const ac = CM_OPEN_UV * S[i];
          body[i] = (target <= swLo ? swLo : swHi) + ac;
          cm[i] = ac;
        }
      }
    } else {
      // Floating inputs in the bias average: the loop drives their noise into the body.
      const base = st.base;
      const k = nLoop ? 1 / nLoop : LOOP_K;
      const fl = floatsIn.map((f) => f.e);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < fl.length; j++) sum += fl[j][i];
        const b = Math.min(swHi, Math.max(swLo, base - k * sum + res * S[i]));
        body[i] = b;
        cm[i] = b - base;
      }
    }
    let bmin = Infinity;
    let bmax = -Infinity;
    let cmMax = 0;
    for (let i = 0; i < n; i++) {
      const b = body[i];
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
      const a = Math.abs(cm[i]);
      if (a > cmMax) cmMax = a;
    }
    st.bmin = bmin;
    st.bmax = bmax;
    st.cmMax = cmMax;
  }
  const ensureBody = () => {
    if (st.ready) return;
    const base = st.base;
    for (let i = 0; i < n; i++) {
      const ac = res * S[i];
      cmBuf[i] = ac;
      bodyBuf[i] = base + ac;
    }
    st.ready = true;
  };
  // Filtered and display versions of cmAC, for the linear path.
  let fcm: Float64Array | null = null;
  let dcm: Float32Array | null = null;
  const fCm = (): [Float64Array, number] => {
    if (st.simple) return [filtOf(c, "sin", S, D, nOut), res];
    if (!fcm) fcm = sinc3Decimate(cmBuf, D, PAD, nOut);
    return [fcm, 1];
  };
  const dCm = (): [Float32Array, number] => {
    if (st.simple) return [dispOf(c, "sin", S), res];
    if (!dcm) dcm = displayDecimate(cmBuf, n0);
    return [dcm, 1];
  };

  /** True when no pin clamp, PGA limit, or modulator limit can act: the chain is linear. */
  const linear = (p: Src, q: Src, g: number, rail: number): boolean => {
    if (!modelOptions.linear || p.w !== 1 || q.w !== 1) return false;
    const m = st.cmMax;
    const vdMax = Math.max(p.max - q.min, q.max - p.min) + Math.abs(p.c - q.c) * m;
    const vpLo = st.bmin + p.min - Math.abs(p.c) * m;
    const vpHi = st.bmax + p.max + Math.abs(p.c) * m;
    const vnLo = st.bmin + q.min - Math.abs(q.c) * m;
    const vnHi = st.bmax + q.max + Math.abs(q.c) * m;
    if (vpLo < PIN_LO || vpHi > PIN_HI || vnLo < PIN_LO || vnHi > PIN_HI) return false;
    if (g === 0) return true; // display only
    const half = (g / 2) * vdMax;
    if (0.5 * (vpHi + vnHi) + half > PGA_HI || 0.5 * (vpLo + vnLo) - half < PGA_LO) return false;
    return vdMax <= rail;
  };

  const x = xBuf;
  const ana = aBuf;

  /**
   * Pin voltages → differential (ana) and the PGA and modulator reading (x).
   * Sets sat when a PGA output or the modulator reaches its limit (the channel saturates), and
   * over when the differential input itself is past full scale.
   */
  let over = false;
  const pins = (p: Src, q: Src, g: number, rail: number): boolean => {
    ensureBody();
    const body = bodyBuf;
    const cm = cmBuf;
    const wp = p.w, bp = p.base, ep = p.e, cp = p.c;
    const wq = q.w, bq = q.base, eq = q.e, cq = q.c;
    const hg = g / 2;
    const ig = 1 / g;
    let sat = false;
    over = false;
    for (let i = 0; i < n; i++) {
      const bi = body[i];
      const ci = cm[i];
      const vp = Math.min(PIN_HI, Math.max(PIN_LO, wp * bi + bp + ep[i] - cp * ci));
      const vn = Math.min(PIN_HI, Math.max(PIN_LO, wq * bi + bq + eq[i] - cq * ci));
      const vd = vp - vn;
      ana[i] = vd;
      if (vd > rail || vd < -rail) over = true;
      const mid = 0.5 * (vp + vn);
      const a0 = mid + hg * vd;
      const b0 = mid - hg * vd;
      const a = Math.min(PGA_HI, Math.max(PGA_LO, a0));
      const b = Math.min(PGA_HI, Math.max(PGA_LO, b0));
      const r = (a - b) * ig;
      if (a !== a0 || b !== b0 || r > rail || r < -rail) sat = true;
      x[i] = Math.min(rail, Math.max(-rail, r));
    }
    return sat;
  };

  /** A source inside the chip, with its common mode at mid-supply. Returns true on saturation. */
  const internal = (fn: (i: number) => number, g: number, rail: number): boolean => {
    const hg = g / 2;
    let sat = false;
    for (let i = 0; i < n; i++) {
      const vd = fn(i);
      const a0 = MID_UV + hg * vd;
      const b0 = MID_UV - hg * vd;
      const a = Math.min(PGA_HI, Math.max(PGA_LO, a0));
      const b = Math.min(PGA_HI, Math.max(PGA_LO, b0));
      const r = (a - b) / g;
      if (a !== a0 || b !== b0 || r > rail || r < -rail) sat = true;
      x[i] = Math.min(rail, Math.max(-rail, r));
    }
    return sat;
  };

  /** Linear chain: filtered (P − N) from cached filtered traces. */
  const linearOut = (p: Src, q: Src): Float64Array => {
    const fp = filtOf(c, p.key, p.e, D, nOut);
    const fq = filtOf(c, q.key, q.e, D, nOut);
    const [fc, kc0] = fCm();
    const kc = (p.c - q.c) * kc0;
    const y = new Float64Array(nOut);
    for (let k = 0; k < nOut; k++) y[k] = fp[k] - fq[k] - kc * fc[k];
    return y;
  };

  const biasPin: Src = {
    kind: "bias",
    w: 1,
    base: 0,
    e: c.zero,
    c: 0,
    mean: 0,
    min: 0,
    max: 0,
    label: "BIAS",
    key: "zero",
  };

  // -- channels --
  const out: ChannelOut[] = [];
  const analog: AnalogIn[] = [];
  for (const ch of chans) {
    const i0 = ch.n - 1;
    const gain = ch.g < 7 ? GAINS[ch.g] : null;
    const rail = VREF_UV / (gain ?? 1);
    let status: ChannelStatus = "on";
    if (ch.pd) status = "off";
    else if (chipInvalid || gain === null) status = "invalid";
    if (gain === null) {
      if (ch.pd) watch(`CH${ch.n}SET GAIN = 111 is "do not use". CH${ch.n} is off, so it has no effect.`, `CH${ch.n}SET`, ch.n);
      else act(`CH${ch.n}SET GAIN = 111 is "do not use". The CH${ch.n} output is not valid.`, `CH${ch.n}SET`, ch.n);
    }

    const p = P[i0];
    const q = N[i0];
    const hasP = baseP[i0].kind === "elec";
    let anaReady = false;
    let uv: Float32Array;
    let clipped = false;

    if (status === "off") {
      uv = new Float32Array(nOut); // datasheet 9.4.4.2: a powered-down channel outputs 0
      if (hasP) watch(`CH${ch.n} is off, but an electrode is on IN${ch.n}P.`, `CH${ch.n}SET`, ch.n);
    } else if (status === "invalid") {
      const gb = garbage(c, s, ch.n, dr, nOut);
      uv = new Float32Array(nOut);
      for (let k = 0; k < nOut; k++) uv[k] = gb[k] * rail;
      clipped = true;
    } else {
      const g = gain!;
      let filtered: Float64Array | null = null;
      let constant = 0;
      switch (ch.mux) {
        case 0: {
          if (linear(p, q, g, rail)) filtered = linearOut(p, q);
          else {
            clipped = pins(p, q, g, rail);
            anaReady = true;
            filtered = sinc3Decimate(x, D, PAD, nOut);
          }
          const pOpen = p.kind === "float";
          const qOpen = q.kind === "float";
          const reg = `CH${ch.n}SET`;
          if (pOpen && qOpen) act(`CH${ch.n} is on, but no electrode is on IN${ch.n}P or IN${ch.n}N. The inputs float.`, reg, ch.n);
          else if (pOpen) act(`CH${ch.n} is on, but no electrode is on IN${ch.n}P. The input floats.`, reg, ch.n);
          else if (qOpen) act(`CH${ch.n} is on, but no electrode is on IN${ch.n}N. The input floats.`, reg, ch.n);
          break;
        }
        case 1:
          constant = 0; // input shorted
          break;
        case 2: {
          const node = nodeArray(c, s, `open:${ch.n}`, B.openInput[i0], 0, 0);
          clipped = internal((i) => node[i], g, rail);
          filtered = sinc3Decimate(x, D, PAD, nOut);
          watch(`CH${ch.n} MUX = 010 needs CONFIG3 BIAS_MEAS = 1. BIAS_MEAS is 0, so the input is open.`, `CH${ch.n}SET`, ch.n);
          break;
        }
        case 3: {
          // Datasheet 9.3.1.1.4: CH1, 2, 5–8 read (AVDD + AVSS) / 2; CH3, 4 read DVDD / 4.
          const v = ch.n === 3 || ch.n === 4 ? DVDD_UV / 4 : AVDD_UV / 2;
          clipped = internal(() => v, g, rail);
          constant = x[PAD];
          if (g !== 1) watch(`CH${ch.n} reads the supply. Use gain ×1, or the PGA saturates.`, `CH${ch.n}SET`, ch.n);
          break;
        }
        case 4: {
          // Datasheet Eq. 3: 145,300 µV at 25 °C, +490 µV/°C.
          const v = 145300 + 490 * (TEMP_C - 25);
          clipped = internal(() => v, g, rail);
          constant = x[PAD];
          break;
        }
        case 5: {
          // CONFIG2: amplitude 1 or 2 × VREF / 2400; square at fCLK / 2^21 or fCLK / 2^20, or DC.
          const intCal = (c2 & 0x10) !== 0;
          const amp = intCal ? ((c2 & 0x04 ? 2 : 1) * VREF_UV) / 2400 : 0;
          const fsel = c2 & 3;
          const f = fsel === 0 ? F_CLK / 2 ** 21 : fsel === 1 ? F_CLK / 2 ** 20 : 0;
          const sq = (i: number) => ((((((i - PAD) / FS) * f) % 1) + 1) % 1 < 0.5 ? amp : -amp);
          clipped = internal(f > 0 ? sq : () => amp, g, rail);
          filtered = sinc3Decimate(x, D, PAD, nOut);
          break;
        }
        default: {
          // 110: BIASIN on the P side; 111: BIASIN on the N side (BIASIN tied to BIASOUT).
          const pp = ch.mux === 6 ? biasPin : p;
          const qq = ch.mux === 6 ? q : biasPin;
          if (linear(pp, qq, g, rail)) filtered = linearOut(pp, qq);
          else {
            clipped = pins(pp, qq, g, rail);
            filtered = sinc3Decimate(x, D, PAD, nOut);
          }
        }
      }
      if (ch.mux !== 0 && hasP) act(`CH${ch.n} reads ${MUX_NAME[ch.mux]}, not the electrode on IN${ch.n}P.`, `CH${ch.n}SET`, ch.n);

      // Chip noise (datasheet Tables 1–4), then the 24-bit code.
      const sigma = noiseUvRms(ch.g, dr);
      const u = unitNoise(c, s, ch.n, dr, nOut);
      const lsb = rail / CODE_FS;
      const inv = CODE_FS / rail;
      const top = CODE_FS - 1;
      const bot = -CODE_FS;
      uv = new Float32Array(nOut);
      for (let k = 0; k < nOut; k++) {
        const v = (filtered ? filtered[k] : constant) + sigma * u[k];
        let code = Math.round(v * inv);
        if (code >= top) {
          code = top;
          clipped = true;
        } else if (code <= bot) {
          code = bot;
          clipped = true;
        }
        uv[k] = code * lsb;
      }
      if (clipped && ch.mux === 0 && p.kind === "elec" && q.kind === "elec") {
        if (over || !anaReady) {
          act(
            `CH${ch.n} clips: the input is larger than ±${mvText(rail)} mV, the full scale at gain ×${g}.`,
            `CH${ch.n}SET`,
            ch.n,
          );
        } else if (st.simple) {
          act(
            `CH${ch.n} saturates: the input common-mode voltage is outside the PGA range at gain ×${g} (datasheet Equation 4).`,
            `CH${ch.n}SET`,
            ch.n,
          );
        }
      }
    }

    // Analog column: the voltage between the pins, before the chip.
    let a: Float32Array | null = null;
    if (hasP) {
      if (anaReady) a = displayDecimate(ana, n0);
      else if (linear(p, q, 0, Infinity)) {
        const dp = dispOf(c, p.key, p.e);
        const dq = dispOf(c, q.key, q.e);
        const [dc, kc0] = dCm();
        const kc = (p.c - q.c) * kc0;
        a = new Float32Array(dp.length);
        for (let k = 0; k < a.length; k++) a[k] = dp[k] - dq[k] - kc * dc[k];
      } else {
        pins(p, q, 1, VREF_UV);
        a = displayDecimate(ana, n0);
      }
    }
    analog.push({
      ch: ch.n,
      rate: DISPLAY_RATE,
      uv: a,
      pLabel: hasP ? baseP[i0].label : "open",
      nLabel: s.montage === "srb1" ? (q.kind === "elec" ? "SRB1" : "open") : q.label,
    });
    out.push({ ch: ch.n, rate, uv, rail, clipped, status });
  }

  return { analog, out, flags };
}
