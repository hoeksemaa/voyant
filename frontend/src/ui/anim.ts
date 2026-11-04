import type { Marks } from "../puzzle/body";
import type { AnalogIn, Electrode, Setup } from "../puzzle/types";
import type { Clock } from "./clock";
import { fitPhases, phaseStrip, timeAxis } from "./parts";
import { drawGrid, drawTrace, rangeOf, type Range, type Screen } from "./traces";
import { BIAS_COLOR, CH_COLORS, CH_INK, REF_COLOR, wires } from "./wiring";

// The Animation sheet: the arm, the eyes, or the head does the activity, in time with the
// signal. Each electrode glows with its channel's signal. Under it, the analog traces draw
// as time passes. The level's clock drives it, so the playhead on the level matches.

const NS = "http://www.w3.org/2000/svg";

const ART: Record<Setup["body"], { view: string; svg: string }> = {
  arm: {
    view: "-14 4 258 96",
    svg: `
      <defs><radialGradient id="musc" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#f56200" stop-opacity="0.85"/><stop offset="1" stop-color="#f56200" stop-opacity="0"/>
      </radialGradient></defs>
      <path class="skin" d="M-12 23 C10 22.5, 26 21.5, 40 21 C70 19, 100 22, 130 28 C160 33, 185 37, 200 39 L200 61 C185 63, 160 66, 130 71 C100 76, 70 80, 40 79 C26 79, 10 78.5, -12 78.5 Z"/>
      <ellipse class="belly" cx="92" cy="49" rx="54" ry="20" fill="url(#musc)"/>
      <path class="line" d="M-12 23 C10 22.5, 26 21.5, 40 21 C70 19, 100 22, 130 28 C160 33, 185 37, 200 39 M200 61 C185 63, 160 66, 130 71 C100 76, 70 80, 40 79 C26 79, 10 78.5, -12 78.5"/>
      <path class="fine" d="M23 33 Q18 50 23 67 M46 33 C76 27, 112 30, 146 39"/>
      <g class="hand">
        <path class="skin" d="M199 39 C208 36, 220 35, 230 37 C238 39, 240.5 45, 240.5 50 C240.5 56, 238 61, 230 63 C220 65, 208 64, 199 61 Z"/>
        <path class="line" d="M200 39 C208 36, 220 35, 230 37 C238 39, 240.5 45, 240.5 50 C240.5 56, 238 61, 230 63 C220 65, 208 64, 200 61"/>
        <path class="fine fingers" d="M228.5 44.5 L239 45.5 M229 50 L240 50 M228.5 55.5 L239 54.5"/>
        <path class="fine knuckles" d="M226 41 Q236 50 226 59"/>
        <path class="line" d="M213 63.6 C217 70, 225 74.5, 231.5 72 C235 70.5, 234 66.5, 229 63.4"/>
      </g>
      <path class="fine" d="M199 42 Q203.5 50 199 58"/>`,
  },
  face: {
    view: "-16 -2 132 106",
    svg: `
      <path class="line" d="M14.5 40 C2 36, 0 64, 13 67 M85.5 40 C98 36, 100 64, 87 67"/>
      <ellipse class="skin" cx="50" cy="52" rx="36" ry="43"/>
      <ellipse class="line" cx="50" cy="52" rx="36" ry="43"/>
      <path class="fine" d="M28 35 Q36 31 44 34 M56 34 Q64 31 72 35"/>
      <clipPath id="eyeR"><path d="M28 42 Q36 36.5 44 42 Q36 47 28 42 Z"/></clipPath>
      <clipPath id="eyeL"><path d="M56 42 Q64 36.5 72 42 Q64 47 56 42 Z"/></clipPath>
      <path class="white" d="M28 42 Q36 36.5 44 42 Q36 47 28 42 Z M56 42 Q64 36.5 72 42 Q64 47 56 42 Z"/>
      <g clip-path="url(#eyeR)"><circle class="iris" cx="36" cy="42" r="2.9"/><rect class="lid" x="27" y="36" width="18" height="12"/></g>
      <g clip-path="url(#eyeL)"><circle class="iris" cx="64" cy="42" r="2.9"/><rect class="lid" x="55" y="36" width="18" height="12"/></g>
      <path class="line" d="M28 42 Q36 36.5 44 42 Q36 47 28 42 Z M56 42 Q64 36.5 72 42 Q64 47 56 42 Z"/>
      <path class="fine" d="M50 46 L46.5 60 Q50 62 53.5 60 M41 73 Q50 78 59 73"/>`,
  },
  head: {
    view: "-16 -2 132 104",
    svg: `
      <path class="line" d="M10.5 43 C3 41, 2 61, 10.5 59 M89.5 43 C97 41, 98 61, 89.5 59"/>
      <path class="line" d="M43.5 12.5 L50 4 L56.5 12.5"/>
      <circle class="skin" cx="50" cy="51" r="40"/>
      <circle class="line" cx="50" cy="51" r="40"/>
      <path class="guide" d="M50 12 V90 M11 51 H89"/>`,
  },
};

