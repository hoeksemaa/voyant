import * as THREE from "three";
import { PKG } from "../package-dims";
import { HALF, pinPoint } from "../pin-layout";
import { GROUPS, PINS, pinDir, type Pin } from "../pins";
import type { Setup, SetupId } from "../puzzle/types";
import { ChipView } from "./chip-view";
import { BIAS_COLOR, CH_INK, REF_COLOR, SERIAL_INK } from "./wiring";

// The home screen: the title, the 3D chip, and the three levels.
// Each of the 64 pins has a signal line. "In" lines (see pinDir) come in from the left edge of the
// screen; "out" lines leave to the right edge. They use the level's wire style (a quiet base line
// with moving balls) and fade out toward the edge. The lines run under the chip, so a line to a
// pin on the far side goes under the body. Drag the chip to turn it any way; the lines follow.

const CHECK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 L8.6 13.4 L14.5 7.2"/></svg>`;

// The level's wire style (style.css: .wire, .wire-flow, @keyframes flow): a quiet base line with
// small balls riding it in the direction of travel.
const BASE_WIDTH = 1.5;
const BASE_ALPHA = 0.5;
const FLOW_WIDTH = 3.4; // ball diameter
const DASH = [0.5, 13.5]; // a ball every 14 px
const PERIOD = DASH[0] + DASH[1];
const FLOW_SPEED = PERIOD / 0.9; // px/s: one ball spacing per 0.9 s

const FOOT = HALF + (PKG.leadSpan - PKG.bodySize) / 2 - 0.25; // middle of the lead's foot, mm
const FOOT_Y = PKG.leadThickness / 2;
const MARGIN = 8; // px: the ends of the lines stay this far inside the chip area
const ROD = 2; // mm: each line leaves its pin straight, along the pin, for this long

/** The level's color for a pin where the level has one; otherwise the pin view's group color. */
function pinColor(p: Pin): string {
  const m = /^IN(\d)[PN]$/.exec(p.name);
  if (m) return CH_INK[Number(m[1]) - 1];
  if (p.name === "SRB1") return REF_COLOR;
  if (p.name === "BIASOUT") return BIAS_COLOR;
  if (p.group === "serial") return SERIAL_INK;
  return GROUPS[p.group].color;
}

interface Line {
  dir: "in" | "out";
  color: string;
  foot: THREE.Vector3; // the lead's foot, in the chip's own frame
  tip: THREE.Vector3; // the end of the straight part, ROD mm out along the pin
}

interface P {
  x: number;
  y: number;
}

export class Home {
  private chip: ChipView | null = null;
  private layer = canvas("home-wires");
  private lines: Line[];
  private still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private tiles = new Map<SetupId, HTMLButtonElement>();
  private t0 = performance.now();
  private feet: P[] = [];
  private tips: P[] = [];
  private dpr = 1;

