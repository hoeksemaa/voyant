import type { Bank, MatchResult, Setup, SimResult } from "../puzzle/types";
import { along, pinPoint, pinSide } from "../pin-layout";
import { labelEnd } from "../pin-view";
import { ChipView } from "./chip-view";
import { fitPhases, outSpec, phaseStrip, pip, renderBanner, setPip, timeAxis } from "./parts";
import { drawGrid, drawTrace, rangeOf, screen, type Range } from "./traces";
import { BIAS_COLOR, CH_COLORS, CH_INK, REF_COLOR, SERIAL_INK, TARGET_COLOR, channelTag, pinNo, wires } from "./wiring";

// One level on the phone: analog in (top) → the chip (middle) → digital out (bottom).
// The chip sits upright (its lettering reads normally), so its IN pins are on the bottom edge and
// DOUT and DRDY on the top edge. The wires run in lanes around it, like traces on a board: the
// inputs come down from their ports, around the right side, and up into their pins; the outputs
// leave the top edge, go around the left side, and down to the output card. No two wires cross.
// The Pins button grows this same chip to fill the screen and shows what each pin does. There,
// each pin the level uses has a short straight signal line past its label: in for the inputs
// (REF, the channels), out for the outputs (BIASOUT, DOUT, DRDY).

const NS = "http://www.w3.org/2000/svg";

const FIT_SMALL = { width: 31, height: 12 }; // mm of chip in the slot: room for the lanes at the sides
// mm of chip on the full screen: the chip, its pin labels (±8.2 mm), and on a phone the start of
// the side signal lines (SRB1, BIASOUT) past the labels.
const FIT_BIG = { width: 19.5, height: 18.5 };
const GROW_MS = 420;
const LANE = 6; // px between lanes
const GAP = 9; // px from the chip's pin feet to the first lane
const ROD = 6; // px: each wire leaves its pin straight for at least this long
const BEND = 7; // px: the radius of each turn
const CORNERS = [1, 16, 17, 32, 33, 48, 49, 64]; // the end pins of each side: the chip's footprint
// Pins view signals: a straight line on the board, out along the pin's line.
const SIG_GAP = 0.35; // mm from the end of the label text to the line, so they do not overlap
const SIG_Y = 0.002; // mm: the board, where the labels lie
const SIG_LEN = 72; // px: the line's length on screen; it fades out toward its outer end
// The level's wire style (style.css: .wire, .wire-flow): a quiet base line with moving balls.
const SIG_DASH = [0.5, 13.5];
const SIG_PERIOD = 14;
const SIG_SPEED = SIG_PERIOD / 0.9; // px/s

interface Pt2 {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Row {
  ch: number; // 1–8
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  tag?: HTMLButtonElement;
  pip?: HTMLElement;
}

interface Wire {
  from: HTMLElement; // a port
  pin: number;
  color: string;
  dir: "in" | "out";
  lane: number; // 0 = the lane nearest the chip
  path: SVGPathElement;
  flow: SVGPathElement;
}

/** Row height by channel count: one channel gets a tall screen; eight share the card. */
const rowHeight = (n: number) => (n === 1 ? 132 : n === 2 ? 96 : n <= 4 ? 64 : 46);

export class LevelView {
  readonly el = document.createElement("div");
  private inCard = document.createElement("section");
  private outCard = document.createElement("section");
  private slot = document.createElement("div");
  private box = document.createElement("div"); // holds the chip; grows to the full screen for Pins
  private sig = document.createElement("canvas"); // Pins: the signal lines at the pins in use
  private svg = document.createElementNS(NS, "svg");
  private chip: ChipView | null = null;
  private setup: Setup | null = null;
  private target: SimResult | null = null;
  private sim: SimResult | null = null;
  private rowsIn: Row[] = [];
  private rowsOut: Row[] = [];
  private aRange: Range[] = [];
  private tRange: Range[] = [];
  private wires: Wire[] = [];
  private heads: HTMLElement[] = [];
  private spec = document.createElement("span");
  private banner = document.createElement("div");
  private queued = false;
  // Pins: the box's place on screen while it is not in the slot, the chip's fit, and the backdrop.
  private pins = false;
  private rect: Rect | null = null;
  private fit = FIT_SMALL;
  private bg = 0;
  private raf = 0;