const EYE = `<svg viewBox="0 0 24 14" aria-hidden="true"><path class="white" d="M2 7 Q12 -1 22 7 Q12 15 2 7 Z"/><clipPath id="eyeS"><path d="M2 7 Q12 -1 22 7 Q12 15 2 7 Z"/></clipPath><g clip-path="url(#eyeS)"><circle class="iris" cx="12" cy="7" r="3.4"/><rect class="lid" x="0" y="-1" width="24" height="16"/></g><path class="line" d="M2 7 Q12 -1 22 7 Q12 15 2 7 Z"/></svg>`;

interface Mark {
  e: Electrode;
  ch: number | null;
  glow: SVGCircleElement | null;
}

interface Lane {
  ch: number;
  canvas: HTMLCanvasElement;
  bright: HTMLCanvasElement;
  faint: HTMLCanvasElement;
  size: string; // "w×h" the cache was drawn at
}

const step = (t: number, t0: number, w: number) => (t <= t0 ? 0 : t >= t0 + w ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (t - t0)) / w));

export class AnimView {
  readonly el = document.createElement("div");
  private art = document.createElement("div");
  private svg = document.createElementNS(NS, "svg");
  private status = document.createElement("div");
  private phaseEl = document.createElement("b");
  private timeEl = document.createElement("span");
  private play = document.createElement("button");
  private scope = document.createElement("div");
  private setup: Setup | null = null;
  private marks: Marks = { blinks: [], gaze: [], gaze0: 0 };
  private analog: AnalogIn[] = [];
  private act = new Map<number, Float32Array>(); // channel → activity 0–1 at ACT_RATE
  private pins: Mark[] = [];
  private lanes: Lane[] = [];
  private ranges: Range[] = [];
  private eyes: HTMLElement | null = null;
  private off: (() => void) | null = null;

  constructor(private clock: Clock) {
    this.el.className = "anim";
    this.status.className = "anim-status";
    this.play.type = "button";
    this.play.className = "anim-play";
    this.play.addEventListener("click", () => {
      this.clock.setPlaying(!this.clock.playing);
      this.paintPlay();
    });
    this.timeEl.className = "anim-time";
    const left = document.createElement("div");
    left.className = "anim-now";
    left.append(this.phaseEl, this.timeEl);
    this.status.append(this.play, left);
    this.art.className = "anim-art";
    this.svg.setAttribute("aria-hidden", "true");
    this.art.append(this.svg);
    this.scope.className = "scope scope-anim";
    this.scope.addEventListener("pointerdown", (e) => this.seekAt(e));
    this.el.append(this.status, this.art, this.scope);
    new ResizeObserver(() => this.frame(this.clock.t)).observe(this.scope);
    this.paintPlay();
  }

  setSetup(setup: Setup, marks: Marks, analog: AnalogIn[]): void {
    this.setup = setup;
    this.marks = marks;
    this.clock.duration = setup.duration;
    this.el.dataset.body = setup.body;
    const art = ART[setup.body];
    this.svg.setAttribute("viewBox", art.view);
    this.svg.innerHTML = art.svg;
    const big = setup.body === "arm";
    this.pins = setup.electrodes.map((e) => this.mark(e, big));

    this.eyes?.remove();
    this.eyes = null;
    if (setup.body === "head") {
      this.eyes = document.createElement("div");
      this.eyes.className = "anim-eyes";
      this.eyes.innerHTML = `<span class="eyes">${EYE}${EYE}</span><span class="eyes-text">Eyes open</span>`;
      this.art.append(this.eyes);
    }
    this.setAnalog(analog);
  }

