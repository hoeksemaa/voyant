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
  out: THREE.Vector3; // 4 mm further out along the pin
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
  private outs: P[] = [];
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
        <span class="tile-badge"><span class="tile-num">${String(s.level.n).padStart(2, "0")}</span><span class="tile-check">${CHECK}</span></span>
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
      out: pinPoint(pin.no, FOOT + 4, FOOT_Y),
    }));
    for (let i = 0; i < this.lines.length; i++) {
      this.feet.push({ x: 0, y: 0 });
      this.outs.push({ x: 0, y: 0 });
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
        fit: { width: 21, height: 17 },
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
      chip.project(l.out, this.outs[i]);
      r = Math.max(r, Math.hypot(this.feet[i].x - c.x, this.feet[i].y - c.y));
    });
    const spread = Math.min(1.8, Math.max(1, (h / 2 - MARGIN) / r)); // far-end height per px of pin height
    const lean = 0.3; // far-end height per px of pin offset across, so neighbors do not cross
    const reach = Math.max(18, r * 0.16); // how far out of the pin the curve starts to turn
    const time = this.still ? 0 : (performance.now() - this.t0) / 1000;
    ctx.lineCap = "round";

    // The fade: clear at the screen edge, full strength before the chip.
    const fadeIn = [0, Math.max(40, (c.x - r) * 0.6)];
    const fadeOut = [w, Math.min(w - 40, c.x + r + (w - c.x - r) * 0.4)];

    this.lines.forEach((l, i) => {
      const p = this.feet[i];
      const q = this.outs[i];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      // Outward direction of the pin on screen (none when the pin points at the camera).
      const ox = len > 0.5 ? (q.x - p.x) / len : 0;
      const oy = len > 0.5 ? (q.y - p.y) / len : 0;
      const side = l.dir === "in" ? -1 : 1; // the screen edge this line goes to
      // Leave the pin along its own direction when that faces the edge; otherwise head for the
      // edge at once (under the chip).
      const k = Math.max(0, Math.min(1, (1 + side * ox) / 2));
      let ax = k * ox + (1 - k) * side;
      let ay = k * oy;
      const al = Math.hypot(ax, ay) || 1;
      ax = p.x + (ax / al) * reach;
      ay = p.y + (ay / al) * reach;
      const dy = p.y - c.y;
      const across = side * (p.x - c.x); // + = the pin is on the near side (facing its edge); - = far side, under the chip
      const ey = clamp(c.y + dy * spread - Math.sign(dy) * across * lean * Math.min(1, Math.abs(dy) / r), MARGIN, h - MARGIN);
      const ex = side < 0 ? 0 : w;
      const mx = ex + (ax - ex) * 0.55;

      // Every path starts at its screen edge, so the balls keep a steady speed there while the
      // chip turns (the path length changes at the pin end, which the fade hides less well).
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.bezierCurveTo(mx, ey, ax, ay, p.x, p.y);
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
