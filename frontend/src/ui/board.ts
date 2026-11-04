import type { Bank, MatchResult, Setup, SimResult } from "../puzzle/types";
import type { Link } from "../curves";
import { drawing, type Drawing } from "./drawing";
import { LENS_SPAN, Lens, type LensTrace } from "./lens";
import { fitPhases, outSpec, phaseStrip, pip, renderBanner, setPip, timeAxis } from "./parts";
import { drawGrid, drawTrace, rangeOf, rangeText, screen, type Range } from "./traces";
import { BIAS_COLOR, CH_COLORS, DOUT_COLOR, REF_COLOR, TARGET_COLOR, channelTag, pinNo, wires, type Wire } from "./wiring";

// The desktop board: Analog in | (3D chip) | Output | Target.
// Output and Target rows of a channel share one y-scale: the target's range. The analog rows
// scale to their own signal, because the analog voltage never clips.
// Only the channels with an electrode get rows (usedChannels); the others do not count.

export interface BoardEvents {
  onFocus: (reg: string) => void; // show a register in the firmware editor
  onHot: (ch: number | null) => void; // the pointer is on a channel
  onLayout: () => void; // rows moved: the curves must follow
}

type Kind = "in" | "out" | "target";

interface RowView {
  ch: number; // 1–8
  el: HTMLElement;
  screen: HTMLElement;
  canvas: HTMLCanvasElement;
  mark: HTMLElement; // the lens window on this row
  tag?: HTMLElement;
  pip?: HTMLElement;
  scale?: HTMLElement;
}

const weight = (w: Wire) => (w.p ? 3 : 1.1);

function head(title: string): { el: HTMLElement; note: HTMLElement } {
  const el = document.createElement("header");
  el.className = "col-head";
  el.innerHTML = `<h2>${title}</h2><span class="col-note"></span>`;
  return { el, note: el.querySelector(".col-note")! };
}

function rowShell(cls: string, ch: number | null, grow: number): HTMLElement {
  const el = document.createElement("div");
  el.className = `srow ${cls}`;
  if (ch !== null) {
    el.dataset.ch = String(ch);
    el.style.flexGrow = String(grow);
  }
  return el;
}

const spacer = () => document.createElement("span");

export class Board {
  private setup: Setup | null = null;
  private target: SimResult | null = null;
  private sim: SimResult | null = null;
  private wires: Wire[] = [];
  private analog: RowView[] = [];
  private out: RowView[] = [];
  private tgt: RowView[] = [];
  private aRange: Range[] = [];
  private tRange: Range[] = [];
  private drawingView: Drawing | null = null;
  private heads = { in: head("Analog in"), out: head("Output"), target: head("Target") };
  private colIn = document.createElement("section");
  private colChip = document.createElement("section");
  private scopeIn = document.createElement("div");
  private scopeOut = document.createElement("div");
  private scopeTarget = document.createElement("div");
  private banner = document.createElement("div");
  private flags = document.createElement("div");
  private score = document.createElement("span");
  private lens = new Lens();
  private queued = false;
  private full = true; // redraw the target column too (new setup, or new size)

  constructor(
    private root: HTMLElement,
    private ev: BoardEvents,
  ) {
    this.colIn.className = "col col-in";
    this.colChip.className = "col col-chip";
    this.scopeIn.className = "scope scope-in";
    this.scopeOut.className = "scope scope-out";
    this.scopeTarget.className = "scope scope-target";
    this.banner.className = "banner";
    this.flags.className = "flags";
    this.score.className = "score";
    this.banner.append(this.score, this.flags);
    this.heads.in.el.classList.add("head-in");
    this.heads.out.el.classList.add("head-out");
    this.heads.target.el.classList.add("head-target");
    this.colIn.append(this.heads.in.el);
    root.append(this.colIn, this.colChip, this.heads.out.el, this.heads.target.el, this.banner, this.scopeOut, this.scopeTarget);
    new ResizeObserver(() => this.schedule(true)).observe(root);
    root.addEventListener("pointerleave", () => ev.onHot(null));
  }

  /** The center column: the 3D chip frames itself into this box. */
  get chipBox(): HTMLElement {
    return this.colChip;
  }

  setSetup(setup: Setup, target: SimResult): void {
    this.setup = setup;
    this.target = target;
    this.sim = null;
    this.lens.hide();
    this.wires = wires(setup).filter((w) => w.p); // channels with an electrode only
    this.aRange = target.analog.map((a) => rangeOf(a.uv));
    this.tRange = target.out.map((o) => rangeOf(o.uv, o.status === "off"));

    this.heads.in.note.innerHTML = `Board switch · <b>${setup.montage === "srb1" ? "SRB1" : "bipolar"}</b>`;
    this.heads.target.note.textContent = setup.spec;

    this.drawingView?.el.remove();
    this.drawingView = drawing(setup);
    for (const [ch, marks] of this.drawingView.marks) {
      for (const m of marks) m.addEventListener("pointerenter", () => this.ev.onHot(ch));
    }
    this.colIn.replaceChildren(this.heads.in.el, this.drawingView.el, this.scopeIn);

    this.analog = this.buildScope(this.scopeIn, "in");
    this.out = this.buildScope(this.scopeOut, "out");
    this.tgt = this.buildScope(this.scopeTarget, "target");
    this.tgt.forEach((r) => {
      const k = r.ch - 1;
      r.scale!.textContent = rangeText(this.tRange[k]);
      const off = target.out[k].status === "off";
      r.tag!.textContent = off ? "off" : "";
      r.tag!.hidden = !off;
    });
    this.schedule(true);
  }

