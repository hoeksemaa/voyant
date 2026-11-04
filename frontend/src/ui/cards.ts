import type { Bank, MatchResult, Setup, SimResult } from "../puzzle/types";
import { drawing } from "./drawing";
import { fitPhases, outSpec, phaseStrip, pip, renderBanner, setPip, timeAxis } from "./parts";
import { drawGrid, drawTrace, rangeOf, screen, type Range } from "./traces";
import { CH_COLORS, TARGET_COLOR, channelTag, wires } from "./wiring";

// The phone view: the body drawing, then one card per channel with an electrode. Each card
// shows the target in grey with the output on top, in the channel's color.

interface CardView {
  ch: number; // 1–8
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  tag: HTMLButtonElement;
  pip: HTMLElement;
}

export class Cards {
  private setup: Setup | null = null;
  private target: SimResult | null = null;
  private sim: SimResult | null = null;
  private cards: CardView[] = [];
  private ranges: Range[] = [];
  private queued = false;
  private top = document.createElement("div");
  private score = document.createElement("span");
  private banner = document.createElement("div");
  private outLine = document.createElement("span");
  private list = document.createElement("div");

  constructor(
    private root: HTMLElement,
    private onFocus: (reg: string) => void,
  ) {
    this.top.className = "cards-top";
    this.list.className = "cards-list";
    this.banner.className = "banner";
    root.append(this.top, this.banner, this.list);
    new ResizeObserver(() => this.schedule()).observe(root);
  }

  setSetup(setup: Setup, target: SimResult): void {
    this.setup = setup;
    this.target = target;
    this.sim = null;
    this.ranges = target.out.map((o) => rangeOf(o.uv, o.status === "off"));
    const d = drawing(setup);
    const sw = document.createElement("p");
    sw.className = "cards-switch";
    sw.innerHTML = `Board switch · <b>${setup.montage === "srb1" ? "SRB1" : "bipolar"}</b>`;
    const head = document.createElement("div");
    head.className = "cards-head";
    head.innerHTML = `<b>Output</b>`;
    this.score.className = "cards-score";
    head.append(this.score);
    const spec = document.createElement("div");
    spec.className = "cards-spec";
    const outRow = document.createElement("span");
    outRow.className = "spec-out";
    outRow.append("Output ", this.outLine);
    const tgtRow = document.createElement("span");
    tgtRow.className = "spec-target";
    tgtRow.innerHTML = `<i></i>Target ${setup.spec}`;
    spec.append(outRow, tgtRow);
    this.top.replaceChildren(d.el, sw);

    this.cards = wires(setup).filter((w) => w.p).map((w) => {
      const el = document.createElement("article");
      el.className = "card";
      el.style.setProperty("--c", CH_COLORS[w.ch - 1]);
      const label = `${w.pLabel} − ${w.nLabel}`;
      el.innerHTML = `<header><b><i></i>CH${w.ch}</b><span class="card-wire">${label}</span></header>`;
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "tag";
      tag.hidden = true;
      tag.addEventListener("click", () => this.onFocus(tag.dataset.reg!));
      const p = pip();
      el.querySelector("header")!.append(tag, p);
      const canvas = document.createElement("canvas");
      el.append(canvas);
      return { ch: w.ch, el, canvas, tag, pip: p };
    });
    this.list.replaceChildren(head, spec, phaseStrip(setup), ...this.cards.map((c) => c.el), timeAxis(setup.duration));
    this.schedule();
  }

  setResult(sim: SimResult, m: MatchResult, bank: Bank): void {
    this.sim = sim;
    const passed = m.channels.filter((c) => c.pass && m.used.includes(c.ch)).length;
    this.score.textContent = `${passed} / ${m.used.length} match`;
    this.score.classList.toggle("good", m.pass);
    outSpec(this.outLine, sim, this.target!);
    const flags = sim.flags.filter((f) => !f.ch || m.used.includes(f.ch)); // no flags for hidden channels
    renderBanner(this.banner, flags, m.pass, this.onFocus);
    this.cards.forEach((c) => {
      const k = c.ch - 1;
      const ch = m.channels[k];
      setPip(c.pip, ch);
      const tag = channelTag(this.setup!, bank, sim.out[k], ch.pass);
      const flag = sim.flags.find((f) => f.ch === k + 1);
      c.tag.hidden = !tag;
      if (tag) {
        c.tag.textContent = tag.text;
        c.tag.classList.toggle("bad", tag.bad);
        c.tag.title = flag?.text ?? "";
        c.tag.dataset.reg = flag?.reg ?? `CH${k + 1}SET`;
      }
    });
    this.schedule();
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
    const setup = this.setup;
    const target = this.target;
    if (!setup || !target || !this.root.offsetParent) return;
    fitPhases(this.root);
    this.cards.forEach((c) => {
      const k = c.ch - 1;
      const s = screen(c.canvas);
      if (!s) return;
      const r = this.ranges[k];
      drawGrid(s, setup.duration, setup.phases, r);
      drawTrace(s, target.out[k].uv, r, { color: TARGET_COLOR, alpha: 0.75 });
      const out = this.sim?.out[k];
      if (out) drawTrace(s, out.uv, r, { color: CH_COLORS[k], glow: true, edges: true });
    });
  }
}