  /** The analog traces change with the firmware (the bias loop), so the sheet follows them. */
  setAnalog(analog: AnalogIn[]): void {
    const setup = this.setup!;
    this.analog = analog;
    this.ranges = analog.map((a) => rangeOf(a.uv));
    this.act.clear();
    for (const a of analog) if (a.uv) this.act.set(a.ch, activity(a.uv, a.rate, setup.body));
    const used = wires(setup).filter((w) => w.p);
    const rh = used.length === 1 ? 120 : used.length === 2 ? 84 : 40;
    this.scope.style.setProperty("--rh", `${rh}px`);
    const strip = document.createElement("div");
    strip.className = "srow strip";
    strip.innerHTML = "<span></span>";
    strip.append(phaseStrip(setup));
    const rows = document.createElement("div");
    rows.className = "rows";
    this.lanes = used.map((w) => {
      const el = document.createElement("div");
      el.className = "srow ch";
      el.style.setProperty("--c", CH_COLORS[w.ch - 1]);
      el.innerHTML = `<div class="gut"><b><i></i>CH${w.ch}</b><span>${w.pLabel} − ${w.nLabel}</span></div><div class="screen"><canvas></canvas></div>`;
      rows.append(el);
      return { ch: w.ch, canvas: el.querySelector("canvas")!, bright: document.createElement("canvas"), faint: document.createElement("canvas"), size: "" };
    });
    const axis = document.createElement("div");
    axis.className = "srow axis";
    axis.innerHTML = "<span></span>";
    axis.append(timeAxis(setup.duration));
    this.scope.replaceChildren(strip, rows, axis);
    requestAnimationFrame(() => {
      fitPhases(this.scope);
      this.frame(this.clock.t);
    });
  }

