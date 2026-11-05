import { STOCK } from "../puzzle/registers";
import { SETUPS } from "../puzzle/setups";
import type { Bank, SetupId } from "../puzzle/types";

// The puzzle state in localStorage: the open setup, and each setup's firmware, solved mark, and
// how many hints it has shown (0–3).

const KEY = "ads1299-puzzle-v1";

export interface SetupState {
  bank: Bank;
  solved: boolean;
  hints: number; // 0–3: the hints shown so far
}

export interface State {
  current: SetupId;
  setups: Record<SetupId, SetupState>;
}

const isBank = (b: unknown): b is Bank =>
  Array.isArray(b) && b.length === STOCK.length && b.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

const isId = (id: unknown): id is SetupId => SETUPS.some((s) => s.id === id);

export function load(): State {
  const state: State = {
    current: SETUPS[0].id, // the first tab
    setups: { eeg: fresh(), eog: fresh(), emg: fresh() },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") {
      if (isId(saved.current)) state.current = saved.current;
      for (const s of SETUPS) {
        const x = saved.setups?.[s.id];
        if (x && isBank(x.bank)) {
          const hints = Number.isInteger(x.hints) ? Math.min(3, Math.max(0, x.hints)) : 0;
          state.setups[s.id] = { bank: x.bank, solved: x.solved === true, hints };
        }
      }
    }
  } catch {
    // A bad or blocked store: start from STOCK.
  }
  const hash = location.hash.slice(1);
  if (isId(hash)) state.current = hash;
  return state;
}

function fresh(): SetupState {
  return { bank: STOCK.slice(), solved: false, hints: 0 };
}

export function save(state: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full store: the puzzle still works, but it does not remember.
  }
}
