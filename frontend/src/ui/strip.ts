import type { MatchResult, Setup, SimResult } from "../puzzle/types";
import { outSpec } from "./parts";
import { drawTrace, rangeOf, screen, type Range } from "./traces";
import { CH_COLORS, TARGET_BAND, wires } from "./wiring";

// The live strip at the top of the Firmware sheet: each channel's output over its target,
// small, so a bit change shows at once without closing the sheet.

interface Lane {
  ch: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
}

const laneHeight = (n: number) => (n === 1 ? 64 : n === 2 ? 42 : n <= 4 ? 28 : 18);

export class Strip {
  readonly el = document.createElement("div");
  private head = document.createElement("div");
  private dots = document.createElement("span");
  private score = document.createElement("b");
  private spec = document.createElement("span");
  private lanesEl = document.createElement("div");
  private lanes: Lane[] = [];
  private target: SimResult | null = null;
  private sim: SimResult | null = null;
  private ranges: Range[] = [];
  private queued = false;

  constructor() {
    this.el.className = "fw-strip";
    this.head.className = "strip-head";
    this.dots.className = "dots";
    this.spec.className = "spec-out";
    const left = document.createElement("span");
    left.className = "strip-score";
    left.append(this.dots, this.score);
    this.head.append(left, this.spec);
    this.lanesEl.className = "strip-lanes";
    this.el.append(this.head, this.lanesEl);
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  setSetup(setup: Setup, target: SimResult): void {
    this.target = target;
    this.sim = null;
    this.ranges = target.out.map((o) => rangeOf(o.uv, o.status === "off"));
    const used = wires(setup).filter((w) => w.p);
    this.lanesEl.style.setProperty("--lh", `${laneHeight(used.length)}px`);
    this.lanes = used.map((w) => {
      const el = document.createElement("div");
      el.className = "strip-lane";
      el.style.setProperty("--c", CH_COLORS[w.ch - 1]);
      el.innerHTML = `<b>CH${w.ch}</b><canvas></canvas>`;
      return { ch: w.ch, el, canvas: el.querySelector("canvas")! };
    });
    this.lanesEl.replaceChildren(...this.lanes.map((l) => l.el));
    this.schedule();
  }

  setResult(sim: SimResult, m: MatchResult): void {
    this.sim = sim;
    const used = m.channels.filter((c) => m.used.includes(c.ch));
    const passed = used.filter((c) => c.pass).length;
    this.dots.innerHTML = used.map((c) => `<i class="${c.pass ? "ok" : ""}"></i>`).join("");
    this.score.textContent = m.pass ? "Solved" : `${passed} / ${used.length} match`;
    this.el.classList.toggle("good", m.pass);
    outSpec(this.spec, sim, this.target!);
    for (const l of this.lanes) l.el.classList.toggle("ok", m.channels[l.ch - 1].pass);
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
    if (!this.target || !this.el.offsetParent) return;
    for (const l of this.lanes) {
      const s = screen(l.canvas);
      if (!s) continue;
      const k = l.ch - 1;
      drawTrace(s, this.target.out[k].uv, this.ranges[k], { ...TARGET_BAND, band: 2 });
      const out = this.sim?.out[k];
      if (out) drawTrace(s, out.uv, this.ranges[k], { color: CH_COLORS[k], edges: true });
    }
  }
}
