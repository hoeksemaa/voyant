import type { Electrode, Setup } from "../puzzle/types";
import { electrodeColor } from "./wiring";

// Line art of the body with the electrodes on it. Electrode x/y (0–1) come from setups.ts.
// Marks: a filled dot is an INnP electrode, a ring is a reference (SRB1 or INnN), and a
// diamond is the bias electrode. The box keeps the art's aspect ratio, so the marks stay on it.

interface Art {
  box: [number, number];
  svg: string;
  labels: "side" | "below";
}

const ART: Record<Setup["body"], Art> = {
  // Top view, nose up. Dashed lines: the midline and the ear-to-ear line of the 10–20 system.
  head: {
    box: [100, 100],
    labels: "side",
    svg: `
      <path d="M10.5 43 C3 41, 2 61, 10.5 59 M89.5 43 C97 41, 98 61, 89.5 59"/>
      <path d="M43.5 12.5 L50 4 L56.5 12.5"/>
      <circle cx="50" cy="51" r="40"/>
      <path class="guide" d="M50 12 V90 M11 51 H89"/>`,
  },
  // Front view. The subject's left eye is on the right of the drawing.
  face: {
    box: [100, 100],
    labels: "side",
    svg: `
      <path d="M14.5 40 C2 36, 0 64, 13 67 M85.5 40 C98 36, 100 64, 87 67"/>
      <ellipse cx="50" cy="52" rx="36" ry="43"/>
      <path class="fine" d="M28 35 Q36 31 44 34 M56 34 Q64 31 72 35"/>
      <path d="M28 42 Q36 36.5 44 42 Q36 47 28 42 Z M56 42 Q64 36.5 72 42 Q64 47 56 42 Z"/>
      <circle class="iris" cx="36" cy="42" r="2.6"/><circle class="iris" cx="64" cy="42" r="2.6"/>
      <path class="fine" d="M50 46 L46.5 60 Q50 62 53.5 60 M41 73 Q50 78 59 73"/>`,
  },
  // Right forearm, palm up: elbow on the left (the upper arm goes off the edge), hand on the right.
  arm: {
    box: [240, 100],
    labels: "below",
    svg: `
      <path class="fill" d="M-12 23 C10 22.5, 26 21.5, 40 21 C70 19, 100 22, 130 28 C160 33, 185 37, 200 39 C208 36, 220 35, 230 37 C238 39, 240.5 45, 240.5 50 C240.5 56, 238 61, 230 63 C220 65, 208 64, 200 61 C185 63, 160 66, 130 71 C100 76, 70 80, 40 79 C26 79, 10 78.5, -12 78.5 Z"/>
      <path d="M213 63.6 C217 70, 225 74.5, 231.5 72 C235 70.5, 234 66.5, 229 63.4"/>
      <path class="line" d="M-12 23 C10 22.5, 26 21.5, 40 21 C70 19, 100 22, 130 28 C160 33, 185 37, 200 39 C208 36, 220 35, 230 37 C238 39, 240.5 45, 240.5 50 C240.5 56, 238 61, 230 63 C220 65, 208 64, 200 61 C185 63, 160 66, 130 71 C100 76, 70 80, 40 79 C26 79, 10 78.5, -12 78.5"/>
      <path class="fine" d="M228.5 44.5 L239 45.5 M229 50 L240 50 M228.5 55.5 L239 54.5
        M23 33 Q18 50 23 67 M46 33 C76 27, 112 30, 146 39 M199 42 Q203.5 50 199 58"/>`,
  },
};

export interface Drawing {
  el: HTMLElement;
  /** Curve anchors: the SRB1 and BIASOUT legend items, at the drawing's right side. */
  ref: HTMLElement | null;
  bias: HTMLElement | null;
  /** Electrode marks by channel (1–8), for the hover link with the rows. */
  marks: Map<number, HTMLElement[]>;
}

/** Side labels go outward. If another electrode is in the same row on that side (C3 and A1), the label goes above. */
function labelSide(e: Electrode, all: Electrode[]): "left" | "right" | "above" {
  const out = e.x < 0.5 ? "left" : "right";
  const blocked = all.some(
    (o) => o !== e && Math.abs(o.y - e.y) < 0.08 && (out === "left" ? o.x < e.x : o.x > e.x),
  );
  return blocked ? "above" : out;
}

function mark(e: Electrode, labels: Art["labels"], all: Electrode[]): HTMLElement {
  const m = document.createElement("span");
  const kind = e.pin === "BIASOUT" ? "bias" : e.pin === "SRB1" || e.pin.endsWith("N") ? "ring" : "dot";
  const where = labels === "below" ? "below" : labelSide(e, all);
  m.className = `el el-${kind} el-${where}`;
  m.style.left = `${e.x * 100}%`;
  m.style.top = `${e.y * 100}%`;
  m.style.setProperty("--c", electrodeColor(e));
  m.title = `${e.label} → ${e.pin}`;
  m.innerHTML = `<i></i><b>${e.id}</b>`;
  return m;
}

// Room around the art for the electrode labels, in css px.
const ROOM = { side: { x: 26, y: 4 }, below: { x: 8, y: 14 } };

export function drawing(setup: Setup): Drawing {
  const art = ART[setup.body];
  const el = document.createElement("div");
  el.className = `drawing body-${setup.body}`;
  const stage = document.createElement("div");
  stage.className = "body-stage";
  const box = document.createElement("div");
  box.className = "body-box";
  box.innerHTML = `<svg viewBox="0 0 ${art.box[0]} ${art.box[1]}" preserveAspectRatio="none" aria-hidden="true">${art.svg}</svg>`;
  stage.append(box);
  const marks = new Map<number, HTMLElement[]>();
  for (const e of setup.electrodes) {
    const m = mark(e, art.labels, setup.electrodes);
    box.append(m);
    const ch = /^IN(\d)/.exec(e.pin);
    if (ch) {
      const n = Number(ch[1]);
      marks.set(n, [...(marks.get(n) ?? []), m]);
    }
  }

  // Fit the art into the stage at its own aspect ratio.
  const room = ROOM[art.labels];
  const fit = () => {
    const w = stage.clientWidth - 2 * room.x;
    const h = stage.clientHeight - room.y;
    if (w <= 0 || h <= 0) return;
    const k = Math.min(w / art.box[0], h / art.box[1]);
    box.style.width = `${Math.round(art.box[0] * k)}px`;
    box.style.height = `${Math.round(art.box[1] * k)}px`;
  };
  new ResizeObserver(fit).observe(stage);

  const legend = document.createElement("div");
  legend.className = "drawing-legend";
  const item = (cls: string, text: string, title: string) => {
    const s = document.createElement("span");
    s.className = `lg ${cls}`;
    s.title = title;
    s.innerHTML = `<i></i>${text}`;
    legend.append(s);
    return s;
  };
  const refE = setup.electrodes.find((e) => e.pin === "SRB1");
  const biasE = setup.electrodes.find((e) => e.pin === "BIASOUT");
  const ref = refE ? item("lg-ref", `${refE.id} → SRB1`, refE.label) : null;
  const bias = biasE ? item("lg-bias", `${biasE.id} → BIASOUT`, biasE.label) : null;
  el.append(stage, legend);
  return { el, ref, bias, marks };
}
