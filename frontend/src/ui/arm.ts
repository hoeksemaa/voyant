// The EMG arm for the Animation sheet, drawn from points so it can move. Side view, palm up:
// the upper arm lies still on the left; the forearm turns up at the elbow; the hand bends up at
// the wrist and closes into a fist; the flexor belly (the top edge, the palm side) swells.
// One number, c (0 = rest, 0.55 = flex, 1 = hard flex), sets the whole pose.
// Units: the Animation sheet's arm box (240 × 100, as the electrode x and y in setups.ts).

const NS = "http://www.w3.org/2000/svg";
type P = [number, number];

const ELBOW: P = [22, 50]; // the forearm turns about this point
const WRIST: P = [160, 50]; // the hand turns about this point (hand outlines are relative to it)
const LIFT = 13; // degrees the forearm comes up at c = 1
const BEND = 24; // degrees the hand bends up at the wrist at c = 1

// The forearm's edges, elbow to wrist, and the change at c = 1: the flexors swell on top.
const TOP: P[] = [[14, 21.5], [36, 20.6], [60, 19.6], [85, 21.8], [110, 27.6], [132, 33.2], [150, 36.8], [161, 38.6]];
const TOP_FLEX = [0, -1.6, -5.8, -5.4, -2.8, -0.6, 0, 0];
const BOT: P[] = [[161, 61.4], [150, 63.2], [132, 66.6], [110, 71.2], [85, 76], [60, 79.4], [36, 79.6], [14, 79.2]];
const BOT_FLEX = [0, 0, 0.4, 1, 1.4, 1, 0.4, 0];

// The hand, relative to the wrist, as one outline that morphs from open to a fist. The two lists
// match point for point: fingertips → the top of the fist, the finger backs → its knuckles.
const HAND_OPEN: P[] = [
  [-1, -11.4], [14, -11.8], [27, -11], [35, -9.8], [46, -10.2], [56, -12.2], [63.5, -15.2], [68, -18],
  [69.4, -12.6], [62.5, -6.2], [50.5, -1.4], [39, 4.8], [24, 10.4], [-1, 11.4],
];
const HAND_FIST: P[] = [
  [-1, -11.4], [9, -12.6], [14, -16.5], [15.5, -23], [22, -27.4], [33, -27.8], [41, -23.4], [44.6, -14.5],
  [44.8, -4.5], [42.5, 4.2], [38, 9.4], [26, 11.6], [13, 11.8], [-1, 11.4],
];
// The thumb, on the near side, over the hand: forward and up when open, across the fist when closed.
const THUMB_OPEN: P[] = [[4, -5], [8, -10.4], [18, -13.8], [30, -15.6], [37, -14.8], [36.4, -11.2], [27, -10], [14, -7.2]];
const THUMB_FIST: P[] = [[4, -5], [8, -12], [18, -18.2], [30, -21.6], [40, -20.4], [41, -16], [30, -15.4], [15, -9.6]];
// Lines inside the hand: the finger gaps (open) and the knuckle creases (fist).
const GAPS = "M37.5 -6 C46 -6.2, 55 -8.4, 63 -12.6 M39 -1.6 C47.5 -2, 55.5 -4.4, 62.5 -8.4";
const KNUCKLES = "M41.6 -19.5 Q37.5 -17 39.4 -12.6 M43.6 -9.6 Q39.4 -7 41.2 -2.6";

const f = (v: number) => v.toFixed(2);
const mix = (a: P[], b: P[], k: number): P[] => a.map(([x, y], i) => [x + (b[i][0] - x) * k, y + (b[i][1] - y) * k]);
const at = (o: P, pts: P[]): P[] => pts.map(([x, y]) => [o[0] + x, o[1] + y]);
// Ease in and out, so the fist closes late in the move and opens early.
const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

/** A smooth curve through points (Catmull-Rom, as cubic Béziers). */
function curve(pts: P[], closed: boolean): string {
  const n = pts.length;
  const pt = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [p0, p1, p2, p3] = [pt(i - 1), pt(i), pt(i + 1), pt(i + 2)];
    const c1: P = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: P = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return closed ? `${d} Z` : d;
}

const make = <K extends keyof SVGElementTagNameMap>(tag: K, cls: string, parent: Element): SVGElementTagNameMap[K] => {
  const x = document.createElementNS(NS, tag);
  x.setAttribute("class", cls);
  parent.append(x);
  return x;
};

