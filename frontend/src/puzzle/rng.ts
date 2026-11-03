// Seeded random numbers. The same seed always gives the same numbers, so the same
// (setup, bank) always gives the same output, bit for bit.

/** 32-bit FNV-1a hash of a string. Use it to make a seed from a name. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast generator. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Normal, mean 0, standard deviation 1 (Box–Muller). */
  gauss(): number;
  /** -1 or +1. */
  sign(): number;
}

export function rng(name: string): Rng {
  const u = mulberry32(hash(name));
  let spare = NaN;
  return {
    next: u,
    range: (lo, hi) => lo + (hi - lo) * u(),
    gauss() {
      if (!Number.isNaN(spare)) {
        const s = spare;
        spare = NaN;
        return s;
      }
      let a = u();
      while (a <= 1e-300) a = u();
      const r = Math.sqrt(-2 * Math.log(a));
      const th = 2 * Math.PI * u();
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    },
    sign: () => (u() < 0.5 ? -1 : 1),
  };
}

/** n samples of white noise: normal, mean 0, standard deviation 1. */
export function gaussArray(name: string, n: number): Float64Array {
  const g = rng(name);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = g.gauss();
  return out;
}
