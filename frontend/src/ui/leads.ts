import type { Electrode, Setup } from "../puzzle/types";
import { BIAS_COLOR, CH_INK, REF_COLOR } from "./wiring";

// The lead wires in the Animation sheet: each electrode has a wire to a port that names where
// it goes on the chip (CH1 = IN1P, SRB1, BIAS = BIASOUT), in the colors of the level's ports.
// Dots run along each wire: into the chip from an input, out to the body from BIAS.
// They move with the level clock, and an input's dots are as bright as its channel is active.
//
// Ports: in a row under the arm and the face (the wires drop straight down, so none cross), and
// in a column on each side of the head (the wires go out to the near side).

type P = [number, number];
const NS = "http://www.w3.org/2000/svg";

/** The art's view box with room for the ports. */
export const LEAD_VIEW: Record<Setup["body"], string> = {
  arm: "-14 -30 258 145",
  face: "-16 -2 132 124",
  head: "-38 -2 176 106",
};
const ROW_Y: Partial<Record<Setup["body"], number>> = { arm: 101, face: 113 };
const COL_X = { left: -26, right: 126 }; // the head's port columns
const PILL_H = 9.5;
// Pill size by body, so the port text is about the same size on screen on each level (the arm's
// wide view box draws at fewer px per unit).
const PILL_K: Record<Setup["body"], number> = { arm: 1.6, face: 0.85, head: 1 };
const GAP = 21; // the least space between two port centers in a row (× PILL_K)
const COL_GAP = 13; // and in a column
// Dot pattern, in screen px (the art's strokes do not scale). 18 px/s × 10 s = 20 periods, so a
// loop of the clock does not make the dots jump.
const DOT_GAP = 9;
const SPEED = 18;

interface Lead {
  e: Electrode;
  ch: number | null;
  out: boolean; // BIAS: the signal goes from the chip to the body
  port: P;
  side: "down" | "left" | "right";
  w: number; // the port's width
  h: number; // and its height
  wire: SVGPathElement;
  dots: SVGPathElement;
}

const f = (v: number) => v.toFixed(2);

/** Spread sorted positions so each is at least `gap` past the last, keeping their middle. */
function spread(xs: number[], gap: number): number[] {
  const out = xs.slice();
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  const shift = out.reduce((a, x, i) => a + x - xs[i], 0) / out.length;
  return out.map((x) => x - shift);
}

export class Leads {
  /** The wires and ports. It goes over the body and under the electrode marks. */
  readonly el = document.createElementNS(NS, "g");
  private leads: Lead[] = [];

  /** rest: each electrode's place in the art (view box units). */
  constructor(setup: Setup, rest: (e: Electrode) => P) {
    this.el.setAttribute("class", "leads");
    const K = PILL_K[setup.body];
    const ports = new Map<Electrode, { at: P; side: Lead["side"] }>();
    const row = ROW_Y[setup.body];
    if (row !== undefined) {
      const es = setup.electrodes.slice().sort((a, b) => rest(a)[0] - rest(b)[0]);
      const xs = spread(es.map((e) => rest(e)[0]), GAP * K);
      es.forEach((e, i) => ports.set(e, { at: [xs[i], row], side: "down" }));
    } else {
      for (const side of ["left", "right"] as const) {
        const es = setup.electrodes.filter((e) => (e.x < 0.5) === (side === "left")).sort((a, b) => rest(a)[1] - rest(b)[1]);
        if (!es.length) continue;
        // Even steps from the top electrode to the bottom one, so the wires fan out.
        const lo = rest(es[0])[1];
        const hi = rest(es[es.length - 1])[1];
        const step = es.length > 1 ? Math.max(COL_GAP, (hi - lo) / (es.length - 1)) : 0;
        const ys = es.map((_, i) => lo + i * step);
        const shift = (ys[ys.length - 1] - hi) / 2;
        es.forEach((e, i) => ports.set(e, { at: [COL_X[side], ys[i] - shift], side }));
      }
    }

    const wires = document.createElementNS(NS, "g");
    const pills = document.createElementNS(NS, "g");
    this.el.append(wires, pills);
    for (const e of setup.electrodes) {
      const p = ports.get(e)!;
      const m = /^IN(\d)P$/.exec(e.pin);
      const ch = m ? Number(m[1]) : null;
      const out = e.pin === "BIASOUT";
      const color = ch ? CH_INK[ch - 1] : out ? BIAS_COLOR : REF_COLOR;
      const text = ch ? `CH${ch}` : out ? "BIAS" : "SRB1"; // SRB1: as the trace lanes name it
      const w = (text.length > 3 ? 21 : 17.5) * K;
      const h = PILL_H * K;
      const wire = document.createElementNS(NS, "path");
      wire.setAttribute("class", "lead-wire");
      wire.setAttribute("stroke", color);
      const dots = document.createElementNS(NS, "path");
      dots.setAttribute("class", "lead-dots");
      dots.setAttribute("stroke", color);
      dots.style.strokeDasharray = `0 ${DOT_GAP}`;
      wires.append(wire, dots);
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", `lead-port${ch ? "" : out ? " lead-bias" : " lead-ref"}`);
      g.innerHTML = `<rect x="${f(p.at[0] - w / 2)}" y="${f(p.at[1] - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}"/><text x="${f(p.at[0])}" y="${f(p.at[1] + 2.05 * K)}" text-anchor="middle">${text}</text>`;
      g.querySelector("text")!.style.fontSize = `${f(5.4 * K)}px`;
      // Inline styles: the CSS sets the pill's look, and these give it its color.
      if (ch || out) g.querySelector("rect")!.style.fill = color;
      else {
        g.querySelector("rect")!.style.stroke = color;
        g.querySelector("text")!.style.fill = color;
      }
      pills.append(g);
      this.leads.push({ e, ch, out, port: p.at, side: p.side, w, h, wire, dots });
    }
  }

  /** at: each electrode's place now. act: a channel's activity now, 0–1. */
  draw(t: number, at: (e: Electrode) => P, act: (ch: number) => number): void {
    for (const l of this.leads) {
      const [x, y] = at(l.e);
      const [px, py] = l.port;
      let d: string;
      if (l.side === "down") {
        const ey = py - l.h / 2;
        const k = 0.5 * (ey - y);
        d = `M${f(x)} ${f(y)} C${f(x)} ${f(y + k)} ${f(px)} ${f(ey - k)} ${f(px)} ${f(ey)}`;
      } else {
        const dir = l.side === "left" ? -1 : 1;
        const ex = px - dir * (l.w / 2);
        const k = 0.5 * Math.abs(ex - x);
        d = `M${f(x)} ${f(y)} C${f(x + dir * k)} ${f(y)} ${f(ex - dir * k)} ${f(py)} ${f(ex)} ${f(py)}`;
      }
      l.wire.setAttribute("d", d);
      l.dots.setAttribute("d", d);
      // The path runs from the electrode to the port: a falling offset moves the dots along it.
      const off = (SPEED * t) % DOT_GAP;
      l.dots.style.strokeDashoffset = f(l.out ? off : -off);
      const a = l.ch ? act(l.ch) : l.out ? 0.55 : 0.35;
      l.wire.style.opacity = (0.45 + 0.4 * a).toFixed(3);
      l.dots.style.opacity = (0.15 + 0.85 * a).toFixed(3);
    }
  }
}