export class ArmArt {
  /** The forearm group: the electrode marks go in it, so they ride the forearm. */
  readonly forearm: SVGGElement;
  /** The forearm's angle now (deg, − = up), so labels can stay level. */
  angle = 0;
  private skin: SVGPathElement;
  private top: SVGPathElement;
  private bot: SVGPathElement;
  private belly: SVGEllipseElement;
  private tendons: SVGPathElement;
  private hand: SVGGElement;
  private handSkin: SVGPathElement;
  private thumb: SVGPathElement;
  private gaps: SVGPathElement;
  private knuckles: SVGPathElement;

  constructor(svg: SVGSVGElement) {
    svg.insertAdjacentHTML(
      "beforeend",
      `<defs><radialGradient id="musc" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#f56200" stop-opacity="0.85"/><stop offset="1" stop-color="#f56200" stop-opacity="0"/>
      </radialGradient></defs>`,
    );
    // The upper arm lies still. Its top runs on under the forearm; under the joint, the point of
    // the elbow shows when the forearm comes up.
    const upper = "M-30 22.6 L26 22.6 L30 79.6 C24 84, 14 84.6, 4 82.4 C-4 80.6, -16 79.6, -30 79.6 Z";
    make("path", "skin", svg).setAttribute("d", upper);
    make("path", "line", svg).setAttribute("d", "M-30 22.6 L22 22.6 M30 79.6 C24 84, 14 84.6, 4 82.4 C-4 80.6, -16 79.6, -30 79.6");
    this.forearm = make("g", "forearm", svg);
    this.skin = make("path", "skin", this.forearm);
    this.belly = make("ellipse", "belly", this.forearm);
    this.belly.setAttribute("fill", "url(#musc)");
    this.top = make("path", "line", this.forearm);
    this.bot = make("path", "line", this.forearm);
    make("path", "fine", this.forearm).setAttribute("d", "M26 32 Q21 50 26 68"); // the elbow crease
    this.tendons = make("path", "fine tendons", this.forearm);
    this.tendons.setAttribute("d", "M118 40 C132 42, 146 43.6, 157 44.6 M122 47.4 C135 48.2, 147 48.8, 157 49.2");
    this.hand = make("g", "hand", this.forearm);
    this.handSkin = make("path", "seg", this.hand);
    this.gaps = make("path", "fine", this.hand);
    this.gaps.setAttribute("d", GAPS);
    this.knuckles = make("path", "fine", this.hand);
    this.knuckles.setAttribute("d", KNUCKLES);
    this.thumb = make("path", "seg", this.hand);
    make("path", "fine", this.forearm).setAttribute("d", "M158.5 42 Q163 50 158.5 58"); // the wrist crease
    this.gaps.setAttribute("transform", `translate(${WRIST[0]} ${WRIST[1]})`);
    this.knuckles.setAttribute("transform", `translate(${WRIST[0]} ${WRIST[1]})`);
  }

  /** c: 0 = rest, 0.55 = flex, 1 = hard flex. shake: degrees of tremor now. */
  pose(c: number, shake: number): void {
    const top = TOP.map(([x, y], i): P => [x, y + TOP_FLEX[i] * c]);
    const bot = BOT.map(([x, y], i): P => [x, y + BOT_FLEX[i] * c]);
    this.skin.setAttribute("d", curve([...top, ...bot], true));
    this.top.setAttribute("d", curve(top, false));
    this.bot.setAttribute("d", curve(bot, false));
    this.belly.setAttribute("cx", "72");
    this.belly.setAttribute("cy", f(45 - 3 * c));
    this.belly.setAttribute("rx", "46");
    this.belly.setAttribute("ry", f(18 + 4 * c));
    this.belly.style.opacity = (0.04 + 0.5 * c).toFixed(3);
    this.tendons.style.opacity = (0.12 + 0.88 * c).toFixed(2);

    this.angle = -LIFT * c + shake;
    this.forearm.setAttribute("transform", `rotate(${f(this.angle)} ${ELBOW[0]} ${ELBOW[1]})`);
    this.hand.setAttribute("transform", `rotate(${f(-BEND * c + 1.5 * shake)} ${WRIST[0]} ${WRIST[1]})`);

    // The fist is closed by "flex"; a hard flex only squeezes it.
    const k = ease(c / 0.55);
    this.handSkin.setAttribute("d", curve(at(WRIST, mix(HAND_OPEN, HAND_FIST, k)), true));
    this.thumb.setAttribute("d", curve(at(WRIST, mix(THUMB_OPEN, THUMB_FIST, k)), true));
    this.gaps.style.opacity = (0.9 * (1 - k)).toFixed(2);
    this.knuckles.style.opacity = (0.9 * k).toFixed(2);
  }
}