  private buildScope(scope: HTMLElement, kind: Kind): RowView[] {
    const setup = this.setup!;
    const strip = rowShell("strip", null, 0);
    const axis = rowShell("axis", null, 0);
    const rows = document.createElement("div");
    rows.className = "rows";
    const views: RowView[] = [];
    for (const w of this.wires) {
      const el = rowShell(w.p ? "ch" : "ch empty", w.ch, weight(w));
      el.style.setProperty("--c", CH_COLORS[w.ch - 1]);
      const screenEl = document.createElement("div");
      screenEl.className = "screen";
      const canvas = document.createElement("canvas");
      const mark = document.createElement("span");
      mark.className = "lens-mark";
      screenEl.append(canvas, mark);
      const view: RowView = { ch: w.ch, el, screen: screenEl, canvas, mark };
      if (kind === "in") {
        const gut = document.createElement("div");
        gut.className = "gut";
        gut.innerHTML = `<b><i></i>CH${w.ch}</b><span>${w.p ? `${w.pLabel} − ${w.nLabel}` : "open"}</span>`;
        gut.title = w.p ? `IN${w.ch}P − IN${w.ch}N: ${w.p.label} − ${w.n?.label ?? "open"}` : `No electrode on IN${w.ch}P`;
        view.scale = document.createElement("span");
        view.scale.className = "scale";
        screenEl.append(view.scale);
        el.append(gut, screenEl);
      } else if (kind === "out") {
        const gut = document.createElement("div");
        gut.className = "gut";
        gut.innerHTML = `<b><i></i>CH${w.ch}</b>`;
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "tag";
        tag.hidden = true;
        tag.addEventListener("click", () => this.ev.onFocus(tag.dataset.reg!));
        view.tag = tag;
        screenEl.append(tag);
        view.pip = pip();
        el.append(gut, screenEl, view.pip);
      } else {
        view.scale = document.createElement("span");
        view.scale.className = "scale";
        view.tag = document.createElement("span");
        view.tag.className = "tag tag-quiet";
        screenEl.append(view.scale, view.tag);
        el.append(screenEl);
      }
      el.addEventListener("pointerenter", () => this.ev.onHot(w.ch));
      if (w.p || kind !== "in") {
        screenEl.addEventListener("pointermove", (e) => this.peek(kind, w.ch, view, e));
        screenEl.addEventListener("pointerleave", () => this.unpeek(view));
      }
      rows.append(el);
      views.push(view);
    }
    const gutters = kind === "out" ? 1 : kind === "in" ? 1 : 0;
    const lead = () => Array.from({ length: gutters }, spacer);
    const tail = () => (kind === "out" ? [spacer()] : []);
    strip.append(...lead(), phaseStrip(setup), ...tail());
    axis.append(...lead(), timeAxis(setup.duration), ...tail());
    scope.replaceChildren(strip, rows, axis);
    return views;
  }

  // The lens: 0.25 s of one channel around the pointer.
  private peek(kind: Kind, ch: number, view: RowView, e: PointerEvent): void {
    const setup = this.setup;
    const target = this.target;
    if (!setup || !target) return;
    const sim = this.sim ?? target;
    const r = view.screen.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const span = LENS_SPAN / setup.duration;
    const start = Math.min(1 - span, Math.max(0, f - span / 2));
    view.mark.style.left = `${start * 100}%`;
    view.mark.style.width = `${span * 100}%`;
    view.mark.classList.add("on");
    const t0 = start * setup.duration;
    const k = ch - 1;
    const color = CH_COLORS[k];
    let traces: LensTrace[];
    let label: string;
    if (kind === "in") {
      const a = sim.analog[k];
      if (!a.uv) return;
      traces = [{ uv: a.uv, rate: a.rate, color, glow: true }];
      label = `CH${ch} in`;
    } else {
      const t = target.out[k];
      const o = sim.out[k];
      traces = [{ uv: t.uv, rate: t.rate, color: TARGET_COLOR, glow: false }];
      if (kind === "out" && this.sim) traces.push({ uv: o.uv, rate: o.rate, color, glow: true });
      label = kind === "out" ? `CH${ch} out` : `CH${ch} target`;
    }
    const col = view.el.closest(".scope")!.getBoundingClientRect();
    const box = new DOMRect(col.left, r.top, col.width, r.height);
    this.lens.show(label, t0, traces, box, kind === "target" ? "right" : "left");
  }

  private unpeek(view: RowView): void {
    view.mark.classList.remove("on");
    this.lens.hide();
  }

