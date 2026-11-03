// The person and the room: what each electrode sees, before the chip.
//
// All signals are in µV. They are sampled at FS = 16 kHz (the fastest ADS1299 data rate),
// over the setup's duration plus PAD samples on each side, so the chip's filter has real data
// at t = 0 and at the end. Sample i is at time (i − PAD) / FS.
//
// Nothing here depends on the registers, so each setup builds its body one time (cached).
// Every random part comes from a seeded generator, so the output is the same each time.

import type { Electrode, Setup } from "./types";
import { gaussArray, rng, type Rng } from "./rng";

export const FS = 16000; // Hz: base analog rate = the fastest data rate (DR 000)
export const PAD = 256; // samples on each side (16 ms); the sinc3 filter needs up to 1.5 × 64
export const DISPLAY_RATE = 1000; // Hz: the analog column (AnalogIn)
export const MAINS_HZ = 60; // US mains

// Supplies of the Cerelog X8 (unipolar 5 V analog supply). µV, relative to AVSS.
export const AVDD_UV = 5e6;
export const MID_UV = AVDD_UV / 2; // (AVDD + AVSS) / 2: the internal BIASREF
export const PGA_HEADROOM_UV = 0.2e6; // datasheet 9.3.1.3.1: amplifier outputs stay 200 mV from the rails
export const DIODE_CLAMP_UV = 0.5e6; // input protection diodes hold a pin about 0.5 V past a rail

/**
 * A pin with nothing to hold its voltage: a high-impedance node. It picks up mains and its
 * DC level drifts (input bias current, datasheet ±300 pA, into ~20 pF).
 * Value relative to mid-supply: amp·sin(2π·60·t + phase) + drift(t).
 */
export interface FloatNode {
  amp: number; // µV, mains pickup
  phase: number; // rad
  d0: number; // µV at t = 0
  d1: number; // µV, where the drift goes
  tau: number; // s
  wander: [number, number, number][]; // slow sines: [Hz, µV, rad]
}

export function drift(p: FloatNode, t: number): number {
  let v = p.d1 + (p.d0 - p.d1) * Math.exp(-Math.max(t, 0) / p.tau);
  for (const [f, a, ph] of p.wander) v += a * Math.sin(2 * Math.PI * f * t + ph);
  return v;
}

export interface Body {
  setup: Setup;
  n0: number; // samples in the duration
  n: number; // samples with the pad
  /** Electrode id → potential relative to the body (offset + biosignal + noise), µV, at FS. */
  elec: Map<string, Float64Array>;
  /**
   * Electrode id → fraction of the body's mains common mode that the pin loses across the
   * electrode impedance (impedance / input impedance at 60 Hz). A difference between the two
   * pins of a channel turns common-mode hum into a differential signal.
   */
  coupling: Map<string, number>;
  mainsPhase: number; // rad, the room's 60 Hz
  /** "IN3P", "IN5N", …: the node a pin floats at when no electrode is on it. */
  floatPin: Map<string, FloatNode>;
  /** Per channel: the internal node for MUX 010 when BIAS_MEAS = 0 (an open input). */
  openInput: FloatNode[];
  /** The body with no bias drive (PD_BIAS = 0). */
  floatBody: FloatNode;
  /** The BIASREF pin, not connected on the X8 (used when BIASREF_INT = 0). */
  floatRef: FloatNode;
}

// ---- tuning constants (one place) ---------------------------------------------------------

/** Coupling scale per setup: scalp cups through hair (EEG) vs gel pads on bare skin. */
export const COUPLING = { eeg: 0.015, eog: 0.004, emg: 0.0015 };

// ---- small signal tools ---------------------------------------------------------------------

/** 0 before t0, 1 after t0 + w, a raised cosine between. */
export function step(t: number, t0: number, w: number): number {
  if (t <= t0) return 0;
  if (t >= t0 + w) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * (t - t0)) / w);
}

/** One-pole low-pass, in place. */
function lowPass(x: Float64Array, fc: number, fs: number) {
  const a = Math.exp((-2 * Math.PI * fc) / fs);
  let y = x[0];
  for (let i = 0; i < x.length; i++) {
    y = a * y + (1 - a) * x[i];
    x[i] = y;
  }
}

/** One-pole high-pass, in place. */
function highPass(x: Float64Array, fc: number, fs: number) {
  const a = Math.exp((-2 * Math.PI * fc) / fs);
  let y = 0;
  let px = x[0];
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    y = a * (y + xi - px);
    px = xi;
    x[i] = y;
  }
}

