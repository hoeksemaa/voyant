import { GAINS, RATES, VREF } from "../puzzle/registers";
import type { AnalogIn, Bank, ChannelOut, Flag, MatchResult, Setup, SimResult } from "../puzzle/types";

// A stand-in for the real model (src/puzzle/model.ts and match.ts), with the same signatures.
// The shapes are only plausible: enough to judge the layout. The integrator swaps it out.

const BASE = 16000; // samples per second of the body signals
const ANALOG_RATE = 1000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

const ramp = (t: number, t0: number, t1: number, w = 0.15) =>
  Math.min(1, Math.max(0, (t - t0) / w + 0.5)) * Math.min(1, Math.max(0, (t1 - t) / w + 0.5));

const bump = (t: number, t0: number, w: number) => Math.exp(-(((t - t0) / w) ** 2));

// The body signal on each channel (INnP − INnN, µV) at 16 kHz, before hum. null: no electrode.
const bodyCache = new Map<string, (Float32Array | null)[]>();

function body(setup: Setup): (Float32Array | null)[] {
  const hit = bodyCache.get(setup.id);
  if (hit) return hit;
  const n = BASE * setup.duration;
  const out = [1, 2, 3, 4, 5, 6, 7, 8].map((ch) => {
    const e = setup.electrodes.find((x) => x.pin === `IN${ch}P`);
    if (!e) return null;
    const r = rng(ch * 7919 + setup.id.charCodeAt(1));
    const v = new Float32Array(n);
    if (setup.id === "eeg") {
      const size = e.id.startsWith("O") ? 1 : e.id.startsWith("P") ? 0.6 : e.id.startsWith("C") ? 0.3 : 0.1;
      const waves = Array.from({ length: 12 }, (_, k) => ({ f: 1 + k * 2.3 + r(), a: 9 / (1 + k * 0.6), p: r() * 6.3 }));
      let bg = 0;
      for (let i = 0; i < n; i++) {
        const t = i / BASE;
        if (i % 16 === 0) {
          bg = 0;
          for (const w of waves) bg += 0.35 * w.a * Math.sin(2 * Math.PI * w.f * t + w.p);
        }
        let x = bg + gauss(r) * 0.8;
        x += 45 * size * ramp(t, 3, 7, 0.4) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.6 * t)) * Math.sin(2 * Math.PI * 10.2 * t);
        if (e.id.startsWith("Fp")) x += 140 * (bump(t, 1.2, 0.08) + bump(t, 8.4, 0.08)) + 90 * bump(t, 3, 0.12);
        v[i] = x;
      }
    } else if (setup.id === "eog") {
      const sign = e.id === "L" ? 1 : -1;
      const offset = e.id === "L" ? 205000 : -200000;
      for (let i = 0; i < n; i++) {
        const t = i / BASE;
        const gaze = 360 * (ramp(t, 1, 3.5, 0.05) - ramp(t, 5.5, 8, 0.05));
        const blink = 120 * (bump(t, 0.5, 0.07) + bump(t, 4.6, 0.07) + bump(t, 9.1, 0.07));
        v[i] = offset + sign * gaze + blink + 25 * Math.sin(2 * Math.PI * 0.07 * t) + gauss(r) * 1.5;
      }
    } else {
      let lp = 0;
      let hp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / BASE;
        const env = 5 + 145 * ramp(t, 2, 4.5, 0.3) + 395 * ramp(t, 6.5, 9, 0.3);
        // Band-limit white noise to about 20–450 Hz with two one-pole filters.
        const w = gauss(r);
        lp += 0.16 * (w - lp);
        hp += 0.008 * (lp - hp);
        const shift = 150 * (ramp(t, 2, 4.5, 0.3) + ramp(t, 6.5, 9, 0.3)) * Math.sin(2 * Math.PI * 1.8 * t);
        v[i] = env * 3.2 * (lp - hp) + shift;
      }
    }
    return v;
  });
  bodyCache.set(setup.id, out);
  return out;
}

// Average blocks of the 16 kHz signal down to `rate` (a crude digital filter).
function decimate(v: Float32Array, rate: number): Float32Array {
  const k = Math.round(BASE / rate);
  const out = new Float32Array(Math.floor(v.length / k));
  for (let j = 0; j < out.length; j++) {
    let s = 0;
    for (let i = j * k; i < j * k + k; i++) s += v[i];
    out[j] = s / k;
  }
  return out;
}

const bits = (x: number) => x.toString(2).replace(/0/g, "").length;

