import type { Setup, SetupId } from "../puzzle/types";
import { ChipView } from "./chip-view";
import { CH_INK, pinNo } from "./wiring";

// The home screen: the title, the 3D chip (drag to swivel), and the three levels.
// Short analog signals run in from the left into the IN pins; short digital signals run out of
// DOUT and DRDY to the right. Both fade out before the edge of the screen. Only for show.

const OUT_COLOR = "#b07800"; // serial interface (a deeper tone of the pin view's amber)
const CHECK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 L8.6 13.4 L14.5 7.2"/></svg>`;

type Kind = "emg" | "eog" | "eeg" | "dout" | "drdy";

interface Run {
  pin: number;
  color: string;
  kind: Kind;
  dir: "in" | "out";
  phase: number; // where the first packet starts, 0–1
  slot: number; // start (in) or end (out) height, as a share of the spread
}

const SAMPLES = 72;

export class Home {
  private chip: ChipView | null = null;
  private ctx: CanvasRenderingContext2D;
  private runs: Run[] = [];
  private raf = 0;
  private t0 = 0;
  private still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private tiles = new Map<SetupId, HTMLButtonElement>();

  constructor(
    private root: HTMLElement,
    private hero: HTMLElement,
    private canvas: HTMLCanvasElement,
    setups: Setup[],
    onPlay: (id: SetupId) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    const nav = root.querySelector(".levels")!;
    for (const s of setups) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tile tile-${s.id}`;
      b.innerHTML = `
        <span class="tile-top"><span class="tile-num">${s.level.n}</span><span class="tile-check">${CHECK}</span></span>
        <span class="tile-glyph">${glyph(s.id)}</span>
        <b class="tile-name">${s.name}</b>
        <span class="tile-what">${s.level.what}</span>
        <span class="diff diff-${s.level.difficulty.toLowerCase()}">${s.level.difficulty}</span>`;
      b.setAttribute("aria-label", `Level ${s.level.n}: ${s.name}, ${s.level.what}, ${s.level.difficulty}`);
      b.addEventListener("click", () => onPlay(s.id));
      nav.append(b);
      this.tiles.set(s.id, b);
    }

    // Eight analog inputs (one per channel) and the two digital outputs.
    const kinds: Kind[] = ["emg", "eog", "eeg", "eeg", "eeg", "eeg", "eeg", "eeg"];
    for (let ch = 1; ch <= 8; ch++) {
      this.runs.push({ pin: pinNo(`IN${ch}P`), color: CH_INK[ch - 1], kind: kinds[ch - 1], dir: "in", phase: (ch * 0.137) % 1, slot: 0 });
    }
    this.runs.push({ pin: pinNo("DOUT"), color: OUT_COLOR, kind: "dout", dir: "out", phase: 0.1, slot: 0 });
    this.runs.push({ pin: pinNo("DRDY"), color: OUT_COLOR, kind: "drdy", dir: "out", phase: 0.55, slot: 1 });
    window.addEventListener("resize", () => this.size());
    document.addEventListener("visibilitychange", () => this.loop());
  }

  setSolved(id: SetupId, solved: boolean): void {
    this.tiles.get(id)?.classList.toggle("solved", solved);
  }

  async show(): Promise<void> {
    this.root.hidden = false;
    this.canvas.hidden = false;
    if (!this.chip) {
      this.chip = new ChipView(this.hero, {
        azimuth: 32,
        polar: 44,
        fit: { width: 21, height: 17 },
        swivel: { azimuth: [-15, 80], polar: [18, 66] },
        sway: !this.still,
      });
      this.order();
      this.chip.onFrame(() => {
        if (this.still) this.draw(4); // no animation loop: redraw the wires when the chip turns
      });
    }
    this.size();
    this.chip.wake();
    this.loop();
  }

  hide(): void {
    this.root.hidden = true;
    this.canvas.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private size(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Give each input a start height in the order of its pin on screen, so the wires do not cross.
  private order(): void {
    const ins = this.runs.filter((r) => r.dir === "in");
    const at = ins.map((r) => ({ r, p: this.chip!.pin(r.pin) }));
    at.sort((a, b) => a.p.y - a.p.x * 0.25 - (b.p.y - b.p.x * 0.25));
    at.forEach((a, i) => (a.r.slot = i / (at.length - 1)));
  }

  private loop(): void {
    if (this.raf || this.root.hidden || document.hidden) return;
    const tick = (now: number) => {
      this.raf = 0;
      if (this.root.hidden || document.hidden) return;
      if (!this.t0) this.t0 = now;
      this.draw(this.still ? 4 : (now - this.t0) / 1000);
      if (!this.still) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private draw(time: number): void {
    const chip = this.chip;
    if (!chip) return;
    const { ctx } = this;
    const W = window.innerWidth;
    const H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const hb = this.hero.getBoundingClientRect();
    const c = chip.center();
    const cx = hb.left + c.x;
    const cy = hb.top + c.y;
    const span = Math.min(hb.height * 0.62, 260);

    for (const r of this.runs) {
      const p = chip.pin(r.pin);
      const px = hb.left + p.x;
      const py = hb.top + p.y;
      const reach = 34;
      const ax = px + p.ox * reach;
      const ay = py + p.oy * reach;
      let pts: [number, number][];
      if (r.dir === "in") {
        const sx = -8;
        const sy = cy - span * 0.05 + r.slot * span * 0.62;
        pts = bezier([sx, sy], [sx + (ax - sx) * 0.55, sy], [ax, ay], [px, py]);
      } else {
        const ex = W + 8;
        const ey = cy - span * 0.42 + r.slot * span * 0.14;
        pts = bezier([px, py], [ax, ay], [ex - (ex - ax) * 0.55, ey], [ex, ey]);
      }
      // Fade toward the screen edge: gone before the edge, full strength near the chip.
      const g =
        r.dir === "in"
          ? fade(ctx, 0.02 * W, Math.min(cx - 40, 0.02 * W + Math.max(80, 0.22 * W)), r.color)
          : fade(ctx, 0.98 * W, Math.max(cx + 40, 0.98 * W - Math.max(80, 0.22 * W)), r.color);
      ctx.strokeStyle = g;
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();

      // Packets: a short burst of the signal, riding along the wire.
      const lens = cumulative(pts);
      const L = lens[lens.length - 1];
      const speed = r.dir === "in" ? 70 : 95; // px/s
      const len = r.kind === "dout" ? 74 : r.kind === "drdy" ? 26 : 64;
      const gap = Math.max(L * 0.75, 240);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.7;
      for (let s0 = ((time * speed + r.phase * gap) % gap) - gap; s0 < L + len; s0 += gap) {
        const head = s0;
        const tail = head - len;
        if (head < 0 || tail > L) continue;
        ctx.beginPath();
        let first = true;
        const steps = 44;
        for (let k = 0; k <= steps; k++) {
          const u = tail + (len * k) / steps;
          if (u < 0 || u > L) continue;
          const [x, y, nx, ny] = at(pts, lens, u);
          const v = wave(r.kind, k / steps, r.phase) * (r.kind === "dout" || r.kind === "drdy" ? 4.5 : 6.5);
          const X = x + nx * v;
          const Y = y + ny * v;
          if (first) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
          first = false;
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** A gradient along x: clear at `from`, the full color at `to`. */
function fade(ctx: CanvasRenderingContext2D, from: number, to: number, color: string): CanvasGradient {
  const g = ctx.createLinearGradient(from, 0, to, 0);
  g.addColorStop(0, `${color}00`);
  g.addColorStop(1, color);
  return g;
}

function bezier(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const m = 1 - t;
    out.push([
      m * m * m * a[0] + 3 * m * m * t * b[0] + 3 * m * t * t * c[0] + t * t * t * d[0],
      m * m * m * a[1] + 3 * m * m * t * b[1] + 3 * m * t * t * c[1] + t * t * t * d[1],
    ]);
  }
  return out;
}

function cumulative(pts: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return out;
}

/** The point at arc length u, and the unit normal there. */
function at(pts: [number, number][], lens: number[], u: number): [number, number, number, number] {
  let i = 1;
  while (i < lens.length - 1 && lens[i] < u) i++;
  const f = (u - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]);
  const [x0, y0] = pts[i - 1];
  const [x1, y1] = pts[i];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  return [x0 + dx * f, y0 + dy * f, -dy / l, dx / l];
}

/** One packet's shape, 0–1 along it. Analog packets taper at both ends. */
function wave(kind: Kind, s: number, seed: number): number {
  const win = Math.sin(Math.PI * s) ** 1.5;
  const k = seed * 50;
  switch (kind) {
    case "emg": {
      const burst = Math.sin(Math.PI * s) ** 3;
      return burst * (0.55 * Math.sin(97 * s + k) + 0.45 * Math.sin(151 * s + 2 * k) + 0.35 * Math.sin(223 * s + 3 * k));
    }
    case "eog":
      return win * (s < 0.2 ? 0 : s < 0.25 ? (s - 0.2) / 0.05 : s < 0.7 ? 1 : s < 0.75 ? 1 - (s - 0.7) / 0.05 : 0) - 0.15 * win;
    case "eeg":
      return win * (0.75 * Math.sin(2 * Math.PI * 3.2 * s + k) + 0.25 * Math.sin(2 * Math.PI * 7.3 * s + 1.7 * k));
    case "dout": {
      // 24-bit words as square bits.
      const bits = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1];
      return bits[Math.min(bits.length - 1, Math.floor(s * bits.length))] ? 1 : -1;
    }
    case "drdy":
      return s > 0.25 && s < 0.75 ? -1 : 1; // active low
  }
}

/** A small picture of each level's signal, for the tiles. */
function glyph(id: SetupId): string {
  const n = 60;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    let y = 0;
    if (id === "emg") {
      const e = s > 0.3 && s < 0.75 ? Math.sin((Math.PI * (s - 0.3)) / 0.45) ** 1.5 : 0;
      y = e * 0.9 * (Math.sin(83 * s) * 0.6 + Math.sin(131 * s + 1) * 0.4);
    } else if (id === "eog") {
      y = s < 0.2 ? 0 : s < 0.5 ? 0.75 : s < 0.62 ? 0 : s < 0.88 ? -0.75 : 0;
    } else {
      y = 0.55 * Math.sin(2 * Math.PI * 6 * s) * (0.4 + 0.6 * Math.sin(Math.PI * s)) + 0.15 * Math.sin(2 * Math.PI * 17 * s);
    }
    pts.push(`${(4 + s * 56).toFixed(1)},${(14 - y * 10).toFixed(1)}`);
  }
  return `<svg viewBox="0 0 64 28" aria-hidden="true"><polyline points="${pts.join(" ")}"/></svg>`;
}