/** RBJ biquad (Q = 0.707), in place. */
function biquad(x: Float64Array, kind: "lp" | "hp", fc: number, fs: number) {
  const w = (2 * Math.PI * fc) / fs;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const a0 = 1 + al;
  const b0 = kind === "lp" ? (1 - c) / 2 : (1 + c) / 2;
  const b1 = kind === "lp" ? 1 - c : -(1 + c);
  const b2 = b0;
  const a1 = -2 * c;
  const a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** Paul Kellet's pink filter (1/f power), in place. At 1 kHz it is 1/f from about 0.2 Hz up. */
function pink(x: Float64Array) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < x.length; i++) {
    const w = x[i];
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}


// Slow signals (EEG, EOG, envelopes, drift) have nothing above ~100 Hz. The model makes them
// at COARSE = 1 kHz and interpolates to FS: 16× less work, and the same shape.
const COARSE = 1000; // Hz
const UP = FS / COARSE;
const BURN = 3 * COARSE; // samples to let the filters settle

/** Coarse samples that cover n base samples (one more at the end, for the interpolation). */
const coarseLen = (n: number) => Math.floor((n - 1) / UP) + 2;
/** Time of coarse sample j (coarse sample j sits on base sample j·UP). */
const coarseTime = (j: number) => (j * UP - PAD) / FS;

/**
 * Slow noise at the coarse rate, unit rms over the duration.
 * Shape: white or pink, then an optional high-pass and a two-pole low-pass.
 */
function coarseNoise(name: string, m: number, opt: { pink?: boolean; hp?: number; lp?: number }): Float64Array {
  const x = gaussArray(name, BURN + m);
  if (opt.pink) pink(x);
  if (opt.hp) highPass(x, opt.hp, COARSE);
  if (opt.lp) {
    lowPass(x, opt.lp, COARSE);
    lowPass(x, opt.lp, COARSE);
  }
  const c = x.slice(BURN);
  const j0 = Math.ceil(PAD / UP);
  const j1 = m - 1 - j0; // coarse samples inside the duration
  let ss = 0;
  for (let j = j0; j < j1; j++) ss += c[j] * c[j];
  const g = 1 / Math.sqrt(ss / (j1 - j0));
  for (let j = 0; j < m; j++) c[j] *= g;
  return c;
}

/** Linear interpolation from the coarse rate to FS. */
function upsample(c: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.floor(i / UP);
    const f = (i - j * UP) / UP;
    out[i] = c[j] + (c[j + 1] - c[j]) * f;
  }
  return out;
}

/** Slow electrode drift: a few slow sines. */
function slowDrift(g: Rng, uv: number) {
  const parts: [number, number, number][] = [];
  for (let k = 0; k < 3; k++) parts.push([g.range(0.03, 0.25), g.range(0.4, 1) * uv, g.range(0, 2 * Math.PI)]);
  return (t: number) => {
    let v = 0;
    for (const [f, a, ph] of parts) v += a * Math.sin(2 * Math.PI * f * t + ph);
    return v;
  };
}

/** Sum of Gaussian bumps; each bump only near its center (beyond 5 widths it is < 1e-10). */
function bumps(t: number, list: { t: number; a: number; w: number }[]): number {
  let v = 0;
  for (const b of list) {
    const u = (t - b.t) / b.w;
    if (u > -5 && u < 5) v += b.a * Math.exp(-u * u);
  }
  return v;
}

function floatNode(g: Rng, mainsPhase: number, amp: [number, number], d1: [number, number], tau: [number, number]): FloatNode {
  return {
    amp: g.range(amp[0], amp[1]),
    phase: mainsPhase + g.range(-0.5, 0.5),
    d0: g.range(-0.1e6, 0.1e6),
    d1: g.sign() * g.range(d1[0], d1[1]),
    tau: g.range(tau[0], tau[1]),
    wander: [
      [g.range(0.1, 0.4), g.range(5e3, 20e3), g.range(0, 2 * Math.PI)],
      [g.range(0.5, 1.5), g.range(2e3, 8e3), g.range(0, 2 * Math.PI)],
    ],
  };
}

// ---- the three bodies -------------------------------------------------------------------------