  setResult(sim: SimResult, m: MatchResult, bank: Bank): void {
    const setup = this.setup!;
    const target = this.target!;
    this.sim = sim;
    const passed = m.channels.filter((c) => c.pass && m.used.includes(c.ch)).length;
    this.score.textContent = `${passed} / ${m.used.length} match`;
    this.score.classList.toggle("good", m.pass);
    outSpec(this.heads.out.note, sim, target);
    // Flags on a channel with no electrode stay hidden: that channel is not shown and does not count.
    const flags = sim.flags.filter((f) => !f.ch || m.used.includes(f.ch));
    renderBanner(this.flags, flags, m.pass, this.ev.onFocus);
    this.aRange = sim.analog.map((a) => rangeOf(a.uv));
    this.analog.forEach((r) => {
      r.scale!.textContent = rangeText(this.aRange[r.ch - 1]);
    });
    this.out.forEach((r) => {
      const k = r.ch - 1;
      const c = m.channels[k];
      setPip(r.pip!, c);
      r.el.classList.toggle("pass", c.pass);
      const tag = channelTag(setup, bank, sim.out[k], c.pass);
      const flag = sim.flags.find((f) => f.ch === k + 1);
      r.tag!.hidden = !tag;
      if (tag) {
        r.tag!.textContent = tag.text;
        r.tag!.classList.toggle("bad", tag.bad);
        r.tag!.title = flag?.text ?? `CH${k + 1}SET`;
        r.tag!.dataset.reg = flag?.reg ?? `CH${k + 1}SET`;
      }
    });
    this.schedule();
  }

  setHot(ch: number | null): void {
    for (const el of this.root.querySelectorAll<HTMLElement>(".srow.ch")) el.classList.toggle("hot", Number(el.dataset.ch) === ch);
    this.root.classList.toggle("has-hot", ch !== null);
    for (const [n, marks] of this.drawingView?.marks ?? []) for (const mk of marks) mk.classList.toggle("hot", n === ch);
  }

  /** Curves: each analog row to its IN pins, the drawing's SRB1 and BIASOUT, DOUT to the output. */
  links(): Link[] {
    const setup = this.setup;
    if (!setup) return [];
    const links: Link[] = [];
    const bipolar = setup.montage === "bipolar";
    for (const w of this.wires) {
      if (!w.p) continue;
      const el = this.analog.find((r) => r.ch === w.ch)!.el;
      const color = CH_COLORS[w.ch - 1];
      links.push({ el, side: "in", pin: pinNo(`IN${w.ch}P`), color, key: w.ch, spread: bipolar && w.n ? -3 : 0 });
      if (bipolar && w.n) links.push({ el, side: "in", pin: pinNo(`IN${w.ch}N`), color, key: w.ch, spread: 3 });
    }
    const d = this.drawingView!;
    if (d.ref) links.push({ el: d.ref, side: "in", pin: pinNo("SRB1"), color: REF_COLOR, key: "ref", spread: 0 });
    if (d.bias) links.push({ el: d.bias, side: "in", pin: pinNo("BIASOUT"), color: BIAS_COLOR, key: "bias", spread: 0 });
    links.push({ el: this.scopeOut, side: "out", pin: pinNo("DOUT"), color: DOUT_COLOR, key: "dout", spread: 0, y: 0.05 });
    return links;
  }

  /** Pins to tint on the chip: the pins in use, in their curve colors. */
  litPins(): Map<number, string> {
    const lit = new Map<number, string>();
    for (const l of this.links()) lit.set(l.pin, l.color);
    return lit;
  }

  private schedule(full = false): void {
    this.full ||= full;
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw(this.full);
      this.full = false;
      this.ev.onLayout();
    });
  }

  private draw(full: boolean): void {
    const setup = this.setup;
    const target = this.target;
    if (!setup || !target || !this.root.offsetParent) return;
    fitPhases(this.root);
    const { duration, phases } = setup;
    const sim = this.sim ?? target;
    this.analog.forEach((r) => {
      const k = r.ch - 1;
      const s = screen(r.canvas);
      if (!s) return;
      const a = sim.analog[k];
      drawGrid(s, duration, phases, a.uv ? this.aRange[k] : null);
      if (a.uv) drawTrace(s, a.uv, this.aRange[k], { color: CH_COLORS[k], glow: true });
    });
    if (full) this.tgt.forEach((r) => {
      const k = r.ch - 1;
      const s = screen(r.canvas);
      if (!s) return;
      drawGrid(s, duration, phases, this.tRange[k]);
      drawTrace(s, target.out[k].uv, this.tRange[k], { color: TARGET_COLOR, alpha: 0.9 });
    });
    this.out.forEach((r) => {
      const k = r.ch - 1;
      const s = screen(r.canvas);
      if (!s) return;
      drawGrid(s, duration, phases, this.tRange[k]);
      if (this.sim) drawTrace(s, this.sim.out[k].uv, this.tRange[k], { color: CH_COLORS[k], glow: true, edges: true });
    });
  }
}
