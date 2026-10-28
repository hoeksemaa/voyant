// The simulation run that the Python backend writes (backend/ads1299/export.py).

export interface ProbeInfo {
  id: string;
  label: string;
  pins: number[];
  unit: string;
  lo: number;
  hi: number;
}

export type Status = "pass" | "warn" | "fail";

export interface StepCheck {
  rule: string;
  status: Status;
  t: number;
  detail: string;
  count: number;
}

export type StepEvent = [t0: number, t1: number, kind: string, text: string];

export interface StepData {
  title: string;
  text: string;
  quote: string;
  cite: string;
  t0: number; // real time, seconds
  t1: number;
  view: number; // playback length, seconds
  n: number; // samples per probe
  data: Record<string, string | number | null>;
  events: StepEvent[];
  notes: [t: number, text: string][];
  checks: StepCheck[];
}

export interface SequenceData {
  id: string;
  title: string;
  summary: string;
  steps: StepData[];
}

export interface RunData {
  probes: ProbeInfo[];
  rules: Record<string, { title: string; cite: string; quote: string }>;
  sequences: SequenceData[];
}

// Low and high value in each sample interval (a scope's peak detect). NaN = not driven.
export interface Trace {
  lo: Float32Array;
  hi: Float32Array;
  constant: boolean;
}

let loading: Promise<RunData> | null = null;

export function loadRun(): Promise<RunData> {
  loading ??= fetch("/sim/run.json").then((r) => {
    if (!r.ok) throw new Error(`run.json: ${r.status}`);
    return r.json();
  });
  return loading;
}

const decoded = new WeakMap<StepData, Map<string, Trace>>();

export function trace(step: StepData, probe: ProbeInfo): Trace {
  let byProbe = decoded.get(step);
  if (!byProbe) decoded.set(step, (byProbe = new Map()));
  const hit = byProbe.get(probe.id);
  if (hit) return hit;

  const raw = step.data[probe.id];
  const lo = new Float32Array(step.n);
  const hi = new Float32Array(step.n);
  let constant = true;
  if (raw === null || raw === undefined) {
    lo.fill(NaN);
    hi.fill(NaN);
  } else if (typeof raw === "number") {
    lo.fill(raw);
    hi.fill(raw);
  } else {
    constant = false;
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const q = new Int16Array(bytes.buffer);
    const scale = (probe.hi - probe.lo) / 65000;
    for (let i = 0; i < step.n; i++) {
      const a = q[2 * i];
      const b = q[2 * i + 1];
      lo[i] = a === -32768 ? NaN : (a + 32500) * scale + probe.lo;
      hi[i] = b === -32768 ? NaN : (b + 32500) * scale + probe.lo;
    }
  }
  const t = { lo, hi, constant };
  byProbe.set(probe.id, t);
  return t;
}

// "2.5 ms", "4.0 µs", "1.00 s"
export function formatTime(s: number): string {
  const a = Math.abs(s);
  if (a >= 1) return `${s.toFixed(a >= 10 ? 1 : 2)} s`;
  if (a >= 1e-3) return `${(s * 1e3).toFixed(a >= 10e-3 ? 0 : 1)} ms`;
  return `${(s * 1e6).toFixed(a >= 10e-6 ? 0 : 1)} µs`;
}