export function simulate(setup: Setup, bank: Bank): SimResult {
  const flags: Flag[] = [];
  const dr = bank[1] & 7;
  const config1Bad = (bank[1] & 0x98) !== 0x90 || dr === 7;
  const config3 = bank[3];
  if (config1Bad) flags.push({ level: "act", reg: "CONFIG1", text: "CONFIG1 has a reserved or invalid value. The output is not valid." });
  if (config3 !== 0xec) {
    const why = !(config3 & 0x80)
      ? "The reference buffer is off. No code is valid."
      : (config3 & 0x60) !== 0x60
        ? "Bits 6:5 are reserved and must be 11."
        : !(config3 & 0x04)
          ? "The bias buffer is off. The body floats to a rail."
          : "BIASREF is external, and that pin floats on the X8. All channels saturate.";
    flags.push({ level: "act", reg: "CONFIG3", text: `CONFIG3: ${why}` });
  }
  const rate = RATES[Math.min(dr, 6)];
  const n = rate * setup.duration;
  const sig = body(setup);

  // Bias loop: inputs in the mask that have an electrode and are in use.
  const live = (ch: number) => !(bank[4 + ch] & 0x80) && (bank[4 + ch] & 7) === 0;
  const hasP = (ch: number) => sig[ch - 1] !== null;
  let loop = 0;
  let floatInLoop = false;
  for (let ch = 1; ch <= 8; ch++) {
    if (bank[0x0d] & (1 << (ch - 1))) {
      if (live(ch) && hasP(ch)) loop++;
      else if (live(ch)) floatInLoop = true;
    }
    if (bank[0x0e] & (1 << (ch - 1)) && live(ch)) loop++;
  }
  if (floatInLoop) flags.push({ level: "act", reg: "BIAS_SENSP", text: "A floating input is in the bias loop. Its noise goes into the body." });
  const humScale = setup.id === "eeg" ? 1 : 0.08;
  const hum = (900 / (1 + loop ** 2.2)) * humScale + (floatInLoop ? 900 : 0);

  const out: ChannelOut[] = [];
  const analog: AnalogIn[] = [];
  for (let ch = 1; ch <= 8; ch++) {
    const reg = bank[4 + ch];
    const pd = reg >> 7;
    const g = (reg >> 4) & 7;
    const mux = reg & 7;
    const gain = GAINS[Math.min(g, 6)];
    const rail = (VREF / gain) * 1e6;
    const r = rng(ch * 31 + dr * 7 + g);
    const coupling = 0.4 + 0.6 * ((ch * 0.37) % 1);
    const humAt = (t: number) => hum * coupling * Math.sin(2 * Math.PI * 60 * t + ch);
    const s = sig[ch - 1];
    const e = setup.electrodes.find((x) => x.pin === `IN${ch}P`);
    const nE = setup.montage === "srb1" ? "SRB1" : (setup.electrodes.find((x) => x.pin === `IN${ch}N`)?.id ?? "open");

    let a: Float32Array | null = null;
    if (s) {
      a = decimate(s, ANALOG_RATE);
      for (let i = 0; i < a.length; i++) a[i] += humAt(i / ANALOG_RATE);
    }
    analog.push({ ch, rate: ANALOG_RATE, uv: a, pLabel: e?.id ?? "open", nLabel: nE });

    const uv = new Float32Array(n);
    let status: ChannelOut["status"] = "on";
    const invalid = config1Bad || g === 7 || !(config3 & 0x80) || (config3 & 0x60) !== 0x60;
    if (g === 7) flags.push({ level: "act", ch, reg: `CH${ch}SET`, text: `CH${ch}: gain 111 is not a valid gain.` });
    if (pd) {
      status = "off";
    } else if (invalid) {
      status = "invalid";
      for (let i = 0; i < n; i++) uv[i] = (r() * 2 - 1) * rail;
    } else if (config3 !== 0xec) {
      // The body floats: hum, then a drift to a rail.
      for (let i = 0; i < n; i++) uv[i] = rail * (Math.min(1, i / rate / 1.5) + 0.3 * Math.sin(2 * Math.PI * 60 * (i / rate)));
    } else if (mux === 0 && !s) {
      flags.push({ level: "act", ch, reg: `CH${ch}SET`, text: `CH${ch} is on, but no electrode is on IN${ch}P. The input floats.` });
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        uv[i] = 1.6 * rail * Math.sin(2 * Math.PI * 60 * t + ch) + rail * 0.8 * Math.tanh(t - 2);
      }
    } else if (mux === 0 && s) {
      const d = decimate(s, rate);
      for (let i = 0; i < n; i++) uv[i] = d[i] + humAt(i / rate) + gauss(r) * 0.6;
    } else {
      const level = [0, 0, 0, 1.25e6, 160000, 0, 0, 0][mux];
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const test = mux === 5 ? (Math.floor(t * 0.98 * 2) % 2 ? 937.5 : -937.5) : 0;
        uv[i] = level + test + gauss(r) * 0.8;
      }
    }
    let clipped = false;
    for (let i = 0; i < n; i++) {
      if (uv[i] >= rail) [uv[i], clipped] = [rail, true];
      else if (uv[i] <= -rail) [uv[i], clipped] = [-rail, true];
    }
    out.push({ ch, rate, uv, rail, clipped, status });
  }
  if (bits(bank[0x0d]) + bits(bank[0x0e]) === 0) flags.push({ level: "watch", reg: "BIAS_SENSP", text: "The bias mask is empty. The bias loop does not cancel hum." });
  return { analog, out, flags };
}

const targets = new Map<string, SimResult>();
export function targetFor(setup: Setup): SimResult {
  let t = targets.get(setup.id);
  if (!t) targets.set(setup.id, (t = simulate(setup, setup.target)));
  return t;
}

export function match(actual: SimResult, target: SimResult): MatchResult {
  const channels = target.out.map((t, k) => {
    const a = actual.out[k];
    let score = 0;
    if (a.rate === t.rate && (t.status === "off") === (a.status === "off") && a.status !== "invalid") {
      let mean = 0;
      for (const v of t.uv) mean += v;
      mean /= t.uv.length;
      let e = 0;
      let s = 0;
      for (let i = 0; i < t.uv.length; i++) {
        e += (a.uv[i] - t.uv[i]) ** 2;
        s += (t.uv[i] - mean) ** 2;
      }
      const err = Math.sqrt(e / t.uv.length) / Math.max(Math.sqrt(s / t.uv.length), 5);
      score = Math.min(1, Math.max(0, 1 - err));
    }
    return { ch: t.ch, score, pass: score >= 0.85 };
  });
  return { channels, pass: channels.every((c) => c.pass) };
}