function eegBody(s: Setup, n: number, out: Map<string, Float64Array>, g: Rng) {
  const m = coarseLen(n);
  const closed = s.phases.find((p) => /closed/i.test(p.label)) ?? { t0: 3, t1: 7 };
  const alphaSize: Record<string, number> = { O1: 1, O2: 1, P3: 0.6, P4: 0.6, C3: 0.3, C4: 0.3, Fp1: 0.1, Fp2: 0.1 };
  const alphaPhase: Record<string, number> = { O1: 0, O2: 0.15, P3: 0.35, P4: 0.45, C3: 0.8, C4: 0.9, Fp1: 2.5, Fp2: 2.6 };
  const blinkSize: Record<string, number> = { Fp1: 1, Fp2: 0.92, C3: 0.08, C4: 0.08, P3: 0.03, P4: 0.03, O1: 0.02, O2: 0.02 };
  const ALPHA_PEAK = 45; // µV at O1/O2
  const BLINK = 100; // µV at Fp1
  // Blinks only while the eyes are open. The eyes close at closed.t0: a blink-sized
  // deflection, then the eyes roll up (Bell's phenomenon), so Fp stays positive. The eyes
  // open at closed.t1: the level comes back.
  const events = [
    ...[0.8, 2.2, closed.t1 + 0.9, closed.t1 + 2.3].map((t) => ({ t: t + g.range(-0.1, 0.1), a: BLINK, w: 0.1 })),
    { t: closed.t0 + 0.05, a: BLINK * 1.1, w: 0.12 },
    { t: closed.t1 + 0.05, a: BLINK * 0.85, w: 0.1 },
  ];
  const common = coarseNoise(`${s.id}:bg:common`, m, { pink: true, hp: 0.5, lp: 35 });
  const alphaMod = [g.range(0.5, 0.9), g.range(0, 2 * Math.PI)];

  for (const e of s.electrodes) {
    if (e.pin === "BIASOUT") continue;
    const ge = rng(`${s.id}:${e.id}:params`);
    const offset = ge.sign() * ge.range(0.5e3, 4e3);
    const dr = slowDrift(ge, 4);
    const noise = coarseNoise(`${s.id}:${e.id}:noise`, m, {}); // ~1 µV rms, white to ~500 Hz
    const isRef = e.pin === "SRB1";
    const own = coarseNoise(`${s.id}:${e.id}:bg`, m, { pink: true, hp: 0.5, lp: 35 });
    const bgSize = isRef ? 3 : 10; // µV rms; the earlobe has little EEG
    const a = alphaSize[e.id] ?? 0;
    const ph = alphaPhase[e.id] ?? 0;
    const bl = blinkSize[e.id] ?? 0;
    const fp = e.id === "Fp1" ? 1 : e.id === "Fp2" ? 0.92 : 0;
    const x = new Float64Array(m);
    let alphaArg = ph;
    for (let j = 0; j < m; j++) {
      const t = coarseTime(j);
      let v = offset + dr(t) + noise[j] + bgSize * (0.45 * common[j] + 0.89 * own[j]);
      if (a) {
        // Alpha starts ~0.25 s after the eyes close and stops fast when they open.
        const env = step(t, closed.t0 + 0.25, 0.4) * (1 - step(t, closed.t1, 0.12));
        const f = 10 + 0.2 * Math.sin(2 * Math.PI * 0.3 * t);
        alphaArg += (2 * Math.PI * f) / COARSE;
        if (env > 0) {
          const wax = 0.8 + 0.2 * Math.sin(2 * Math.PI * alphaMod[0] * t + alphaMod[1]);
          v += a * ALPHA_PEAK * env * wax * Math.sin(alphaArg);
        }
      }
      if (bl) v += bl * bumps(t, events);
      if (fp) v += fp * 35 * (step(t, closed.t0, 0.25) - step(t, closed.t1, 0.25));
      x[j] = v;
    }
    out.set(e.id, upsample(x, n));
  }
}