  constructor(
    private root: HTMLElement,
    private hero: HTMLElement,
    setups: Setup[],
    onPlay: (id: SetupId) => void,
  ) {
    const nav = root.querySelector(".levels")!;
    for (const s of setups) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tile tile-${s.id}`;
      b.innerHTML = `
        <span class="tile-badge"><span class="tile-check">${CHECK}</span></span>
        <span class="tile-glyph">${glyph(s.id)}</span>
        <span class="tile-text"><b class="tile-name">${s.name}</b><span class="tile-what">${s.level.what}</span></span>
        <span class="diff diff-${s.level.difficulty.toLowerCase()}">${s.level.difficulty}</span>`;
      b.setAttribute("aria-label", `Level ${s.level.n}: ${s.name}, ${s.level.what}, ${s.level.difficulty}`);
      b.addEventListener("click", () => onPlay(s.id));
      nav.append(b);
      this.tiles.set(s.id, b);
    }

    this.lines = PINS.map((pin) => ({
      dir: pinDir(pin),
      color: pinColor(pin),
      foot: pinPoint(pin.no, FOOT, FOOT_Y),
      tip: pinPoint(pin.no, FOOT + ROD, FOOT_Y),
    }));
    for (let i = 0; i < this.lines.length; i++) {
      this.feet.push({ x: 0, y: 0 });
      this.tips.push({ x: 0, y: 0 });
    }
    hero.prepend(this.layer); // under the chip canvas
    new ResizeObserver(() => this.size()).observe(hero);
  }

  setSolved(id: SetupId, solved: boolean): void {
    this.tiles.get(id)?.classList.toggle("solved", solved);
  }

  show(): void {
    this.root.hidden = false;
    if (!this.chip) {
      this.chip = new ChipView(this.hero, {
        azimuth: 32,
        polar: 44,
        fit: { width: 21, height: 19.5 }, // tall enough that a tipped chip (corner up) keeps clear of the edge
        spin: { drift: !this.still },
      });
      this.chip.onFrame(() => this.draw());
    }
    this.size();
    this.chip.wake();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private size(): void {
    const w = this.hero.clientWidth;
    const h = this.hero.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.layer.width = Math.round(w * this.dpr);
    this.layer.height = Math.round(h * this.dpr);
    this.chip?.requestRender();
  }

  // After each chip frame: one curve per pin, from the left edge to an "in" pin, or from an
  // "out" pin to the right edge. The far end of each curve sits at a height that follows the
  // pin's height on screen, so the bundle keeps its order (few crossings) as the chip turns.
  private draw(): void {
    const chip = this.chip;
    if (!chip || this.root.hidden) return;
    const w = this.hero.clientWidth;
    const h = this.hero.clientHeight;
    const ctx = this.layer.getContext("2d")!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const c = chip.center();
    let r = 1; // the chip's radius on screen, from its pin feet
    this.lines.forEach((l, i) => {
      chip.project(l.foot, this.feet[i]);
      chip.project(l.tip, this.tips[i]);
      r = Math.max(r, Math.hypot(this.feet[i].x - c.x, this.feet[i].y - c.y));
    });
    // Far-end height per px of pin height. The bundle fills about 85% of the hero's height; on a
    // short screen it is less than 1, so the ends gather toward the middle and keep clear of the
    // title and Level select.
    const spread = clamp((0.85 * (h / 2 - MARGIN)) / r, 0.5, 1.8);
    const lean = 0.3; // far-end height per px of pin offset across, so neighbors do not cross
    const time = this.still ? 0 : (performance.now() - this.t0) / 1000;
    ctx.lineCap = "round";

    // The fade: clear at the screen edge, full strength before the chip.
    const fadeIn = [0, Math.max(40, (c.x - r) * 0.6)];
    const fadeOut = [w, Math.min(w - 40, c.x + r + (w - c.x - r) * 0.4)];

    this.lines.forEach((l, i) => {
      // Like a rubber rod: straight out of the pin (foot to tip, in 3D, so it shortens when the
      // pin points at you), then one smooth bend toward the screen edge. The bend starts along
      // the rod, so the line keeps the pin's direction for a while before it turns.
      const p = this.feet[i];
      const q = this.tips[i];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const ox = len > 0.5 ? (q.x - p.x) / len : 0; // the pin's direction on screen
      const oy = len > 0.5 ? (q.y - p.y) / len : 0;
      const side = l.dir === "in" ? -1 : 1; // the screen edge this line goes to
      const dy = p.y - c.y;
      const across = side * (p.x - c.x); // + = the pin is on the near side (facing its edge); - = far side, under the chip
      const ey = soft(c.y + dy * spread - Math.sign(dy) * across * lean * Math.min(1, Math.abs(dy) / r), MARGIN, h - MARGIN);
      const ex = side < 0 ? 0 : w;
      // How far the rod keeps its direction: longer when the pin faces its edge, shorter when
      // the line has to turn back under the chip.
      const facing = (1 + side * ox) / 2; // 1 = the pin points at its edge
      let bend = clamp(Math.hypot(ex - q.x, ey - q.y) * (0.03 + 0.5 * facing ** 1.5), 12, 170);
      // Keep the bend point inside the hero. With all four control points inside, the whole curve
      // stays inside (a Bézier curve stays in the hull of its control points), so the edge of the
      // hero (under the title, over Level select) never cuts a line.
      if (oy < -1e-3) bend = Math.min(bend, (q.y - MARGIN) / -oy);
      else if (oy > 1e-3) bend = Math.min(bend, (h - MARGIN - q.y) / oy);
      bend = Math.max(0, bend);
      const bx = q.x + ox * bend;
      const by = q.y + oy * bend;
      const mx = ex + (bx - ex) * 0.5;

      // Every path starts at its screen edge, so the balls keep a steady speed there while the
      // chip turns (the path length changes at the pin end, which the fade hides).
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.bezierCurveTo(mx, ey, bx, by, q.x, q.y);
      ctx.lineTo(p.x, p.y);
      const [x0, x1] = l.dir === "in" ? fadeIn : fadeOut;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, `${l.color}00`);
      g.addColorStop(1, l.color);
      ctx.strokeStyle = g;
      ctx.setLineDash([]);
      ctx.globalAlpha = BASE_ALPHA;
      ctx.lineWidth = BASE_WIDTH;
      ctx.stroke();
      // A falling dash offset moves the balls from the edge to the pin (in); a rising one moves
      // them from the pin to the edge (out). Each line gets its own phase (golden-ratio steps),
      // so the balls of neighbors do not line up.
      ctx.setLineDash(DASH);
      const phase = (time * FLOW_SPEED + i * 0.618 * PERIOD) % PERIOD;
      ctx.lineDashOffset = l.dir === "in" ? -phase : phase;
      ctx.globalAlpha = 1;
      ctx.lineWidth = FLOW_WIDTH;
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A soft clamp: the middle 60% passes unchanged; past it, values ease toward the limits but never
 *  reach them. Unlike clamp, it keeps the lines in order, so they do not pile up on the edge. */
function soft(v: number, lo: number, hi: number): number {
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  const t = (v - mid) / half;
  const a = Math.abs(t);
  const K = 0.6;
  const out = a <= K ? a : K + (1 - K) * Math.tanh((a - K) / (1 - K));
  return mid + Math.sign(t) * out * half;
}

function canvas(cls: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = cls;
  c.setAttribute("aria-hidden", "true");
  return c;
}

/** A small picture of each level's signal, for the level bands. */
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