  start(): void {
    this.off?.();
    this.off = this.clock.on((t) => this.frame(t));
    this.paintPlay();
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  private paintPlay(): void {
    const on = this.clock.playing;
    this.play.setAttribute("aria-label", on ? "Pause" : "Play");
    this.play.innerHTML = on
      ? `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="4" width="3.4" height="12" rx="1"/><rect x="11.6" y="4" width="3.4" height="12" rx="1"/></svg>`
      : `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4 L16 10 L6 16 Z"/></svg>`;
  }

  private seekAt(e: PointerEvent): void {
    const screenEl = this.scope.querySelector(".screen");
    if (!screenEl || !this.setup) return;
    const r = screenEl.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    if (f < 0 || f > 1) return;
    this.clock.seek(f * this.setup.duration);
  }

  private mark(e: Electrode, big: boolean): Mark {
    const box = this.setup!.body === "arm" ? [240, 100] : [100, 100];
    const x = e.x * box[0];
    const y = e.y * box[1];
    const r = big ? 4.6 : 3.4;
    const m = /^IN(\d)P$/.exec(e.pin);
    const ch = m ? Number(m[1]) : null;
    const color = ch ? CH_INK[ch - 1] : e.pin === "BIASOUT" ? BIAS_COLOR : REF_COLOR;
    const g = document.createElementNS(NS, "g");
    let glow: SVGCircleElement | null = null;
    if (ch) {
      glow = document.createElementNS(NS, "circle");
      glow.setAttribute("class", "glow");
      glow.setAttribute("cx", String(x));
      glow.setAttribute("cy", String(y));
      glow.setAttribute("r", String(r));
      glow.setAttribute("fill", color);
      g.append(glow);
    }
    let dot: SVGElement;
    if (e.pin === "BIASOUT") {
      dot = document.createElementNS(NS, "rect");
      const s = r * 1.5;
      dot.setAttribute("x", String(x - s / 2));
      dot.setAttribute("y", String(y - s / 2));
      dot.setAttribute("width", String(s));
      dot.setAttribute("height", String(s));
      dot.setAttribute("transform", `rotate(45 ${x} ${y})`);
      dot.setAttribute("class", "el-mark");
      dot.setAttribute("fill", color);
    } else {
      dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", String(r));
      dot.setAttribute("class", ch ? "el-mark" : "el-mark el-ring");
      if (ch) dot.setAttribute("fill", color);
      else dot.style.stroke = color; // CSS gives marks a white edge; the ring's edge is its color
    }
    g.append(dot);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("class", "el-label");
    const below = this.setup!.body === "arm";
    const side = e.x < 0.5 ? -1 : 1;
    label.setAttribute("x", String(below ? x : x + side * (r + 2.5)));
    label.setAttribute("y", String(below ? y + r + 9 : y + 1.6));
    label.setAttribute("text-anchor", below ? "middle" : side < 0 ? "end" : "start");
    label.textContent = e.id;
    g.append(label);
    this.svg.append(g);
    return { e, ch, glow };
  }

  private frame(t: number): void {
    const setup = this.setup;
    if (!setup || !this.el.offsetParent) return;
    const phase = setup.phases.find((p) => t >= p.t0 && t < p.t1) ?? setup.phases[setup.phases.length - 1];
    this.phaseEl.textContent = phase.label;
    this.timeEl.textContent = `${t.toFixed(1)} s`;
    this.scope.querySelectorAll<HTMLElement>(".phases span").forEach((s, i) => s.classList.toggle("now", setup.phases[i] === phase));

    // The body.
    if (setup.body === "arm") this.arm(t);
    else if (setup.body === "face") this.face(t);
    else this.head(t);

    // Electrode glow: the channel's activity now.
    for (const p of this.pins) {
      if (!p.glow || !p.ch) continue;
      const a = sample(this.act.get(p.ch), t);
      const r0 = setup.body === "arm" ? 4.6 : 3.4;
      p.glow.setAttribute("r", (r0 + (setup.body === "arm" ? 11 : 7) * a).toFixed(2));
      p.glow.style.opacity = (0.08 + 0.42 * a).toFixed(3);
    }

    // The traces: bright up to now, faint after.
    for (const lane of this.lanes) this.lane(lane, t);
  }

  private arm(t: number): void {
    const setup = this.setup!;
    const level = (label: string) => ({ rest: 0, flex: 0.55, "hard flex": 1 })[label.toLowerCase()] ?? 0;
    let c = level(setup.phases[0].label);
    for (let k = 1; k < setup.phases.length; k++) c += (level(setup.phases[k].label) - level(setup.phases[k - 1].label)) * step(t, setup.phases[k].t0, 0.15);
    const shake = c > 0.7 ? 0.5 * Math.sin(2 * Math.PI * 9.5 * t) * c : 0; // tremor in a hard grip
    const hand = this.svg.querySelector<SVGGElement>(".hand");
    hand?.setAttribute("transform", `translate(200 50) rotate(${(-4 * c + shake).toFixed(2)}) scale(${(1 - 0.13 * c).toFixed(3)} ${(1 + 0.05 * c).toFixed(3)}) translate(-200 -50)`);
    const fingers = this.svg.querySelector<SVGElement>(".fingers");
    if (fingers) fingers.style.opacity = (1 - 0.85 * c).toFixed(2);
    const knuckles = this.svg.querySelector<SVGElement>(".knuckles");
    if (knuckles) knuckles.style.opacity = (c * 0.9).toFixed(2);
    const belly = this.svg.querySelector<SVGElement>(".belly");
    if (belly) {
      belly.style.opacity = (0.05 + 0.55 * c).toFixed(3);
      belly.setAttribute("transform", `translate(92 49) scale(1 ${(1 + 0.16 * c).toFixed(3)}) translate(-92 -49)`);
    }
  }

  private gaze(t: number): number {
    let g = this.marks.gaze0;
    for (const m of this.marks.gaze) g += m.d * step(t, m.t, 0.05);
    return g;
  }

  private blink(t: number): number {
    let b = 0;
    for (const tb of this.marks.blinks) b = Math.max(b, Math.exp(-(((t - tb) / 0.07) ** 2)));
    return b;
  }

  private face(t: number): void {
    const dx = (this.gaze(t) / 30) * 4.6; // + = the subject's left = the drawing's right
    const irises = this.svg.querySelectorAll<SVGCircleElement>(".iris");
    irises[0]?.setAttribute("cx", (36 + dx).toFixed(2));
    irises[1]?.setAttribute("cx", (64 + dx).toFixed(2));
    const b = this.blink(t);
    for (const lid of this.svg.querySelectorAll<SVGRectElement>(".lid")) lid.setAttribute("height", (12 * b).toFixed(2));
  }

  private head(t: number): void {
    const setup = this.setup!;
    const closed = setup.phases.find((p) => /closed/i.test(p.label));
    let c = closed ? step(t, closed.t0, 0.12) * (1 - step(t, closed.t1, 0.12)) : 0;
    c = Math.max(c, this.blink(t));
    if (this.eyes) {
      for (const lid of this.eyes.querySelectorAll<SVGRectElement>(".lid")) lid.setAttribute("height", (16 * c).toFixed(2));
      this.eyes.querySelector(".eyes-text")!.textContent = c > 0.5 ? "Eyes closed" : "Eyes open";
      this.eyes.classList.toggle("shut", c > 0.5);
    }
  }

  private lane(lane: Lane, t: number): void {
    const setup = this.setup!;
    const c = lane.canvas;
    const cw = c.clientWidth;
    const chh = c.clientHeight;
    if (cw < 2 || chh < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cw * dpr);
    const h = Math.round(chh * dpr);
    const size = `${w}×${h}`;
    if (lane.size !== size) {
      // Draw the two versions of the trace one time for this size.
      lane.size = size;
      const k = lane.ch - 1;
      const a = this.analog[k];
      for (const [cv, bright] of [
        [lane.bright, true],
        [lane.faint, false],
      ] as const) {
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d")!;
        ctx.clearRect(0, 0, w, h);
        const s: Screen = { ctx, w, h, dpr };
        if (bright) drawGrid(s, setup.duration, setup.phases, this.ranges[k]);
        if (a.uv) drawTrace(s, a.uv, this.ranges[k], { color: CH_COLORS[k], glow: bright, alpha: bright ? 1 : 0.2 });
      }
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    const x = Math.round((t / setup.duration) * w);
    ctx.drawImage(lane.faint, 0, 0);
    if (x > 0) ctx.drawImage(lane.bright, 0, 0, x, h, 0, 0, x, h);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x - dpr, 0, 2 * dpr, h);
  }
}

const ACT_RATE = 50; // Hz

/**
 * How active a channel is over time, 0–1. EOG: distance from the trace's middle (gaze).
 * EEG and EMG: the rms of the trace minus its slow level (alpha, blinks, muscle bursts).
 */
function activity(uv: Float32Array, rate: number, body: Setup["body"]): Float32Array {
  const n = Math.floor((uv.length / rate) * ACT_RATE);
  const out = new Float32Array(n);
  const per = rate / ACT_RATE;
  if (body === "face") {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of uv) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const mid = (lo + hi) / 2;
    const half = Math.max(1, (hi - lo) / 2);
    for (let j = 0; j < n; j++) out[j] = Math.min(1, Math.abs(uv[Math.floor(j * per)] - mid) / half);
    return out;
  }
  // Slow level: a 0.25 s moving average (prefix sums), then the rms over 60 ms.
  const c = new Float64Array(uv.length + 1);
  for (let i = 0; i < uv.length; i++) c[i + 1] = c[i] + uv[i];
  const W = Math.round(0.125 * rate);
  const hp = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i++) {
    const a = Math.max(0, i - W);
    const b = Math.min(uv.length, i + W + 1);
    hp[i] = uv[i] - (c[b] - c[a]) / (b - a);
  }
  const R = Math.round(0.03 * rate);
  let max = 1e-9;
  for (let j = 0; j < n; j++) {
    const m = Math.floor(j * per);
    let ss = 0;
    let k = 0;
    for (let i = Math.max(0, m - R); i < Math.min(uv.length, m + R); i++) {
      ss += hp[i] * hp[i];
      k++;
    }
    out[j] = Math.sqrt(ss / Math.max(1, k));
    if (out[j] > max) max = out[j];
  }
  for (let j = 0; j < n; j++) out[j] = Math.min(1, out[j] / max) ** 0.8;
  return out;
}

function sample(a: Float32Array | undefined, t: number): number {
  if (!a || !a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(t * ACT_RATE)))];
}