function eogBody(s: Setup, n: number, out: Map<string, Float64Array>, g: Rng) {
  const m = coarseLen(n);
  const ANGLE: Record<string, number> = { center: 0, left: 30, right: -30 }; // + = toward the subject's left
  const angleOf = (label: string) => ANGLE[label.toLowerCase()] ?? 0;
  const SACCADE = 0.05; // s
  // Main saccade lands at 92 %; a small corrective saccade 180 ms later finishes it.
  const moves: { t: number; d: number }[] = [];
  for (let k = 1; k < s.phases.length; k++) {
    const d = angleOf(s.phases[k].label) - angleOf(s.phases[k - 1].label);
    const t = s.phases[k].t0 + g.range(0.05, 0.12);
    moves.push({ t, d: 0.92 * d }, { t: t + 0.18, d: 0.08 * d });
  }
  const gaze0 = angleOf(s.phases[0].label);
  const jitter = coarseNoise(`${s.id}:fixation`, m, { lp: 2 }); // fixational drift, ~0.6° rms
  const blinkTimes = [0.45, 4.7, 9.3].map((t) => t + g.range(-0.05, 0.05));
  const ROLE: Record<string, { uvPerDeg: number; offset: number; blink: number }> = {
    L: { uvPerDeg: 10.5, offset: 205e3, blink: 35 },
    R: { uvPerDeg: -9.5, offset: -200e3, blink: 30 },
  };
  for (const e of s.electrodes) {
    if (e.pin === "BIASOUT") continue;
    const ge = rng(`${s.id}:${e.id}:params`);
    const role = ROLE[e.id];
    const offset = role ? role.offset : ge.sign() * ge.range(0.2e3, 1e3);
    const dr = slowDrift(ge, role ? 8 : 3);
    const noise = coarseNoise(`${s.id}:${e.id}:noise`, m, {});
    const bg = coarseNoise(`${s.id}:${e.id}:bg`, m, { pink: true, hp: 1, lp: 40 });
    const blinks = role ? blinkTimes.map((t) => ({ t, a: role.blink, w: 0.1 })) : [];
    const x = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const t = coarseTime(j);
      let v = offset + dr(t) + noise[j] + (role ? 3 : 2) * bg[j];
      if (role) {
        let gaze = gaze0 + 0.6 * jitter[j];
        for (const mv of moves) gaze += mv.d * step(t, mv.t, SACCADE);
        v += role.uvPerDeg * gaze + bumps(t, blinks);
      }
      x[j] = v;
    }
    out.set(e.id, upsample(x, n));
  }
}

function emgBody(s: Setup, n: number, out: Map<string, Float64Array>, g: Rng) {
  const m = coarseLen(n);
  const LEVEL: Record<string, number> = { rest: 5, flex: 150, "hard flex": 400 }; // µV rms
  const levelOf = (label: string) => LEVEL[label.toLowerCase()] ?? 5;
  const RAMP = 0.15; // s: muscle onset and release
  const env = (t: number) => {
    let v = levelOf(s.phases[0].label);
    for (let k = 1; k < s.phases.length; k++) {
      v += (levelOf(s.phases[k].label) - levelOf(s.phases[k - 1].label)) * step(t, s.phases[k].t0, RAMP);
    }
    return v;
  };
  // Pad motion while the muscle works: a slow baseline shift (1–3 Hz), ~100–200 µV.
  const flexWeight = (t: number) => {
    let v = 0;
    for (const p of s.phases) {
      const L = levelOf(p.label);
      if (L <= 5) continue;
      const w = L >= 400 ? 1 : 0.55;
      v += w * (step(t, p.t0, 0.3) - step(t, p.t1, 0.3));
    }
    return v;
  };
  const mo = [g.range(1.2, 1.9), g.range(0, 6.28), g.range(2.2, 3), g.range(0, 6.28)];
  const trem = [g.range(8, 11), g.range(0, 6.28), g.range(1, 1.6), g.range(0, 6.28)];

  // Surface EMG: white noise, band-pass 20–450 Hz (4th order each side), unit rms. Full rate.
  const band = (name: string) => {
    const burn = FS / 2;
    const x = gaussArray(name, burn + n);
    biquad(x, "hp", 20, FS);
    biquad(x, "hp", 20, FS);
    biquad(x, "lp", 450, FS);
    biquad(x, "lp", 450, FS);
    const y = x.slice(burn);
    let ss = 0;
    for (let i = PAD; i < n - PAD; i++) ss += y[i] * y[i];
    const k = 1 / Math.sqrt(ss / (n - 2 * PAD));
    for (let i = 0; i < n; i++) y[i] *= k;
    return y;
  };

  for (const e of s.electrodes) {
    if (e.pin === "BIASOUT") continue;
    const ge = rng(`${s.id}:${e.id}:params`);
    const isMuscle = e.pin === "IN1P";
    const offset = isMuscle ? 2.6e3 : 0.9e3; // µV: gel pad half-cell potentials
    const dr = slowDrift(ge, 3);
    const noise = coarseNoise(`${s.id}:${e.id}:noise`, m, {});
    const emg = band(`${s.id}:${e.id}:emg`);
    const share = isMuscle ? 1 : 0.12; // the elbow pad sees a little of the muscle
    // Coarse parts: the slow level and the EMG gain (envelope × tremor).
    const slow = new Float64Array(m);
    const gain = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const t = coarseTime(j);
      const mod = 1 + 0.12 * Math.sin(2 * Math.PI * trem[0] * t + trem[1]) + 0.1 * Math.sin(2 * Math.PI * trem[2] * t + trem[3]);
      gain[j] = share * env(t) * mod;
      let v = offset + dr(t) + noise[j];
      if (isMuscle) {
        const w = flexWeight(t);
        if (w) v += w * (160 + 140 * (0.6 * Math.sin(2 * Math.PI * mo[0] * t + mo[1]) + 0.4 * Math.sin(2 * Math.PI * mo[2] * t + mo[3])));
      }
      slow[j] = v;
    }
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const j = Math.floor(i / UP);
      const f = (i - j * UP) / UP;
      const sv = slow[j] + (slow[j + 1] - slow[j]) * f;
      const gv = gain[j] + (gain[j + 1] - gain[j]) * f;
      x[i] = sv + gv * emg[i];
    }
    out.set(e.id, x);
  }
}