  constructor(
    private onFocus: (reg: string) => void,
    private onChipTap: () => void, // a tap on the small chip: open the pins
  ) {
    this.el.className = "flow";
    this.inCard.className = "card card-in";
    this.outCard.className = "card card-out";
    this.slot.className = "chip-slot";
    this.slot.innerHTML = `<span class="chip-cap"><b>ADS1299</b>8 channels<br>24-bit ΔΣ ADC</span>`;
    this.box.className = "chip-box";
    this.sig.className = "pin-sig";
    this.sig.setAttribute("aria-hidden", "true");
    this.slot.append(this.box);
    this.svg.classList.add("wires");
    this.svg.setAttribute("aria-hidden", "true");
    this.banner.className = "banner";
    this.el.append(this.inCard, this.slot, this.outCard, this.svg);
    new ResizeObserver(() => {
      this.sizeSlot();
      this.schedule();
      this.placeWires();
    }).observe(this.el);
    // The small chip lets touches through (it does not turn), so its box gets them. A tap on the
    // chip itself (not the space around it) opens the pins, like the Pins button.
    this.box.addEventListener("click", (e) => {
      if (!this.pins && this.chip?.hits(e.clientX, e.clientY)) this.onChipTap();
    });
    this.box.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") this.box.classList.toggle("tap", !this.pins && !!this.chip?.hits(e.clientX, e.clientY));
    });
    this.box.addEventListener("pointerleave", () => this.box.classList.remove("tap"));
    window.addEventListener("resize", () => {
      if (!this.pins || this.raf) return;
      this.rect = bigRect();
      this.applyBox();
    });
  }

  /** Make the 3D chip (three.js loads on first use). */
  async mountChip(): Promise<void> {
    if (this.chip) return;
    this.chip = new ChipView(this.box, { azimuth: 0, polar: 26, fit: { ...FIT_SMALL }, pins: true });
    this.chip.onFrame(() => {
      this.placeWires();
      this.drawSignals();
    });
    // The pin view puts its legend and its card on the page; keep them with the chip (over the
    // signal lines).
    this.box.append(this.sig, ...document.querySelectorAll<HTMLElement>(".pin-legend, .pin-card"));
  }

  get pinsOn(): boolean {
    return this.pins;
  }

  /**
   * On: the chip grows from its slot to the full screen under the toolbar, then shows its pins
   * and the signals at the pins in use (tap a pin to read it, drag to turn). Off: the pins go, the chip turns back to its start
   * angle and shrinks back into the slot. `instant` skips the motion (a screen change).
   */
  setPins(on: boolean, instant = false): void {
    const chip = this.chip;
    if (!chip || (on === this.pins && !(instant && this.rect))) return;
    this.pins = on;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const html = document.documentElement;
    const from = this.rect ?? rectOf(this.slot);
    if (on && !html.classList.contains("pins-open")) {
      // Lock the page before measuring the screen. A classic scrollbar goes away; pad its width
      // back, so the column does not move under the chip.
      html.style.paddingRight = `${window.innerWidth - html.clientWidth}px`;
      html.classList.add("pins-open");
    }
    const to = on ? bigRect() : rectOf(this.slot);
    const fit0 = this.fit;
    const fit1 = on ? FIT_BIG : FIT_SMALL;
    const bg0 = this.bg;
    const still = instant || matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.box.classList.remove("tap");
    if (on) {
      this.box.classList.add("big");
    } else {
      this.box.classList.remove("ready");
      chip.setAwake(false);
      chip.setPins(false);
      chip.setInteractive(false);
      chip.resetView(still ? 1 : GROW_MS);
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = still ? 1 : Math.min(1, (now - t0) / GROW_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      this.rect = { x: mix(from.x, to.x, e), y: mix(from.y, to.y, e), w: mix(from.w, to.w, e), h: mix(from.h, to.h, e) };
      this.fit = { width: mix(fit0.width, fit1.width, e), height: mix(fit0.height, fit1.height, e) };
      this.bg = mix(bg0, on ? 1 : 0, e);
      this.applyBox();
      if (k < 1) {
        this.raf = requestAnimationFrame(step);
        return;
      }
      this.raf = 0;
      if (on) {
        this.rect = bigRect(); // the screen can change during the grow (a phone turned)
        this.applyBox();
        this.box.classList.add("ready");
        chip.setInteractive(true);
        chip.setPins(true);
        chip.setAwake(!still); // the balls move on every frame
      } else {
        this.rect = null;
        this.sig.width = 0; // clear (and free) the overlay: it shows only while the box is big
        this.box.classList.remove("big");
        this.box.removeAttribute("style");
        html.classList.remove("pins-open");
        html.style.paddingRight = "";
        this.placeWires();
      }
    };
    if (still) step(t0);
    else this.raf = requestAnimationFrame(step);
  }

  /**
   * Pins view: for each pin in use, a straight line on the board out along the pin's line. It
   * starts just past the label's text and fades out toward its outer end. Balls ride it: in for
   * an input, out for an output. Drawn after each chip frame, so it turns with the chip.
   */
  private drawSignals(): void {
    const chip = this.chip;
    const c = this.sig;
    if (!chip || !this.box.classList.contains("big")) return;
    const w = this.box.clientWidth;
    const h = this.box.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phase = still ? 0 : ((performance.now() / 1000) * SIG_SPEED) % SIG_PERIOD;
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    ctx.lineCap = "round";
    for (const wire of this.wires) {
      const d = labelEnd(wire.pin) + SIG_GAP;
      const start = pinPoint(wire.pin, d, SIG_Y);
      if (!chip.sees(start)) continue; // behind the chip body, or the camera is under the board
      chip.project(start, a);
      chip.project(pinPoint(wire.pin, d + 1, SIG_Y), b);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.5) continue; // the line points at the camera
      const ex = a.x + ((b.x - a.x) / len) * SIG_LEN;
      const ey = a.y + ((b.y - a.y) / len) * SIG_LEN;
      const g = ctx.createLinearGradient(a.x, a.y, ex, ey);
      g.addColorStop(0, wire.color);
      g.addColorStop(0.55, wire.color);
      g.addColorStop(1, `${wire.color}00`);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = g;
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // The path runs from the pin end outward. A falling offset moves the balls outward (an
      // output: BIASOUT, DOUT, DRDY); a rising one moves them in, toward the pin (an input).
      const out = wire.dir === "out" || wire.pin === pinNo("BIASOUT");
      ctx.setLineDash(SIG_DASH);
      ctx.lineDashOffset = out ? -phase : phase;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3.4;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private applyBox(): void {
    const r = this.rect!;
    const st = this.box.style;
    st.left = `${r.x}px`;
    st.top = `${r.y}px`;
    st.width = `${r.w}px`;
    st.height = `${r.h}px`;
    st.setProperty("--bg", this.bg.toFixed(3));
    this.chip?.setFit(this.fit);
  }

  // The slot is as tall as the chip plus the lanes above and below it.
  private sizeSlot(): void {
    const w = this.slot.clientWidth;
    if (!w || !this.wires.length) return;
    const nIn = this.wires.filter((x) => x.dir === "in").length;
    const nOut = this.wires.length - nIn;
    const lanes = GAP + (nIn + nOut + 1) * LANE + 16;
    const h = `${Math.round((12 * w) / FIT_SMALL.width + 2 * lanes)}px`;
    if (this.slot.style.height !== h) this.slot.style.height = h;
  }

  setSetup(setup: Setup, target: SimResult): void {
    this.setup = setup;
    this.target = target;
    this.sim = null;
    this.tRange = target.out.map((o) => rangeOf(o.uv, o.status === "off"));
    this.aRange = target.analog.map((a) => rangeOf(a.uv));
    const used = wires(setup).filter((w) => w.p);
    const rh = `${rowHeight(used.length)}px`;

    // -- analog in --
    const ref = setup.electrodes.find((e) => e.pin === "SRB1");
    const bias = setup.electrodes.find((e) => e.pin === "BIASOUT");
    const inHead = head("Analog in");
    const scopeIn = scope("scope-in", rh);
    this.rowsIn = used.map((w) => {
      const r = row(w.ch, `<b><i></i>CH${w.ch}</b>`);
      scopeIn.rows.append(r.el);
      return r;
    });
    scopeIn.strip.append(phaseStrip(setup));
    scopeIn.axis.append(timeAxis(setup.duration));
    const portsIn = document.createElement("div");
    portsIn.className = "ports ports-in";
    const inPorts: { el: HTMLElement; pin: number; color: string }[] = [];
    const port = (cls: string, label: string, title: string, color: string, pin: number) => {
      const p = document.createElement("span");
      p.className = `port ${cls}`;
      p.style.setProperty("--c", color);
      p.title = title;
      p.innerHTML = `<i></i><b>${label}</b>`;
      portsIn.append(p);
      inPorts.push({ el: p, pin, color });
    };
    // Port order, left to right, follows the lanes from the inside out: SRB1 (the right side),
    // IN1P … IN8P (the bottom edge, right to left), BIASOUT (the left side).
    if (ref) port("port-ref", "REF", `${ref.id} → SRB1 (pin ${pinNo("SRB1")})`, REF_COLOR, pinNo("SRB1"));
    for (const w of used) port("", String(w.ch), `CH${w.ch}: ${w.pLabel} → IN${w.ch}P (pin ${pinNo(`IN${w.ch}P`)})`, CH_INK[w.ch - 1], pinNo(`IN${w.ch}P`));
    if (bias) port("port-bias", "BIAS", `BIASOUT (pin ${pinNo("BIASOUT")}) → ${bias.id}`, BIAS_COLOR, pinNo("BIASOUT"));
    this.inCard.replaceChildren(inHead, scopeIn.el, portsIn);

    // -- digital out --
    const portsOut = document.createElement("div");
    portsOut.className = "ports ports-out";
    const outPorts: { el: HTMLElement; pin: number; color: string }[] = [];
    for (const name of ["DOUT", "DRDY"]) {
      const p = document.createElement("span");
      p.className = "port port-sig";
      p.title = name === "DOUT" ? "DOUT: SPI data out, 24 bits per channel" : "DRDY: data ready, falls when a new sample is ready";
      p.innerHTML = `<i></i><b>${name}</b>`;
      portsOut.append(p);
      outPorts.push({ el: p, pin: pinNo(name), color: SERIAL_INK });
    }
    this.spec.className = "spec-out";
    const outHead = head("Digital out");
    outHead.append(this.spec);
    const scopeOut = scope("scope-out", rh);
    this.rowsOut = used.map((w) => {
      const r = row(w.ch, `<b><i></i>CH${w.ch}</b>`);
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "tag";
      tag.hidden = true;
      tag.addEventListener("click", () => this.onFocus(tag.dataset.reg!));
      r.el.querySelector(".screen")!.append(tag);
      const p = pip();
      r.el.append(p);
      r.tag = tag;
      r.pip = p;
      scopeOut.rows.append(r.el);
      return r;
    });
    scopeOut.strip.append(phaseStrip(setup));
    scopeOut.axis.append(timeAxis(setup.duration));
    const key = document.createElement("p");
    key.className = "key";
    key.innerHTML = `<span><i class="k-out"></i>Output</span><span><i class="k-target"></i>Target · ${setup.spec}</span>`;
    this.outCard.replaceChildren(portsOut, outHead, this.banner, scopeOut.el, key);
    this.heads = [scopeIn.el, scopeOut.el];

    // -- wires --
    this.svg.replaceChildren();
    const mk = (from: HTMLElement, pin: number, color: string, dir: "in" | "out", lane: number): Wire => {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "wire");
      path.setAttribute("stroke", color);
      const flow = document.createElementNS(NS, "path");
      flow.setAttribute("class", `wire-flow flow-${dir}${pin === pinNo("BIASOUT") ? " flow-rev" : ""}`);
      flow.setAttribute("stroke", color);
      this.svg.append(path, flow);
      return { from, pin, color, dir, lane, path, flow };
    };
    // Lanes from the inside out. Inputs: in port order. Outputs (top edge): the pin further left
    // takes the inner lane, so the two do not cross.
    const outLane = outPorts.map((p) => p.pin).sort((a, b) => along(b) - along(a));
    this.wires = [
      ...inPorts.map((p, i) => mk(p.el, p.pin, p.color, "in", i)),
      ...outPorts.map((p) => mk(p.el, p.pin, p.color, "out", outLane.indexOf(p.pin))),
    ];
    this.sizeSlot();
    this.schedule();
    requestAnimationFrame(() => this.placeWires());
  }

  setResult(sim: SimResult, m: MatchResult, bank: Bank): void {
    this.sim = sim;
    this.aRange = sim.analog.map((a) => rangeOf(a.uv));
    outSpec(this.spec, sim, this.target!);
    const flags = sim.flags.filter((f) => !f.ch || m.used.includes(f.ch));
    renderBanner(this.banner, flags, m.pass, this.onFocus);
    this.rowsOut.forEach((r) => {
      const k = r.ch - 1;
      const ch = m.channels[k];
      setPip(r.pip!, ch);
      const tag = channelTag(this.setup!, bank, sim.out[k], ch.pass);
      const flag = sim.flags.find((f) => f.ch === r.ch);
      r.tag!.hidden = !tag;
      if (tag) {
        r.tag!.textContent = tag.text;
        r.tag!.classList.toggle("bad", tag.bad);
        r.tag!.title = flag?.text ?? "";
        r.tag!.dataset.reg = flag?.reg ?? `CH${r.ch}SET`;
      }
    });
    this.schedule();
  }

  /** Playhead: one line across each card's screens, at time t. */
  setTime(t: number): void {
    if (!this.setup) return;
    const f = Math.min(1, Math.max(0, t / this.setup.duration));
    for (const h of this.heads) h.style.setProperty("--t", f.toFixed(4));
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  private draw(): void {
    const { setup, target } = this;
    if (!setup || !target || !this.el.offsetParent) return;
    fitPhases(this.el);
    for (const r of this.rowsIn) {
      const s = screen(r.canvas);
      if (!s) continue;
      const k = r.ch - 1;
      drawGrid(s, setup.duration, setup.phases, this.aRange[k]);
      const a = (this.sim ?? target).analog[k];
      if (a.uv) drawTrace(s, a.uv, this.aRange[k], { color: CH_COLORS[k], glow: true });
    }
    for (const r of this.rowsOut) {
      const s = screen(r.canvas);
      if (!s) continue;
      const k = r.ch - 1;
      drawGrid(s, setup.duration, setup.phases, this.tRange[k]);
      drawTrace(s, target.out[k].uv, this.tRange[k], { color: TARGET_COLOR, alpha: 0.8 });
      const out = this.sim?.out[k];
      if (out) drawTrace(s, out.uv, this.tRange[k], { color: CH_COLORS[k], glow: true, edges: true });
    }
  }

  /**
   * Wires: each port to its pin, in lanes around the chip. Pins come from the 3D chip, so the
   * wires follow its frame. Inputs run port → pin, outputs pin → port (the balls flow that way).
   */
  private placeWires(): void {
    const chip = this.chip;
    if (!chip || !this.wires.length || !this.el.offsetParent || this.box.classList.contains("big")) return;
    const base = this.el.getBoundingClientRect();
    const sb = this.slot.getBoundingClientRect();
    const ox = sb.left - base.left;
    const oy = sb.top - base.top;
    this.svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const no of CORNERS) {
      const p = chip.pin(no);
      x0 = Math.min(x0, ox + p.x);
      x1 = Math.max(x1, ox + p.x);
      y0 = Math.min(y0, oy + p.y);
      y1 = Math.max(y1, oy + p.y);
    }
    const nIn = this.wires.filter((w) => w.dir === "in").length;
    const nOut = this.wires.length - nIn;
    // The caption sits at the bottom left, outside the output lanes. On a narrow phone there is
    // no room; the chip's own lettering names it.
    const cap = this.slot.querySelector<HTMLElement>(".chip-cap")!;
    cap.classList.toggle("off", ox + cap.offsetLeft + cap.offsetWidth + 6 > x0 - GAP - nOut * LANE);
    for (const w of this.wires) {
      const r = w.from.getBoundingClientRect();
      const p = chip.pin(w.pin);
      const P = { x: ox + p.x, y: oy + p.y };
      const Q = { x: P.x + p.ox * ROD, y: P.y + p.oy * ROD };
      const j = w.lane;
      let pts: Pt2[];
      if (w.dir === "in") {
        // Down from the port, right above the chip, down the right side, then (bottom and left
        // pins) left under the chip and up into the pin.
        const S = { x: r.left - base.left + r.width / 2, y: r.bottom - base.top - 2 };
        const X = x1 + GAP + j * LANE;
        const T = y0 - GAP - (nOut + 1) * LANE - j * LANE;
        const D = y1 + GAP + j * LANE;
        pts = [S, { x: S.x, y: T }, { x: X, y: T }];
        const side = pinSide(w.pin);
        if (side === 1) pts.push({ x: X, y: Q.y }, Q, P);
        else if (side === 3) pts.push({ x: X, y: D }, { x: x0 - GAP, y: D }, { x: x0 - GAP, y: Q.y }, Q, P); // BIASOUT: its own lane
        else pts.push({ x: X, y: D }, { x: Q.x, y: D }, Q, P);
      } else {
        // Up from the pin, left above the chip, down the left side (outside the BIASOUT lane),
        // under the input lanes, then right and down to the port.
        const E = { x: r.left - base.left + r.width / 2, y: r.top - base.top + 2 };
        const XL = x0 - GAP - (j + 1) * LANE;
        const U = y0 - GAP - j * LANE;
        const B = y1 + GAP + nIn * LANE + j * LANE;
        pts = [P, Q, { x: Q.x, y: U }, { x: XL, y: U }, { x: XL, y: B }, { x: E.x, y: B }, E];
      }
      const d = rounded(pts, BEND);
      w.path.setAttribute("d", d);
      w.flow.setAttribute("d", d);
    }
  }
}

