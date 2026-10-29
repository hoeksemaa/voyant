import type { Curves } from "./curves";
import type { Scopes } from "./scopes";
import { formatTime, loadClip, type Clip, type Region, type RunIndex, type Speed, type StepData } from "./sim-data";

// Plays one sequence at one of three fixed speeds. Playback runs at that speed through each
// region; between regions (quiet time at the slow speeds) it pauses briefly, then skips ahead.

const HOLD = 0.7; // seconds to pause before a skip

const ICON = { pass: "✓", warn: "!", fail: "✕" } as const;

const SHORT: Record<string, string> = { real: "Real time", ms: "1 ms / s", us: "1 µs / s" };

function slower(speed: Speed, screen: number): string {
  const across = `${formatTime(screen * speed.rate)} on screen`;
  if (speed.rate === 1) return `Real time · ${across}`;
  return `${Math.round(1 / speed.rate).toLocaleString("en-US")}× slower · ${across}`;
}

interface LogItem {
  t: number;
  step: number;
  cls: string;
  html: string;
}

export class Player {
  private seq: string | null = null;
  private speed: Speed;
  private clip: Clip | null = null;
  private r = 0; // region index
  private p = 0; // playback seconds into the region
  private playing = false;
  private hold = 0; // seconds left in the pause before a skip
  private forced = 0; // the step chosen with the buttons; playback never shows an earlier one
  private current = -1;
  private log: LogItem[] = [];
  private shown = -1;
  private active = "";
  private loads = 0;

  private panel = document.createElement("section");
  private el: Record<"count" | "dots" | "title" | "text" | "quote" | "note" | "bar" | "log" | "play", HTMLElement>;
  private speedButtons: HTMLButtonElement[] = [];

