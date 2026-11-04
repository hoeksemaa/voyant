import type { Bank, MatchResult, Setup, SimResult } from "../puzzle/types";
import { ChipView } from "./chip-view";
import { fitPhases, outSpec, phaseStrip, pip, renderBanner, setPip, timeAxis } from "./parts";
import { drawGrid, drawTrace, rangeOf, rangeText, screen, type Range } from "./traces";
import { BIAS_COLOR, CH_COLORS, CH_INK, REF_COLOR, TARGET_COLOR, channelTag, pinNo, wires } from "./wiring";

// One level on the phone: analog in (top) → the chip (middle) → digital out (bottom).
// Wires run from the input card's ports into the IN pins, and from DOUT and DRDY down to the
// output card. The chip sits turned 180°, so its IN pins face the inputs above it.

const NS = "http://www.w3.org/2000/svg";

interface Row {
  ch: number; // 1–8
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  scale: HTMLElement;
  tag?: HTMLButtonElement;
  pip?: HTMLElement;
}

interface Wire {
  from: HTMLElement; // a port
  pin: number;
  color: string;
  dir: "in" | "out";
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

  constructor(private onFocus: (reg: string) => void) {
    this.el.className = "flow";
    this.inCard.className = "card card-in";
    this.outCard.className = "card card-out";
    this.slot.className = "chip-slot";
    this.slot.innerHTML = `<span class="chip-cap"><b>ADS1299</b>8 channels<br>24-bit ΔΣ ADC</span>`;
    this.svg.classList.add("wires");
    this.svg.setAttribute("aria-hidden", "true");
    this.banner.className = "banner";
    this.el.append(this.inCard, this.slot, this.outCard, this.svg);
    new ResizeObserver(() => {
      this.schedule();
      this.placeWires();
    }).observe(this.el);
  }

  /** Make the 3D chip (three.js loads on first use). */
  async mountChip(): Promise<void> {
    if (this.chip) return;
    this.chip = new ChipView(this.slot, { azimuth: 180, polar: 26, fit: { width: 27, height: 15.5 } });
    this.chip.onFrame(() => this.placeWires());
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
    const sw = setup.montage === "srb1" ? "SRB1" : "bipolar";
    const inHead = head("1", "Analog in", `Board switch · <b>${sw}</b>`);
    const chips = document.createElement("div");
    chips.className = "ref-chips";
    if (ref) chips.innerHTML += `<span class="lg lg-ref" title="${ref.label}"><i></i>${ref.id} → SRB1</span>`;
    if (bias) chips.innerHTML += `<span class="lg lg-bias" title="${bias.label}"><i></i>${bias.id} → BIASOUT</span>`;
    const scopeIn = scope("scope-in", rh);
    this.rowsIn = used.map((w) => {
      const r = row(w.ch, `<b><i></i>CH${w.ch}</b><span>${w.pLabel} − ${w.nLabel}</span>`);
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
    // Port order follows the pins on the chip's top edge (turned 180°): SRB1, IN1P … IN8P, BIASOUT.
    if (ref) port("port-ref", "REF", `${ref.id} → SRB1 (pin ${pinNo("SRB1")})`, REF_COLOR, pinNo("SRB1"));
    for (const w of used) port("", String(w.ch), `CH${w.ch}: ${w.pLabel} → IN${w.ch}P (pin ${pinNo(`IN${w.ch}P`)})`, CH_INK[w.ch - 1], pinNo(`IN${w.ch}P`));
    if (bias) port("port-bias", "BIAS", `BIASOUT (pin ${pinNo("BIASOUT")}) → ${bias.id}`, BIAS_COLOR, pinNo("BIASOUT"));
    this.inCard.replaceChildren(inHead, chips, scopeIn.el, portsIn);

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
      outPorts.push({ el: p, pin: pinNo(name), color: "#b07800" });
    }
    this.spec.className = "spec-out";
    const outHead = head("3", "Digital out", "");
    outHead.querySelector(".note")!.append(this.spec);
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
    const mk = (from: HTMLElement, pin: number, color: string, dir: "in" | "out"): Wire => {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "wire");
      path.setAttribute("stroke", color);
      const flow = document.createElementNS(NS, "path");
      flow.setAttribute("class", `wire-flow flow-${dir}`);
      flow.setAttribute("stroke", color);
      this.svg.append(path, flow);
      return { from, pin, color, dir, path, flow };
    };
    this.wires = [...inPorts.map((p) => mk(p.el, p.pin, p.color, "in")), ...outPorts.map((p) => mk(p.el, p.pin, p.color, "out"))];
    this.schedule();
    requestAnimationFrame(() => this.placeWires());
  }

  setResult(sim: SimResult, m: MatchResult, bank: Bank): void {
    this.sim = sim;
    this.aRange = sim.analog.map((a) => rangeOf(a.uv));
    outSpec(this.spec, sim, this.target!);
    const flags = sim.flags.filter((f) => !f.ch || m.used.includes(f.ch));
    renderBanner(this.banner, flags, m.pass, this.onFocus);
    this.rowsIn.forEach((r) => (r.scale.textContent = rangeText(this.aRange[r.ch - 1])));
    this.rowsOut.forEach((r) => {
      const k = r.ch - 1;
      const ch = m.channels[k];
      setPip(r.pip!, ch);
      r.scale.textContent = rangeText(this.tRange[k]);
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

  /** Wires: each port to its pin. Pins come from the 3D chip, so they follow its frame. */
  private placeWires(): void {
    const chip = this.chip;
    if (!chip || !this.wires.length || !this.el.offsetParent) return;
    const base = this.el.getBoundingClientRect();
    const sb = this.slot.getBoundingClientRect();
    this.svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);
    for (const w of this.wires) {
      const r = w.from.getBoundingClientRect();
      const p = chip.pin(w.pin);
      const px = sb.left - base.left + p.x;
      const py = sb.top - base.top + p.y;
      const reach = 26;
      const ax = px + p.ox * reach;
      const ay = py + p.oy * reach;
      let d: string;
      if (w.dir === "in") {
        const sx = r.left - base.left + r.width / 2;
        const sy = r.bottom - base.top - 2;
        const k = Math.max(24, (ay - sy) * 0.55);
        d = `M${f(sx)},${f(sy)} C${f(sx)},${f(sy + k)} ${f(ax)},${f(ay)} ${f(px)},${f(py)}`;
      } else {
        const ex = r.left - base.left + r.width / 2;
        const ey = r.top - base.top + 2;
        const k = Math.max(24, (ey - ay) * 0.55);
        d = `M${f(px)},${f(py)} C${f(ax)},${f(ay)} ${f(ex)},${f(ey - k)} ${f(ex)},${f(ey)}`;
      }
      w.path.setAttribute("d", d);
      w.flow.setAttribute("d", d);
    }
  }
}

const f = (v: number) => v.toFixed(1);

function head(n: string, title: string, note: string): HTMLElement {
  const h = document.createElement("header");
  h.className = "card-head";
  h.innerHTML = `<h2><span class="step">${n}</span>${title}</h2><span class="note">${note}</span>`;
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
  el.innerHTML = `<div class="gut">${gut}</div><div class="screen"><canvas></canvas><span class="scale"></span></div>`;
  return { ch, el, canvas: el.querySelector("canvas")!, scale: el.querySelector(".scale")! };
}