const f = (v: number) => v.toFixed(1);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The full screen under the level's toolbar. */
function bigRect(): Rect {
  const top = Math.max(0, document.querySelector(".level .toolbar")?.getBoundingClientRect().bottom ?? 0);
  const w = document.documentElement.clientWidth;
  return { x: 0, y: top, w, h: window.innerHeight - top };
}

/** A path through the points with straight runs and round turns (radius r, less on short runs). */
function rounded(pts: Pt2[], r: number): string {
  const q: Pt2[] = [];
  for (const p of pts) {
    const l = q[q.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 0.5) q.push(p);
  }
  let d = `M${f(q[0].x)},${f(q[0].y)}`;
  for (let i = 1; i < q.length - 1; i++) {
    const [a, b, c] = [q[i - 1], q[i], q[i + 1]];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${f(b.x + ((a.x - b.x) * k) / l1)},${f(b.y + ((a.y - b.y) * k) / l1)}`;
    d += ` Q${f(b.x)},${f(b.y)} ${f(b.x + ((c.x - b.x) * k) / l2)},${f(b.y + ((c.y - b.y) * k) / l2)}`;
  }
  const z = q[q.length - 1];
  return `${d} L${f(z.x)},${f(z.y)}`;
}

function head(title: string): HTMLElement {
  const h = document.createElement("header");
  h.className = "card-head";
  h.innerHTML = `<h2>${title}</h2>`;
  return h;
}

function scope(cls: string, rh: string) {
  const el = document.createElement("div");
  el.className = `scope ${cls}`;
  el.style.setProperty("--rh", rh);
  const strip = document.createElement("div");
  strip.className = "srow strip";
  strip.innerHTML = `<span></span>`;
  const rows = document.createElement("div");
  rows.className = "rows";
  const axis = document.createElement("div");
  axis.className = "srow axis";
  axis.innerHTML = `<span></span>`;
  const ph = document.createElement("div");
  ph.className = "playhead";
  ph.innerHTML = "<i></i>";
  el.append(strip, rows, axis, ph);
  return { el, strip, rows, axis };
}

function row(ch: number, gut: string): Row {
  const el = document.createElement("div");
  el.className = "srow ch";
  el.style.setProperty("--c", CH_COLORS[ch - 1]);
  el.innerHTML = `<div class="gut">${gut}</div><div class="screen"><canvas></canvas></div>`;
  return { ch, el, canvas: el.querySelector("canvas")! };
}
