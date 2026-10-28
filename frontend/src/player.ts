import type { Curves } from "./curves";
import type { Scopes } from "./scopes";
import { formatTime, trace, type ProbeInfo, type RunData, type SequenceData, type StepData } from "./sim-data";

// Plays one sequence step by step. Each step's real-time window is stretched to its own
// playback length, so the step panel always says how much slower than real time it runs.

const HOLD = 1.2; // seconds to rest on a finished step before the next one

function slower(step: StepData): string {
  const span = step.t1 - step.t0;
  const factor = step.view / span;
  if (factor < 1.5) return `${formatTime(span)} of real time, about real speed`;
  const rounded = Number(factor.toPrecision(2));
  return `${formatTime(span)} of real time, ${rounded.toLocaleString("en-US")}× slower`;
}

const ICON = { pass: "✓", warn: "!", fail: "✕" } as const;

// True if the probe changes by more than noise during the step.
function moves(step: StepData, probe: ProbeInfo): boolean {
  const tr = trace(step, probe);
  if (tr.constant) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < step.n; i++) {
    if (tr.lo[i] < lo) lo = tr.lo[i];
    if (tr.hi[i] > hi) hi = tr.hi[i];
  }
  return hi - lo > 0.04 * (probe.hi - probe.lo);
}

export class Player {
  private seq: SequenceData | null = null;
  private index = 0;
  private t = 0; // playback seconds into the step
  private held = 0;
  private playing = false;
  private panel = document.createElement("section");
  private shown = { notes: -1, checks: -1 };

  constructor(
    private run: RunData,
    private scopes: Scopes,
    private curves: Curves,
  ) {
    this.panel.className = "step-panel";
    this.panel.hidden = true;
    document.body.append(this.panel);
    window.addEventListener("keydown", (e) => {
      if (!this.seq || e.metaKey || e.ctrlKey) return;
      if (e.key === " ") {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === "ArrowRight") this.go(this.index + 1);
      else if (e.key === "ArrowLeft") this.go(this.index - 1);
    });
  }

  get open(): boolean {
    return this.seq !== null;
  }

  get stepPanel(): HTMLElement {
    return this.panel;
  }

  play(id: string): void {
    this.seq = this.run.sequences.find((s) => s.id === id) ?? null;
    if (!this.seq) return;
    this.panel.hidden = false;
    this.scopes.setVisible(true);
    this.curves.setVisible(true);
    this.go(0);
    this.setPlaying(true);
  }

  close(): void {
    this.seq = null;
    this.panel.hidden = true;
    this.scopes.setVisible(false);
    this.curves.setVisible(false);
    this.setPlaying(false);
  }

  private setPlaying(on: boolean): void {
    this.playing = on;
    this.curves.setPlaying(on);
    const btn = this.panel.querySelector<HTMLButtonElement>(".play");
    if (btn) {
      const atEnd = this.seq && this.index === this.seq.steps.length - 1 && this.t >= this.step.view;
      btn.textContent = on ? "Pause" : atEnd ? "Replay" : "Play";
    }
  }

  private togglePlay(): void {
    if (!this.seq) return;
    if (!this.playing && this.index === this.seq.steps.length - 1 && this.t >= this.step.view) {
      this.go(0);
      this.setPlaying(true);
      return;
    }
    this.setPlaying(!this.playing);
  }

  private get step(): StepData {
    return this.seq!.steps[this.index];
  }

  private go(i: number): void {
    if (!this.seq) return;
    this.index = Math.max(0, Math.min(this.seq.steps.length - 1, i));
    this.t = 0;
    this.held = 0;
    this.shown = { notes: -1, checks: -1 };
    this.renderPanel();
    const step = this.step;
    const active = new Set(this.run.probes.filter((p) => moves(step, p)).map((p) => p.id));
    this.curves.setActive(active);
    this.setPlaying(this.playing);
  }

