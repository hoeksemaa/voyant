import type { Phase } from "../puzzle/types";

// Trace drawing on canvas, like a phosphor screen: the brightness of a pixel is the share of
// its column's time that the trace spends there. A clean line is bright. A dense band (mains
// hum, EMG) is a soft glow with bright edges, so it never fills a row with flat color.
// 160,000 samples (EMG at 16 kSPS) draw in a few milliseconds.

export interface Range {
  lo: number;
  hi: number;
}

export interface Screen {
  ctx: CanvasRenderingContext2D;
  w: number; // device pixels
  h: number;
  dpr: number;
}

/** Size the canvas to its box at the device pixel ratio. null when the canvas is not shown. */
export function screen(canvas: HTMLCanvasElement): Screen | null {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (cw < 2 || ch < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cw * dpr);
  const h = Math.round(ch * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

const MIN_SPAN = 10; // µV

/** The y range of a trace, with some room above and below. A flat or empty trace gets ±25 µV. */
export function rangeOf(uv: Float32Array | null, flat = false): Range {
  if (!uv || flat) return { lo: -25, hi: 25 };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < uv.length; i++) {
    const v = uv[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { lo: -25, hi: 25 };
  const span = Math.max(hi - lo, MIN_SPAN);
  const mid = (lo + hi) / 2;
  return { lo: mid - span * 0.6, hi: mid + span * 0.6 };
}

/** A value in µV as short text: "40 µV", "1.4 mV", "205 mV". */
export function fmtUv(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)} V`;
  if (a >= 1000) return `${+(v / 1000).toPrecision(a >= 10000 ? 3 : 2)} mV`;
  return `${+v.toPrecision(2)} µV`;
}

/** Short text for a range: "±40 µV", or "205 mV ±480 µV" when the trace sits on an offset. */
export function rangeText(r: Range): string {
  const mid = (r.lo + r.hi) / 2;
  const half = (r.hi - r.lo) / 2;
  if (Math.abs(mid) < half) return `±${fmtUv(Math.max(Math.abs(r.lo), Math.abs(r.hi)))}`;
  return `${fmtUv(mid)} ±${fmtUv(half)}`;
}

/** Time grid (1 s), phase boundaries, and a zero line when 0 is in range. */
export function drawGrid(s: Screen, duration: number, phases: Phase[], r: Range | null): void {
  const { ctx, w, h, dpr } = s;
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  for (let t = 1; t < duration; t++) ctx.fillRect(Math.round((t / duration) * w), 0, dpr, h);
  ctx.fillStyle = "rgba(255,255,255,0.11)";
  for (const p of phases.slice(1)) {
    const x = Math.round((p.t0 / duration) * w);
    for (let y = 0; y < h; y += 4 * dpr) ctx.fillRect(x, y, dpr, 2 * dpr);
  }
  if (r && r.lo < 0 && r.hi > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, Math.round(yOf(s, r, 0)), w, dpr);
  }
}

const PAD = 3; // css px between the trace and the row edge

function yOf(s: Screen, r: Range, v: number): number {
  const top = PAD * s.dpr;
  const bottom = s.h - PAD * s.dpr;
  return bottom - ((v - r.lo) / (r.hi - r.lo)) * (bottom - top);
}

// One scratch canvas for all traces: the density image goes here, then onto the row.
const scratch = document.createElement("canvas");
const sctx = scratch.getContext("2d")!;
const hasFilter = "filter" in sctx;

const rgbCache = new Map<string, [number, number, number]>();
function rgb(color: string): [number, number, number] {
  let c = rgbCache.get(color);
  if (!c) {
    const n = parseInt(color.slice(1), 16);
    rgbCache.set(color, (c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]));
  }
  return c;
}

export interface TraceStyle {
  color: string; // "#rrggbb"
  glow?: boolean; // a soft halo (output and analog); none on the quiet target
  alpha?: number;
}

/**
 * One trace over the full width. Values past the range stop at the row edge, so a trace
 * that leaves the range shows as a bright line on that edge.
 */
export function drawTrace(s: Screen, uv: Float32Array, r: Range, style: TraceStyle): void {
  const { ctx, w, h, dpr } = s;
  const n = uv.length;
  if (!n) return;
  const lo = 1;
  const hi = h - 2;
  const y = (v: number) => {
    const p = yOf(s, r, v);
    return p < lo ? lo : p > hi ? hi : p;
  };

  // Time density: each sample adds 1 to its column. A sample spreads its 1 over the pixels
  // between it and the last sample, so slopes stay joined. Large jumps between dense samples
  // (mains hum at a low data rate) stay as dots. If the code joins them, they fill the row.
  const dens = new Float32Array(w * h);
  const per = n / w; // samples per column
  const jump = per < 4 ? Infinity : per < 24 ? h * 0.25 : 0;
  let py = y(uv[0]);
  for (let i = 0; i < n; i++) {
    const x = Math.min(w - 1, Math.floor(i / per));
    const yy = y(uv[i]);
    if (Math.abs(yy - py) < jump) {
      const a = Math.floor(Math.min(py, yy));
      const b = Math.floor(Math.max(py, yy));
      const k = 1 / (b - a + 1);
      for (let row = a; row <= b; row++) dens[row * w + x] += k;
      // Fewer samples than columns: fill the columns between this sample and the next.
      if (per < 1) {
        const x1 = Math.min(w - 1, Math.floor((i + 1) / per));
        for (let xx = x + 1; xx < x1; xx++) dens[Math.floor(yy) * w + xx] += 1;
      }
    } else {
      dens[Math.floor(yy) * w + x] += 1;
    }
    py = yy;
  }

  // Brightness: square root of the time share, with a floor so a thin edge stays visible.
  // Then a small max filter gives the line its width (about 1.5 css px).
  const norm = 1 / Math.max(per, 1);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) {
    const d = dens[i];
    if (d > 0) lum[i] = Math.min(1, Math.max(0.14, 2.5 * Math.sqrt(d * norm)));
  }
  // Max filter, one axis at a time: 3 × 3 at 2× pixel ratio, 1 × 2 at 1×.
  const wide = dpr >= 1.5;
  const tmp = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const base = row * w;
    for (let x = 0; x < w; x++) {
      let m = lum[base + x];
      if (wide) {
        if (x > 0 && lum[base + x - 1] > m) m = lum[base + x - 1];
        if (x < w - 1 && lum[base + x + 1] > m) m = lum[base + x + 1];
      }
      tmp[base + x] = m;
    }
  }
  const img = new ImageData(w, h);
  const px = img.data;
  const [cr, cg, cb] = rgb(style.color);
  for (let row = 0; row < h; row++) {
    const base = row * w;
    const up = row > 0 ? base - w : -1;
    const down = row < h - 1 ? base + w : -1;
    for (let x = 0; x < w; x++) {
      let m = tmp[base + x];
      if (down >= 0 && tmp[down + x] > m) m = tmp[down + x];
      if (wide && up >= 0 && tmp[up + x] > m) m = tmp[up + x];
      if (m > 0) {
        const o = (base + x) * 4;
        px[o] = cr;
        px[o + 1] = cg;
        px[o + 2] = cb;
        px[o + 3] = Math.round(m * 255);
      }
    }
  }
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w);
    scratch.height = Math.max(scratch.height, h);
  }
  sctx.clearRect(0, 0, w, h);
  sctx.putImageData(img, 0, 0);

  const alpha = style.alpha ?? 1;
  if (style.glow && hasFilter) {
    ctx.filter = `blur(${2.5 * dpr}px)`;
    ctx.globalAlpha = 0.55 * alpha;
    ctx.drawImage(scratch, 0, 0, w, h, 0, 0, w, h);
    ctx.filter = "none";
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(scratch, 0, 0, w, h, 0, 0, w, h);
  ctx.globalAlpha = 1;
}

/** No electrode: a dotted line at mid-height. */
export function drawOpen(s: Screen): void {
  const { ctx, w, h, dpr } = s;
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  const y = Math.round(h / 2);
  for (let x = 0; x < w; x += 6 * dpr) ctx.fillRect(x, y, 2 * dpr, dpr);
}
