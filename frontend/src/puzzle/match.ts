// Compare the chip's output with the target output, channel by channel.

import type { ChannelMatch, ChannelOut, MatchResult, SimResult } from "./types";

/** Error floor, µV: a flat target (off channel) still allows this much noise in the error scale. */
export const FLOOR_UV = 5;
/**
 * A channel passes when err ≤ PASS_ERR (score ≥ 1 − PASS_ERR).
 * 0.25 lets a shorted channel at gain ×1 (1.08 µV rms noise at 250 SPS, datasheet Table 1) pass
 * where the target channel is off, and still fails every wrong answer in the puzzle tests.
 */
export const PASS_ERR = 0.25;

/**
 * err = rms(actual − target) / max(rms(target − mean(target)), FLOOR_UV).
 * score = clamp(1 − err, 0, 1). An invalid output always fails. A different data rate fails,
 * but not when the target channel is off: an off channel is all zeros at any rate, so the
 * actual output is compared with 0 on its own sample grid.
 */
export function matchChannel(a: ChannelOut, t: ChannelOut): ChannelMatch {
  const fail = { ch: t.ch, score: 0, pass: false };
  if ((a.status === "invalid") !== (t.status === "invalid")) return fail;
  if (t.status === "off" && a.rate !== t.rate) {
    let sd = 0;
    for (let k = 0; k < a.uv.length; k++) sd += a.uv[k] * a.uv[k];
    const err = a.uv.length ? Math.sqrt(sd / a.uv.length) / FLOOR_UV : 0;
    return { ch: t.ch, score: Math.min(1, Math.max(0, 1 - err)), pass: err <= PASS_ERR };
  }
  if (a.rate !== t.rate || a.uv.length !== t.uv.length) return fail;
  const n = t.uv.length;
  if (n === 0) return { ch: t.ch, score: 1, pass: true };
  let mean = 0;
  for (let k = 0; k < n; k++) mean += t.uv[k];
  mean /= n;
  let st = 0;
  let sd = 0;
  for (let k = 0; k < n; k++) {
    const tv = t.uv[k];
    const dt = tv - mean;
    const d = a.uv[k] - tv;
    st += dt * dt;
    sd += d * d;
  }
  const err = Math.sqrt(sd / n) / Math.max(Math.sqrt(st / n), FLOOR_UV);
  const score = Math.min(1, Math.max(0, 1 - err));
  return { ch: t.ch, score, pass: err <= PASS_ERR };
}

export function match(actual: SimResult, target: SimResult): MatchResult {
  const channels = target.out.map((t, i) => matchChannel(actual.out[i], t));
  return { channels, pass: channels.every((c) => c.pass) };
}