  // Advance playback. Returns true while frames are needed.
  tick(dt: number): boolean {
    if (!this.seq) return false;
    if (this.playing) {
      const step = this.step;
      if (this.t < step.view) {
        this.t = Math.min(step.view, this.t + dt);
      } else if (this.index < this.seq.steps.length - 1) {
        this.held += dt;
        if (this.held >= HOLD) this.go(this.index + 1);
      } else {
        this.setPlaying(false);
      }
    }
    this.draw();
    return true; // curves follow the camera, so keep drawing while a sequence is open
  }

  private draw(): void {
    const step = this.step;
    const f = this.t / step.view;
    this.scopes.draw(step, f, `Sweep: ${formatTime(step.t1 - step.t0)} of real time`);
    this.renderLog(step, step.t0 + f * (step.t1 - step.t0));
    const bar = this.panel.querySelector<HTMLElement>(".step-bar i");
    if (bar) bar.style.width = `${(f * 100).toFixed(2)}%`;
  }

  private renderPanel(): void {
    const seq = this.seq!;
    const step = this.step;
    const dots = seq.steps
      .map((s, i) => `<button class="dot${i === this.index ? " on" : ""}${i < this.index ? " done" : ""}" data-i="${i}" title="${s.title}"></button>`)
      .join("");
    const quote = step.quote
      ? `<blockquote>“${step.quote}”<cite>Datasheet ${step.cite}</cite></blockquote>`
      : `<blockquote class="plain"><cite>${step.cite}</cite></blockquote>`;
    this.panel.innerHTML = `
      <div class="step-head">
        <span class="step-count">${seq.title} · step ${this.index + 1} of ${seq.steps.length}</span>
        <span class="step-dots">${dots}</span>
        <span class="step-controls">
          <button class="prev" aria-label="Previous step">‹</button>
          <button class="play">Pause</button>
          <button class="next" aria-label="Next step">›</button>
        </span>
      </div>
      <h2>${step.title}</h2>
      <p class="step-text">${step.text}</p>
      ${quote}
      <p class="step-scale">${slower(step)}</p>
      <div class="step-bar"><i></i></div>
      <ul class="step-log"></ul>`;
    this.panel.querySelector(".prev")!.addEventListener("click", () => this.go(this.index - 1));
    this.panel.querySelector(".next")!.addEventListener("click", () => this.go(this.index + 1));
    this.panel.querySelector(".play")!.addEventListener("click", () => this.togglePlay());
    this.panel.querySelectorAll<HTMLButtonElement>(".dot").forEach((b) =>
      b.addEventListener("click", () => this.go(Number(b.dataset.i))),
    );
  }

  // Notes and datasheet checks appear as the sweep reaches them.
  private renderLog(step: StepData, tNow: number): void {
    const notes = step.notes.filter(([t]) => t <= tNow);
    const checks = step.checks.filter((c) => c.t <= tNow);
    if (notes.length === this.shown.notes && checks.length === this.shown.checks) return;
    this.shown = { notes: notes.length, checks: checks.length };
    const items: [number, string][] = [
      ...notes.map(([t, text]): [number, string] => [t, `<li class="note"><span>+${formatTime(t - step.t0)}</span>${text}</li>`]),
      ...checks.map((c): [number, string] => {
        const rule = this.run.rules[c.rule];
        const times = c.count > 1 ? ` <em>×${c.count}</em>` : "";
        const quote = c.status === "pass" ? "" : `<q>${rule.quote} <cite>${rule.cite}</cite></q>`;
        return [c.t, `<li class="check ${c.status}"><b>${ICON[c.status]}</b><span><strong>${rule.title}</strong>${times} ${c.detail}${quote}</span></li>`];
      }),
    ];
    items.sort((a, b) => a[0] - b[0]);
    const log = this.panel.querySelector(".step-log")!;
    log.innerHTML = items.map(([, html]) => html).join("");
    log.scrollTop = log.scrollHeight;
  }
}
