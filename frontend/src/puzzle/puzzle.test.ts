import { describe, expect, test } from "vitest";
import { GAINS, RATES, SETUPS, STOCK, VREF, match, simulate, targetFor, withRegs } from "./index";
import type { Bank, MatchResult, Setup, SimResult } from "./index";
import { modelOptions } from "./model";
import { NOISE_UVRMS } from "./noise";

const [EEG, EOG, EMG] = SETUPS;
const ALL = [1, 2, 3, 4, 5, 6, 7, 8];

const run = (s: Setup, bank: Bank): MatchResult => match(simulate(s, bank), targetFor(s));
const passing = (m: MatchResult) => m.channels.filter((c) => c.pass).map((c) => c.ch);
const failing = (m: MatchResult) => m.channels.filter((c) => !c.pass).map((c) => c.ch);
/** The same CHnSET value on many channels. */
const chs = (v: number, list: number[]) => Object.fromEntries(list.map((n) => [`CH${n}SET`, v]));
const rms = (x: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
};
const sameBytes = (a: Float32Array | null, b: Float32Array | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

describe("puzzle properties", () => {
  test("1. the target firmware gives the target output exactly (all scores 1)", () => {
    for (const s of SETUPS) {
      const m = run(s, s.target);
      expect(m.pass, s.id).toBe(true);
      for (const c of m.channels) expect(c.score, `${s.id} CH${c.ch}`).toBe(1);
    }
  });

  test("2. STOCK fails every setup", () => {
    for (const s of SETUPS) expect(run(s, STOCK).pass, s.id).toBe(false);
  });

  test("3. STOCK fails the expected channels, for the expected reasons", () => {
    // EEG: weak bias loop (N = 2), 60 Hz hum on every channel.
    expect(failing(run(EEG, STOCK))).toEqual(ALL);
    // EOG: CH1–2 clip at ×24; CH3–8 float.
    const eog = simulate(EOG, STOCK);
    expect(failing(match(eog, targetFor(EOG)))).toEqual(ALL);
    expect(eog.out[0].clipped && eog.out[1].clipped).toBe(true);
    for (const n of [3, 4, 5, 6, 7, 8]) {
      expect(eog.flags.some((f) => f.level === "act" && f.ch === n && f.text === `CH${n} is on, but no electrode is on IN${n}P. The input floats.`)).toBe(true);
    }
    // EMG: CH1 at the wrong rate; CH2–8 float.
    const emg = simulate(EMG, STOCK);
    expect(failing(match(emg, targetFor(EMG)))).toEqual(ALL);
    expect(emg.out[0].rate).toBe(250);
    expect(targetFor(EMG).out[0].rate).toBe(2000);
    for (const n of [2, 3, 4, 5, 6, 7, 8]) expect(emg.flags.some((f) => f.level === "act" && f.ch === n && /inputs float/.test(f.text))).toBe(true);
  });

  test("4. partial fixes give partial progress", () => {
    let m = run(EOG, withRegs(STOCK, chs(0x81, [3, 4, 5, 6, 7, 8])));
    expect(passing(m)).toEqual([3, 4, 5, 6, 7, 8]);
    m = run(EOG, withRegs(STOCK, chs(0x50, [1, 2])));
    expect(passing(m)).toEqual([1, 2]);
    m = run(EMG, withRegs(STOCK, chs(0x81, [2, 3, 4, 5, 6, 7, 8])));
    expect(passing(m)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    m = run(EMG, withRegs(STOCK, { CONFIG1: 0xb3 }));
    expect(passing(m)).toEqual([1]);
  });

  test("5. other right answers pass", () => {
    for (const v of [0x00, 0x01]) expect(run(EEG, withRegs(EEG.target, { BIAS_SENSN: v })).pass, `EEG BIAS_SENSN ${v}`).toBe(true);
    for (const v of [0x81, 0x01, 0x11, 0x21, 0x31, 0x41, 0x51, 0x61]) {
      expect(run(EOG, withRegs(EOG.target, chs(v, [3, 4, 5, 6, 7, 8]))).pass, `EOG CH3–8 ${v.toString(16)}`).toBe(true);
    }
    for (const v of [0x50, 0x40, 0x30, 0x20, 0x10, 0x00]) {
      expect(run(EOG, withRegs(EOG.target, chs(v, [1, 2]))).pass, `EOG CH1–2 ${v.toString(16)}`).toBe(true);
    }
    // EMG CH2–8: every "off" form (PD = 1, any gain, SRB2, MUX).
    for (let v = 0x80; v <= 0xff; v++) {
      const m = run(EMG, withRegs(EMG.target, chs(v, [2, 3, 4, 5, 6, 7, 8])));
      expect(m.pass, `EMG CH2–8 ${v.toString(16)}`).toBe(true);
      expect(m.channels[0].score).toBe(1);
    }
  });

  test("6. wrong answers fail", () => {
    for (const v of [0x01, 0x03, 0x0f]) expect(run(EEG, withRegs(STOCK, { BIAS_SENSP: v })).pass, `EEG BIAS_SENSP ${v}`).toBe(false);
    for (const v of [0xb4, 0xb2]) {
      const m = run(EMG, withRegs(EMG.target, { CONFIG1: v }));
      expect(m.pass, `EMG CONFIG1 ${v.toString(16)}`).toBe(false);
      expect(m.channels[0].pass).toBe(false);
    }
    const m = run(EOG, withRegs(EOG.target, chs(0x60, [1, 2])));
    expect(m.pass, "EOG ×24").toBe(false);
    expect(failing(m)).toEqual([1, 2]);
  });

  test("7. every CONFIG3 edit (31 values) fails all 3 setups, with a CONFIG3 flag", () => {
    const EDITABLE = [7, 6, 5, 3, 2];
    const NAME: Record<number, RegExp> = { 7: /PD_REFBUF/, 6: /bits 6:5/, 5: /bits 6:5/, 3: /BIASREF_INT/, 2: /PD_BIAS/ };
    const values: number[] = [];
    for (let sub = 1; sub < 32; sub++) {
      let v = 0xec;
      EDITABLE.forEach((b, i) => {
        if (sub & (1 << i)) v ^= 1 << b;
      });
      values.push(v);
    }
    expect(new Set(values).size).toBe(31);
    for (const s of SETUPS) {
      const target = targetFor(s);
      // A powered-down channel outputs 0 (datasheet 9.4.4.2), whatever CONFIG3 holds. So the
      // mean is over the channels that are on in the target (EEG 8, EOG 2, EMG 1).
      const live = target.out.filter((o) => o.status === "on").map((o) => o.ch);
      for (const v of values) {
        const tag = `${s.id} CONFIG3 ${v.toString(16)}`;
        const r = simulate(s, withRegs(s.target, { CONFIG3: v }));
        const m = match(r, target);
        expect(m.pass, tag).toBe(false);
        const scores = live.map((ch) => m.channels[ch - 1].score);
        expect(scores.reduce((a, b) => a + b, 0) / scores.length, tag).toBeLessThan(0.5);
        for (const ch of live) expect(m.channels[ch - 1].pass, `${tag} CH${ch}`).toBe(false);
        for (const b of EDITABLE) {
          if (!((v ^ 0xec) & (1 << b))) continue;
          expect(r.flags.some((f) => f.level === "act" && f.reg === "CONFIG3" && NAME[b].test(f.text)), `${tag} bit ${b}`).toBe(true);
        }
        // From STOCK, all 8 channels are on: the mean of all 8 is below 0.5.
        const ms = run(s, withRegs(STOCK, { CONFIG3: v }));
        expect(ms.pass, `${tag} from STOCK`).toBe(false);
        expect(ms.channels.reduce((a, c) => a + c.score, 0) / 8, `${tag} from STOCK`).toBeLessThan(0.5);
      }
    }
  });

  test("8. a floating input in the bias mask puts noise on CH1–2 and gets a flag", () => {
    const stock = simulate(EOG, STOCK);
    const bug = simulate(EOG, withRegs(STOCK, { BIAS_SENSP: 0xff }));
    const flag = bug.flags.find((f) => f.level === "act" && f.reg === "BIAS_SENSP");
    expect(flag?.text).toMatch(/IN3P–IN8P/);
    for (const i of [0, 1]) {
      const d = bug.out[i].uv.map((v, k) => v - stock.out[i].uv[k]);
      expect(rms(d), `CH${i + 1}`).toBeGreaterThan(1000); // µV: more than 1 mV of change
    }
    // With CH1–2 fixed (×12), the same bug makes CH1–2 fail; without it they pass.
    const fixed = withRegs(STOCK, chs(0x50, [1, 2]));
    expect(passing(run(EOG, fixed))).toEqual([1, 2]);
    const m = run(EOG, withRegs(fixed, { BIAS_SENSP: 0xff }));
    expect(m.channels[0].pass || m.channels[1].pass).toBe(false);
    // The BIAS_SENSP bits of channels that are off do nothing (watch only).
    const idle = simulate(EOG, withRegs(EOG.target, { BIAS_SENSP: 0xff }));
    expect(match(idle, targetFor(EOG)).pass).toBe(true);
    expect(idle.flags.every((f) => f.level === "watch")).toBe(true);
  });

  test("9. simulate() takes less than 50 ms per call (warm cache), every setup at every data rate", () => {
    const worst: string[] = [];
    let max = 0;
    for (const s of SETUPS) {
      for (let dr = 0; dr < 7; dr++) {
        const c1 = { CONFIG1: 0xb0 | dr };
        for (const bank of [withRegs(STOCK, c1), withRegs(s.target, c1), withRegs(STOCK, { ...c1, BIAS_SENSP: 0xff })]) {
          simulate(s, bank); // warm the per-setup caches for this rate
          const times: number[] = [];
          for (let k = 0; k < 3; k++) {
            const t0 = performance.now();
            simulate(s, bank);
            times.push(performance.now() - t0);
          }
          const med = times.sort((a, b) => a - b)[1];
          if (med > max) {
            max = med;
            worst.unshift(`${s.id} ${RATES[dr]} SPS: ${med.toFixed(1)} ms`);
          }
        }
      }
    }
    expect(max, worst[0]).toBeLessThan(50);
  }, 60_000);
});

describe("model", () => {
  test("the same (setup, bank) gives the same output, bit for bit", () => {
    for (const s of SETUPS) {
      for (const bank of [STOCK, s.target, withRegs(STOCK, { BIAS_SENSP: 0xff, CONFIG3: 0xe8 })]) {
        const a: SimResult = simulate(s, bank);
        simulate(s, withRegs(bank, { CONFIG1: 0xb0 })); // another call between
        const b: SimResult = simulate(s, bank);
        for (let i = 0; i < 8; i++) {
          expect(sameBytes(a.out[i].uv, b.out[i].uv)).toBe(true);
          expect(sameBytes(a.analog[i].uv, b.analog[i].uv)).toBe(true);
        }
        expect(JSON.stringify(a.flags)).toBe(JSON.stringify(b.flags));
      }
    }
  });

  test("output lengths: duration × rate; analog at 1 kHz, null with no electrode on INxP", () => {
    for (const s of SETUPS) {
      for (let dr = 0; dr < 7; dr++) {
        const r = simulate(s, withRegs(STOCK, { CONFIG1: 0xb0 | dr }));
        expect(r.out).toHaveLength(8);
        expect(r.analog).toHaveLength(8);
        for (const o of r.out) {
          expect(o.rate).toBe(RATES[dr]);
          expect(o.uv.length).toBe(Math.round(s.duration * RATES[dr]));
        }
      }
      const r = simulate(s, s.target);
      for (const a of r.analog) {
        const wired = s.electrodes.some((e) => e.pin === `IN${a.ch}P`);
        expect(a.uv === null, `${s.id} CH${a.ch}`).toBe(!wired);
        expect(a.pLabel === "open").toBe(!wired);
        if (a.uv) expect(a.uv.length).toBe(s.duration * a.rate);
      }
    }
  });

  test("the fast linear path gives the same output as the sample-by-sample path", () => {
    for (const s of SETUPS) {
      for (const bank of [s.target, STOCK, withRegs(s.target, { CONFIG1: 0xb0 }), withRegs(s.target, { CONFIG1: 0xb3 })]) {
        const fast = simulate(s, bank);
        modelOptions.linear = false;
        const slow = simulate(s, bank);
        modelOptions.linear = true;
        for (let i = 0; i < 8; i++) {
          const lsb = fast.out[i].rail / 2 ** 23;
          let worst = 0;
          fast.out[i].uv.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - slow.out[i].uv[k]))));
          expect(worst, `${s.id} CH${i + 1}`).toBeLessThanOrEqual(2 * lsb + 1e-9 * Math.abs(fast.out[i].rail));
          const fa = fast.analog[i].uv;
          const sa = slow.analog[i].uv;
          if (fa && sa) fa.forEach((v, k) => expect(Math.abs(v - sa[k])).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(v)) + 1e-3));
        }
      }
    }
  });

  test("chip noise matches datasheet Tables 1–4 (input shorted)", () => {
    for (const [dr, g] of [
      [6, 0],
      [6, 6],
      [3, 0],
      [3, 6],
      [0, 0],
      [0, 6],
    ]) {
      const r = simulate(EEG, withRegs(STOCK, { CONFIG1: 0xb0 | dr, CH4SET: (g << 4) | 0x01 }));
      const want = NOISE_UVRMS[dr][g];
      expect(rms(r.out[3].uv) / want, `DR ${dr} ×${GAINS[g]}`).toBeGreaterThan(0.95);
      expect(rms(r.out[3].uv) / want, `DR ${dr} ×${GAINS[g]}`).toBeLessThan(1.05);
    }
  });

  test("internal signals: test signal, temperature, supply, off, invalid codes", () => {
    const r = simulate(EEG, withRegs(STOCK, { CH1SET: 0x05, CH2SET: 0x04, CH3SET: 0x03, CH5SET: 0x03, CH6SET: 0x81, CH7SET: 0x70 }));
    const test = r.out[0].uv;
    const amp = (VREF * 1e6) / 2400; // 1875 µV
    expect(Math.max(...test) / amp).toBeCloseTo(1, 2);
    expect(Math.min(...test) / amp).toBeCloseTo(-1, 2);
    let edges = 0;
    for (let k = 1; k < test.length; k++) if (Math.sign(test[k]) !== Math.sign(test[k - 1])) edges++;
    expect(edges).toBeGreaterThanOrEqual(18); // 0.98 Hz square: about 19.5 edges in 10 s
    expect(edges).toBeLessThanOrEqual(21);
    const mean = (x: Float32Array) => x.reduce((a, b) => a + b, 0) / x.length;
    expect(mean(r.out[1].uv)).toBeCloseTo(145300 + 490 * 5, -1); // Eq. 3 at 30 °C
    expect(mean(r.out[2].uv)).toBeCloseTo(3.3e6 / 4, -1); // CH3: DVDD / 4
    expect(mean(r.out[4].uv)).toBeCloseTo(2.5e6, -1); // CH5: (AVDD + AVSS) / 2
    expect(r.out[5].status).toBe("off");
    expect(r.out[5].uv.every((v) => v === 0)).toBe(true);
    expect(r.out[6].status).toBe("invalid");
    expect(r.flags.some((f) => f.level === "act" && f.ch === 7 && /GAIN = 111/.test(f.text))).toBe(true);
    const bad = simulate(EEG, withRegs(STOCK, { CONFIG1: 0xb7 }));
    expect(bad.out.every((o) => o.status === "invalid")).toBe(true);
    expect(match(bad, targetFor(EEG)).channels.every((c) => c.score === 0)).toBe(true);
  });

  test("clipping: the EOG offsets saturate at ×24", () => {
    const r = simulate(EOG, STOCK);
    const rail = (VREF * 1e6) / 24;
    const lsb = rail / 2 ** 23;
    // CH1 (+205 mV) reaches the clip code 7FFFFFh.
    expect(Math.max(...r.out[0].uv)).toBeCloseTo(rail - lsb, 1);
    // CH2 (−200 mV): the bias loop holds the body ~100 mV below mid-supply, so one PGA output
    // reaches its 200 mV headroom first and the reading stops just inside −full scale.
    expect(Math.min(...r.out[1].uv) / -rail).toBeGreaterThan(0.999);
    for (const ch of [1, 2]) {
      expect(r.out[ch - 1].clipped).toBe(true);
      expect(r.flags.some((f) => f.level === "act" && f.ch === ch && /clips/.test(f.text))).toBe(true);
    }
    // ×12 fits: no clip.
    const t = targetFor(EOG);
    expect(t.out[0].clipped || t.out[1].clipped).toBe(false);
  });
});