// ---- build and cache --------------------------------------------------------------------------

function couplings(s: Setup): Map<string, number> {
  const c = new Map<string, number>();
  const scale = COUPLING[s.id];
  for (const e of s.electrodes) {
    const g = rng(`${s.id}:${e.id}:coupling`);
    let u: number;
    if (s.id === "eeg") u = e.pin === "SRB1" ? 1 : g.range(-0.35, 0.35);
    else if (s.id === "eog") u = e.pin === "SRB1" ? 0.6 : g.range(-0.2, 0.2);
    else u = e.pin === "IN1P" ? g.range(0.4, 0.6) : g.range(-0.6, -0.4);
    c.set(e.id, u * scale);
  }
  return c;
}

const PINS = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => [`IN${k}P`, `IN${k}N`]);

const cache = new WeakMap<Setup, Body>();

/** The body for a setup (built one time, then cached). */
export function bodyFor(s: Setup): Body {
  let b = cache.get(s);
  if (b) return b;
  const n0 = Math.round(s.duration * FS);
  const n = n0 + 2 * PAD;
  const g = rng(`${s.id}:body`);
  const mainsPhase = g.range(0, 2 * Math.PI);
  const elec = new Map<string, Float64Array>();
  if (s.id === "eeg") eegBody(s, n, elec, g);
  else if (s.id === "eog") eogBody(s, n, elec, g);
  else emgBody(s, n, elec, g);

  const floatPin = new Map<string, FloatNode>();
  for (const p of PINS) {
    // Tens to hundreds of mV of mains; the DC drifts 0.5–2 V toward a rail in a few seconds.
    floatPin.set(p, floatNode(rng(`${s.id}:float:${p}`), mainsPhase, [80e3, 250e3], [0.5e6, 2e6], [1.5, 5]));
  }
  const openInput = [1, 2, 3, 4, 5, 6, 7, 8].map((k) =>
    // Inside the chip: little mains; leakage moves the node slowly.
    floatNode(rng(`${s.id}:open:${k}`), mainsPhase, [0.5e3, 2e3], [0.05e6, 0.4e6], [2, 6]),
  );
  // No bias drive: large hum on the body, and the DC level runs into a rail in ~1 s.
  const fb = floatNode(rng(`${s.id}:floatbody`), mainsPhase, [1.2e6, 1.6e6], [2.9e6, 3.1e6], [0.4, 0.6]);
  fb.d0 = 0;
  // The BIASREF pin floats: mains pickup, and the DC level runs toward a rail.
  const fr = floatNode(rng(`${s.id}:floatref`), mainsPhase, [100e3, 200e3], [2.6e6, 2.8e6], [0.3, 0.5]);
  fr.d0 = 0;

  b = { setup: s, n0, n, elec, coupling: couplings(s), mainsPhase, floatPin, openInput, floatBody: fb, floatRef: fr };
  cache.set(s, b);
  return b;
}

/** The electrode wired to a pin, if any. */
export function electrodeOn(s: Setup, pin: string): Electrode | undefined {
  return s.electrodes.find((e) => e.pin === pin);
}
