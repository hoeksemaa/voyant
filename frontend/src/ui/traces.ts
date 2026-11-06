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
  edges?: boolean; // mark the columns where the trace goes past the top or bottom of the row
  band?: number; // draw a flat band this many css px each way (up and down) from the trace, not a line
}

/**
 * One trace over the full width. Values past the range stop at the row edge, so a trace
 * that leaves the range shows as a bright line on that edge. With style.edges, a red fade
 * also marks that edge.
 */
export function drawTrace(s: Screen, uv: Float32Array, r: Range, style: TraceStyle): void {
  const { ctx, w, h, dpr } = s;
  const n = uv.length;
  if (!n) return;
  const lo = 1;
  const hi = h - 2;
  const per = n / w; // samples per column
  // off[x]: 1 = a sample in column x is well above the row, 2 = well below it.
  // "Well": past the edge by more than OFF_MARGIN of the row height, so a near miss gets no mark.
  const off = style.edges ? new Uint8Array(w) : null;
  const far = OFF_MARGIN * h;
  let i = 0;
  const y = (v: number) => {
    const p = yOf(s, r, v);
    if (p < lo) {
      if (off && p < lo - far) off[Math.min(w - 1, Math.floor(i / per))] |= 1;
      return lo;
    }
    if (p > hi) {
      if (off && p > hi + far) off[Math.min(w - 1, Math.floor(i / per))] |= 2;
      return hi;
    }
    return p;
  };

  // Time density: each sample adds 1 to its column. A sample spreads its 1 over the pixels
  // between it and the last sample, so slopes stay joined. Large jumps between dense samples
  // (mains hum at a low data rate) stay as dots. If the code joins them, they fill the row.
  const dens = new Float32Array(w * h);
  const jump = per < 4 ? Infinity : per < 24 ? h * 0.25 : 0;
  let py = y(uv[0]);
  for (i = 0; i < n; i++) {
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
  // Max filter, one axis at a time. A line: 3 × 3 at 2× pixel ratio, 1 × 2 at 1×. A band: flat,
  // style.band css px up and down, and half that to each side.
  const wide = dpr >= 1.5;
  const b = style.band ? Math.max(1, Math.round(style.band * dpr)) : 0;
  if (b) for (let i = 0; i < lum.length; i++) if (lum[i] > 0) lum[i] = 1;
  const side = b ? Math.ceil(b / 2) : wide ? 1 : 0;
  const up = b || (wide ? 1 : 0);
  const down = b || 1;
  const tmp = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const base = row * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let xx = Math.max(0, x - side); xx <= Math.min(w - 1, x + side); xx++) if (lum[base + xx] > m) m = lum[base + xx];
      tmp[base + x] = m;
    }
  }
  const img = new ImageData(w, h);
  const px = img.data;
  const [cr, cg, cb] = rgb(style.color);
  for (let row = 0; row < h; row++) {
    const base = row * w;
    const r0 = Math.max(0, row - up);
    const r1 = Math.min(h - 1, row + down);
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let rr = r0; rr <= r1; rr++) if (tmp[rr * w + x] > m) m = tmp[rr * w + x];
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

  // The red edge goes under the trace, so the channel color stays on top.
  if (off) drawEdges(s, off);
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

const OFF_RED = "217,45,74"; // status red (#D92D4A)
const OFF_MARGIN = 0.25; // share of the row height

/** A red fade at the top or bottom edge, over the columns where the trace is off the scale. */
function drawEdges(s: Screen, off: Uint8Array): void {
  const { ctx, w, h, dpr } = s;
  const band = 11 * dpr;
  for (const [bit, y0, y1] of [
    [1, 0, band],
    [2, h, h - band],
  ] as const) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, `rgba(${OFF_RED},0.7)`);
    g.addColorStop(1, `rgba(${OFF_RED},0)`);
    ctx.fillStyle = g;
    let x = 0;
    while (x < w) {
      if (!(off[x] & bit)) {
        x++;
        continue;
      }
      const a = x;
      while (x < w && off[x] & bit) x++;
      ctx.fillRect(a, Math.min(y0, y1), x - a, band);
    }
  }
}