  constructor(
    private run: RunIndex,
    private scopes: Scopes,
    private curves: Curves,
  ) {
    this.speed = run.speeds.find((s) => s.id === "ms") ?? run.speeds[0];
    this.panel.className = "step-panel";
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="step-head">
        <span class="step-count"></span>
        <span class="step-dots"></span>
        <span class="step-controls">
          <button class="prev" aria-label="Previous step">‹</button>
          <button class="play">Pause</button>
          <button class="next" aria-label="Next step">›</button>
        </span>
      </div>
      <h2></h2>
      <p class="step-text"></p>
      <blockquote></blockquote>
      <div class="step-speed">
        <span class="speed-buttons" role="group" aria-label="Playback speed"></span>
        <span class="speed-note"></span>
      </div>
      <div class="step-bar"><i></i></div>
      <ul class="step-log"></ul>`;
    const q = <T extends HTMLElement>(sel: string) => this.panel.querySelector<T>(sel)!;
    this.el = {
      count: q(".step-count"),
      dots: q(".step-dots"),
      title: q("h2"),
      text: q(".step-text"),
      quote: q("blockquote"),
      note: q(".speed-note"),
      bar: q(".step-bar i"),
      log: q(".step-log"),
      play: q(".play"),
    };
    const group = q(".speed-buttons");
    run.speeds.forEach((s, i) => {
      const b = document.createElement("button");
      b.textContent = SHORT[s.id] ?? s.label;
      b.title = `${s.label} (key ${i + 1})`;
      b.addEventListener("click", () => this.setSpeed(s));
      group.append(b);
      this.speedButtons.push(b);
    });
    q(".prev").addEventListener("click", () => this.jump(this.current - 1));
    q(".next").addEventListener("click", () => this.jump(this.current + 1));
    this.el.play.addEventListener("click", () => this.togglePlay());
    this.el.dots.addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).dataset.i;
      if (i !== undefined) this.jump(Number(i));
    });
    document.body.append(this.panel);

    window.addEventListener("keydown", (e) => {
      if (!this.seq || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === "ArrowRight") this.jump(this.current + 1);
      else if (e.key === "ArrowLeft") this.jump(this.current - 1);
      else if (/^[1-9]$/.test(e.key) && run.speeds[Number(e.key) - 1]) this.setSpeed(run.speeds[Number(e.key) - 1]);
    });
  }

  get open(): boolean {
    return this.seq !== null;
  }

  get stepPanel(): HTMLElement {
    return this.panel;
  }

  play(id: string): void {
    this.seq = id;
    this.clip = null;
    this.panel.hidden = false;
    this.scopes.setVisible(true);
    this.curves.setVisible(true);
    this.load(null, true);
  }

  close(): void {
    this.seq = null;
    this.clip = null;
    this.loads++;
    this.panel.hidden = true;
    this.scopes.setVisible(false);
    this.curves.setVisible(false);
    this.setPlaying(false);
  }

  // Change speed and play the current step again from its start at the new speed.
  private setSpeed(s: Speed): void {
    if (!this.seq || s === this.speed) return;
    this.speed = s;
    const step = this.clip?.steps[this.current]?.id ?? null;
    this.load(step, true);
  }

  private async load(stepId: string | null, autoplay: boolean): Promise<void> {
    const seq = this.seq!;
    const n = ++this.loads;
    this.speedButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(this.run.speeds[i] === this.speed)));
    this.el.note.textContent = "Loading…";
    this.panel.classList.add("loading");
    let clip: Clip;
    try {
      clip = await loadClip(seq, this.speed.id);
    } catch {
      if (n === this.loads) this.el.note.textContent = "Could not load this speed. Try again.";
      return;
    }
    if (n !== this.loads) return; // closed, or another speed was chosen while loading
    this.panel.classList.remove("loading");
    this.clip = clip;
    for (const s of this.run.speeds) if (s !== this.speed) loadClip(seq, s.id).catch(() => {});
    this.log = this.buildLog(clip);
    this.el.dots.innerHTML = clip.steps
      .map((s, i) => `<button class="dot" data-i="${i}" title="${s.title}"></button>`)
      .join("");
    const across = this.run.screen * this.speed.rate;
    this.scopes.setAxis(`${formatTime(across)} across · ${formatTime(across / 10)} per division`);
    this.current = -1;
    this.go(Math.max(0, clip.steps.findIndex((s) => s.id === stepId)));
    this.setPlaying(autoplay);
  }

  private setPlaying(on: boolean): void {
    this.playing = on;
    this.curves.setPlaying(on);
    this.el.play.textContent = on ? "Pause" : this.atEnd ? "Replay" : "Play";
  }

  private get region(): Region {
    return this.clip!.regions[this.r];
  }

  private get atEnd(): boolean {
    if (!this.clip) return false;
    return this.r === this.clip.regions.length - 1 && this.p >= this.region.n / this.run.sps;
  }

  private togglePlay(): void {
    if (!this.clip) return;
    if (!this.playing && this.atEnd) {
      this.go(0);
      this.setPlaying(true);
      return;
    }
    this.setPlaying(!this.playing);
  }

  // Go to a step from the buttons. After the end, this also starts playback again.
  private jump(i: number): void {
    const ended = !this.playing && this.atEnd;
    this.go(i);
    if (ended) this.setPlaying(true);
  }

  private go(i: number): void {
    if (!this.clip) return;
    i = Math.max(0, Math.min(this.clip.steps.length - 1, i));
    const step = this.clip.steps[i];
    this.r = step.region;
    this.p = step.p0;
    this.forced = i;
    this.hold = 0;
    this.shown = -1;
    this.update();
    this.setPlaying(this.playing);
  }

  private get tNow(): number {
    return this.region.t0 + this.p * this.speed.rate;
  }

  // Advance playback. Returns true while frames are needed.
  tick(dt: number): boolean {
    if (!this.seq) return false;
    if (!this.clip) return true; // loading
    if (this.playing) {
      if (this.hold > 0) {
        this.hold -= dt;
        if (this.hold <= 0) {
          this.r++;
          this.p = (this.region.tp - this.region.t0) / this.speed.rate;
        }
      } else {
        const end = this.region.n / this.run.sps;
        this.p = Math.min(end, this.p + dt);
        if (this.p >= end) {
          if (this.r < this.clip.regions.length - 1) this.hold = HOLD;
          else this.setPlaying(false);
        }
      }
    }
    this.update();
    return true; // curves follow the camera, so keep drawing while a sequence is open
  }

  private update(): void {
    const clip = this.clip!;
    const region = this.region;
    this.scopes.draw(region, this.p, this.speed.rate);

    const active = this.scopes.moving(region, this.p);
    const key = [...active].sort().join();
    if (key !== this.active) {
      this.active = key;
      this.curves.setActive(active);
    }

    // The latest step whose moment has passed, but never before the one chosen with the buttons.
    const t = this.tNow;
    let latest = 0;
    clip.steps.forEach((s, i) => {
      if (s.anchor <= t) latest = i;
    });
    const current = Math.max(this.forced, latest);
    if (current !== this.current) {
      this.current = current;
      this.renderStep();
    }

    const note = this.el.note;
    if (this.hold > 0) {
      const next = clip.regions[this.r + 1];
      note.textContent = `Skipping ahead ${formatTime(next.tp - region.t1)} to the next event`;
      note.classList.add("skip");
    } else {
      note.classList.remove("skip");
      note.textContent = slower(this.speed, this.run.screen);
    }
    this.el.bar.style.width = `${(this.progress() * 100).toFixed(2)}%`;
    this.renderLog(t);
  }

  // How far through the whole sequence playback is, from 0 to 1.
  private progress(): number {
    const rate = this.speed.rate;
    let done = 0;
    let total = 0;
    this.clip!.regions.forEach((g, i) => {
      const len = (g.t1 - g.tp) / rate;
      total += len;
      if (i < this.r) done += len;
      if (i === this.r) done += Math.max(0, Math.min(len, this.p - (g.tp - g.t0) / rate));
    });
    return total ? done / total : 0;
  }

  private renderStep(): void {
    const clip = this.clip!;
    const step = clip.steps[this.current];
    const title = this.run.sequences.find((s) => s.id === this.seq)?.title ?? "";
    this.el.count.textContent = `${title} · step ${this.current + 1} of ${clip.steps.length}`;
    this.el.dots.querySelectorAll<HTMLElement>(".dot").forEach((d, i) => {
      d.classList.toggle("on", i === this.current);
      d.classList.toggle("done", i < this.current);
    });
    this.el.title.textContent = step.title;
    this.el.text.textContent = step.text;
    this.el.quote.className = step.quote ? "" : "plain";
    this.el.quote.innerHTML = step.quote
      ? `“${step.quote}”<cite>Datasheet ${step.cite}</cite>`
      : `<cite>${step.cite}</cite>`;
    this.shown = -1;
  }

  // Notes and datasheet checks for the whole sequence, in time order.
  private buildLog(clip: Clip): LogItem[] {
    const items: LogItem[] = [];
    clip.steps.forEach((step: StepData, i) => {
      const at = (t: number) => `+${formatTime(t - step.anchor)}`;
      for (const [t, text] of step.notes) {
        items.push({ t, step: i, cls: "note", html: `<span>${at(t)}</span>${text}` });
      }
      for (const c of step.checks) {
        const rule = this.run.rules[c.rule];
        const times = c.count > 1 ? ` <em>×${c.count}</em>` : "";
        const quote = c.status === "pass" ? "" : `<q>${rule.quote} <cite>${rule.cite}</cite></q>`;
        items.push({
          t: c.t,
          step: i,
          cls: `check ${c.status}`,
          html: `<b>${ICON[c.status]}</b><span><strong>${rule.title}</strong>${times} ${c.detail}${quote}</span>`,
        });
      }
    });
    return items.sort((a, b) => a.t - b.t);
  }

  // Items appear as playback reaches them. Items from earlier steps fade.
  private renderLog(t: number): void {
    let n = 0;
    while (n < this.log.length && this.log[n].t <= t) n++;
    if (n === this.shown) return;
    this.shown = n;
    this.el.log.innerHTML = this.log
      .slice(0, n)
      .map((item) => `<li class="${item.cls}${item.step < this.current ? " old" : ""}">${item.html}</li>`)
      .join("");
    this.el.log.scrollTop = this.el.log.scrollHeight;
  }
}
