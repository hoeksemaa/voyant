import * as THREE from "three";
import { PKG } from "../package-dims";
import { HALF, along, pinSide, sidePoint } from "../pin-layout";
import { GROUPS, PINS, pinDir, type Pin } from "../pins";
import type { Setup, SetupId } from "../puzzle/types";
import { ChipView } from "./chip-view";
import { BIAS_COLOR, CH_INK, REF_COLOR, SERIAL_INK } from "./wiring";

// The home screen: the title, the 3D chip, and the three levels.
// Each of the 64 pins has a signal line on the board plane: "in" lines flow into the chip, "out"
// lines flow out (see pinDir). The lines use the level's wire style (a quiet base line and moving
// dashes) and fade out before the edge of the chip area. Drag the chip to turn it any way.

const CHECK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 L8.6 13.4 L14.5 7.2"/></svg>`;

// The level's wire style (style.css: .wire, .wire-flow, @keyframes flow).
const BASE_WIDTH = 1.5;
const BASE_ALPHA = 0.5;
const FLOW_WIDTH = 1.9;
const DASH = [3, 9];
const FLOW_SPEED = 12 / 0.9; // px/s: one dash period per 0.9 s

// The lines on the board plane, in mm.
const FOOT = HALF + (PKG.leadSpan - PKG.bodySize) / 2 - 0.25; // middle of the lead's foot
const FOOT_Y = PKG.leadThickness / 2;
const REACH = 30; // mm past the foot; the chip area cuts the line long before that
const STEP = 0.75; // mm between path points
const SPREAD = 0.075; // the lines fan out: share of extra spacing per mm
const MARGIN = 10; // px: lines end this far inside the chip area

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
  pin: Pin;
  dir: "in" | "out";
  color: string;
  path: THREE.Vector3[]; // from the foot outward, in the chip's own frame
}

export class Home {
  private chip: ChipView | null = null;
  private back = canvas("home-wires home-wires-back");
  private front = canvas("home-wires home-wires-front");
  private lines: Line[];
  private still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private tiles = new Map<SetupId, HTMLButtonElement>();
  private t0 = performance.now();
  private pts: { x: number; y: number }[] = [];
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

    this.lines = PINS.map((pin) => ({ pin, dir: pinDir(pin), color: pinColor(pin), path: fan(pin.no) }));
    const n = this.lines[0].path.length;
    for (let i = 0; i < n; i++) this.pts.push({ x: 0, y: 0 });
    hero.prepend(this.back);
    hero.append(this.front);
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
      // The chip canvas goes between the two line layers.
      this.hero.append(this.front);
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
    for (const c of [this.back, this.front]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    this.chip?.requestRender();
  }

  // After each chip frame: project each line, cut it where it nears the edge of the chip area,
  // and stroke it like a level wire. Lines lie on the board plane, so from above the chip body
  // hides them (back layer, under the chip); from below they cover it (front layer).
  private draw(): void {
    const chip = this.chip;
    if (!chip || this.root.hidden) return;
    const w = this.hero.clientWidth;
    const h = this.hero.clientHeight;
    const above = chip.fromAbove();
    const ctx = (above ? this.back : this.front).getContext("2d")!;
    const other = (above ? this.front : this.back).getContext("2d")!;
    other.setTransform(1, 0, 0, 1, 0, 0);
    other.clearRect(0, 0, other.canvas.width, other.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const time = this.still ? 0 : (performance.now() - this.t0) / 1000;
    const shift = (time * FLOW_SPEED) % (DASH[0] + DASH[1]);
    const inside = (p: { x: number; y: number }) => p.x > MARGIN && p.x < w - MARGIN && p.y > MARGIN && p.y < h - MARGIN;
    ctx.lineCap = "round";

    for (const line of this.lines) {
      const pts = this.pts;
      let n = 0;
      let cut = { x: 0, y: 0 };
      for (const p of line.path) {
        chip.project(p, pts[n]);
        if (!inside(pts[n])) {
          if (n === 0) break;
          cut = edge(pts[n - 1], pts[n], w, h);
          break;
        }
        cut = pts[n];
        n++;
      }
      if (n === 0) continue;
      const x0 = pts[0].x;
      const y0 = pts[0].y;
      if (Math.hypot(cut.x - x0, cut.y - y0) < 6) continue;

      const g = ctx.createLinearGradient(x0, y0, cut.x, cut.y);
      g.addColorStop(0, line.color);
      g.addColorStop(0.4, line.color);
      g.addColorStop(1, `${line.color}00`);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(cut.x, cut.y);

      ctx.setLineDash([]);
      ctx.globalAlpha = BASE_ALPHA;
      ctx.lineWidth = BASE_WIDTH;
      ctx.stroke();
      // Dashes from the pin outward: a growing offset moves them toward the pin (in).
      ctx.setLineDash(DASH);
      ctx.lineDashOffset = line.dir === "in" ? shift : -shift;
      ctx.globalAlpha = 1;
      ctx.lineWidth = FLOW_WIDTH;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

function canvas(cls: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = cls;
  c.setAttribute("aria-hidden", "true");
  return c;
}

/** The line of one pin on the board plane: straight out of the foot, then a soft fan. */
function fan(no: number): THREE.Vector3[] {
  const side = pinSide(no);
  const s = along(no);
  const out: THREE.Vector3[] = [];
  const bend = 2; // mm of straight-ish run before the fan
  for (let u = 0; u <= REACH; u += STEP) {
    const g = u < bend ? (u * u) / (2 * bend) : u - bend / 2; // eases from straight to a fan
    out.push(sidePoint(side, FOOT + u, s * (1 + SPREAD * g), FOOT_Y));
  }
  return out;
}

/** Where the segment from a (inside) to b (outside) crosses the inset edge of the w × h box. */
function edge(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  let t = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (b.x < MARGIN) t = Math.min(t, (MARGIN - a.x) / dx);
  if (b.x > w - MARGIN) t = Math.min(t, (w - MARGIN - a.x) / dx);
  if (b.y < MARGIN) t = Math.min(t, (MARGIN - a.y) / dy);
  if (b.y > h - MARGIN) t = Math.min(t, (h - MARGIN - a.y) / dy);
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
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
