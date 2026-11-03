import { drawTrace, rangeOf, rangeText, screen, type Range } from "./traces";

// The lens: point at a trace to see 0.25 s of it up close. At 10 s across a row, mains hum and
// EMG are bands; in the lens they are waves, and each sample of the output is a step.

export const LENS_SPAN = 0.25; // seconds

export interface LensTrace {
  uv: Float32Array;
  rate: number;
  color: string;
  glow: boolean;
}

function slice(tr: LensTrace, t0: number, t1: number): Float32Array {
  const i0 = Math.max(0, Math.floor(t0 * tr.rate));
  const i1 = Math.min(tr.uv.length, Math.ceil(t1 * tr.rate));
  return tr.uv.subarray(i0, Math.max(i0 + 1, i1));
}

export class Lens {
  private el = document.createElement("div");
  private title = document.createElement("span");
  private scale = document.createElement("span");
  private canvas = document.createElement("canvas");

  constructor() {
    this.el.className = "lens";
    this.el.hidden = true;
    const head = document.createElement("div");
    head.className = "lens-head";
    head.append(this.title, this.scale);
    this.el.append(head, this.canvas);
    document.body.append(this.el);
  }

  /**
   * Show the window that starts at t0 for one channel. `at` is the row: the lens sits over it
   * (or under it, near the top of the page), aligned with its column.
   */
  show(label: string, t0: number, traces: LensTrace[], at: DOMRect, align: "left" | "right"): void {
    const t1 = t0 + LENS_SPAN;
    const parts = traces.map((tr) => ({ tr, uv: slice(tr, t0, t1) }));
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of parts) {
      const r = rangeOf(p.uv);
      lo = Math.min(lo, r.lo);
      hi = Math.max(hi, r.hi);
    }
    const range: Range = { lo, hi };
    this.title.textContent = `${label} · ${t0.toFixed(2)}–${t1.toFixed(2)} s`;
    this.scale.textContent = rangeText(range);
    this.el.hidden = false;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = align === "left" ? at.left : at.right - w;
    const above = at.top - h - 8;
    this.el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, left))}px`;
    this.el.style.top = `${above > 64 ? above : at.bottom + 8}px`;
    const s = screen(this.canvas);
    if (!s) return;
    const { ctx, w: cw, h: ch, dpr } = s;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let k = 1; k < 5; k++) ctx.fillRect(Math.round((k / 5) * cw), 0, dpr, ch);
    for (const p of parts) drawTrace(s, p.uv, range, { color: p.tr.color, glow: p.tr.glow });
  }

  hide(): void {
    this.el.hidden = true;
  }
}
