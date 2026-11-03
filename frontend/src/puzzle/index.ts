// The puzzle's public API: the model, the match, the target output, and the contract data.

import type { Setup, SimResult } from "./types";
import { simulate } from "./model";

export * from "./types";
export { SETUPS } from "./setups";
export { REGISTERS, STOCK, byName, field, withRegs, rejectReason, VREF, GAINS, RATES } from "./registers";
export { simulate } from "./model";
export { match, PASS_ERR, FLOOR_UV } from "./match";

const targets = new WeakMap<Setup, SimResult>();

/** The target output of a setup: simulate(setup, setup.target), computed one time. */
export function targetFor(setup: Setup): SimResult {
  let t = targets.get(setup);
  if (!t) {
    t = simulate(setup, setup.target);
    targets.set(setup, t);
  }
  return t;
}
