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

export interface Speed {
  id: string;
  label: string;
  rate: number; // real seconds per second of playback
}

export interface RunIndex {
  screen: number; // playback seconds across one scope screen
  lead: number;
  sps: number; // samples per playback second
  speeds: Speed[];
  probes: ProbeInfo[];
  rules: Record<string, { title: string; cite: string; quote: string }>;
  sequences: { id: string; title: string; summary: string }[];
}

// A stretch of real time that plays without a skip. Data starts one screen before `tp`.
export interface Region {
  t0: number;
  tp: number;
  t1: number;
  n: number;
  data: Record<string, string | number | null>;
  events: StepEvent[];
}

export interface StepData {
  id: string;
  title: string;
  text: string;
  quote: string;
  cite: string;
  anchor: number; // real time of the step's moment
  region: number;
  p0: number; // playback seconds into the region where the step starts
  notes: [t: number, text: string][];
  checks: StepCheck[];
}

// One sequence at one speed.
export interface Clip {
  regions: Region[];
  steps: StepData[];
}

// Low and high value in each sample interval (a scope's peak detect). NaN = not driven.
export interface Trace {
  lo: Float32Array;
  hi: Float32Array;
  constant: boolean;
}

function fetchJson<T>(path: string): Promise<T> {
  return fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });
}

let index: Promise<RunIndex> | null = null;

export function loadRun(): Promise<RunIndex> {
  index ??= fetchJson<RunIndex>("/sim/run.json");
  return index;
}

const clips = new Map<string, Promise<Clip>>();

export function loadClip(seq: string, speed: string): Promise<Clip> {
  const key = `${seq}.${speed}`;
  let c = clips.get(key);
  if (!c) {
    c = fetchJson<Clip>(`/sim/${key}.json`);
    c.catch(() => clips.delete(key)); // let a later call try again
    clips.set(key, c);
  }
  return c;
}

const decoded = new WeakMap<Region, Map<string, Trace>>();

export function trace(region: Region, probe: ProbeInfo): Trace {
  let byProbe = decoded.get(region);
  if (!byProbe) decoded.set(region, (byProbe = new Map()));
  const hit = byProbe.get(probe.id);
  if (hit) return hit;

  const raw = region.data[probe.id];
  const lo = new Float32Array(region.n);
  const hi = new Float32Array(region.n);
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
    for (let i = 0; i < region.n; i++) {
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
  if (a < 5e-10) return "0 s";
  if (a >= 1) return `${s.toFixed(a >= 10 ? 1 : 2)} s`;
  if (a >= 1e-3) return `${(s * 1e3).toFixed(a >= 10e-3 ? 0 : 1)} ms`;
  if (a >= 1e-6) return `${(s * 1e6).toFixed(a >= 10e-6 ? 0 : 1)} µs`;
  return `${(s * 1e9).toFixed(0)} ns`;
}
