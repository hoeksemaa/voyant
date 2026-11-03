import * as THREE from "three";
import { PKG } from "./package-dims";
import { HALF, TOP_Y, pinPoint } from "./pin-layout";

// Smooth curves between the page and the chip's pins. An "in" curve leaves the right edge of
// its element (an analog row, or the SRB1 or BIASOUT mark) and arrives at the pin from
// outside the package. An "out" curve leaves the pin and ends at the left edge of its element.
// Dashes flow toward the chip on inputs and away from it on outputs. A curve that would cross
// the chip goes around it, above or below, whichever is shorter.

const NS = "http://www.w3.org/2000/svg";
const FOOT = HALF + (PKG.leadSpan - PKG.bodySize) / 2 - 0.25; // middle of the lead's foot
const FOOT_Y = PKG.leadThickness / 2;

export interface Link {
  el: HTMLElement;
  side: "in" | "out";
  pin: number; // 1–64
  color: string;
  key: number | string; // channel number, or "ref", "bias", "dout"; the hover link uses it
  spread: number; // px offset at the element, so two curves from one row fan out
  y?: number; // where on the element's edge the curve starts, 0 = top, 1 = bottom (default 0.5)
}

type P2 = [number, number];

// The chip's outline on screen for the crossing test: the body, a little larger, at mid-height.
const OUTLINE = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
].map(([x, z]) => new THREE.Vector3(x * (HALF + 0.8), TOP_Y / 2, z * (HALF + 0.8)));

function inside(poly: P2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const c = Math.sign((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0));
    if (c === 0) continue;
    if (sign === 0) sign = c;
    else if (c !== sign) return false;
  }
  return true;
}

const f = (v: number) => v.toFixed(1);

interface Curve {
  link: Link;
  base: SVGPathElement;
  flow: SVGPathElement;
  foot: THREE.Vector3;
  out: THREE.Vector3;
}

export class Curves {
  private svg = document.createElementNS(NS, "svg");
  private curves: Curve[] = [];
  private raycaster = new THREE.Raycaster();
  private v = new THREE.Vector3();

  constructor(private occluder: THREE.Object3D) {
    this.svg.classList.add("curves");
    this.svg.setAttribute("aria-hidden", "true");
    document.body.append(this.svg);
  }

  setLinks(links: Link[]): void {
    this.svg.replaceChildren();
    this.curves = links.map((link) => {
      const base = document.createElementNS(NS, "path");
      base.setAttribute("class", "curve");
      base.setAttribute("stroke", link.color);
      const flow = document.createElementNS(NS, "path");
      flow.setAttribute("class", `curve-flow flow-${link.side}`);
      flow.setAttribute("stroke", link.color);
      this.svg.append(base, flow);
      return { link, base, flow, foot: pinPoint(link.pin, FOOT, FOOT_Y), out: pinPoint(link.pin, FOOT + 4, FOOT_Y) };
    });
  }

  setVisible(on: boolean): void {
    this.svg.classList.toggle("on", on);
  }

  /** Make the curves of one channel (or "ref", "bias", "dout") stand out. */
  setHot(key: number | string | null): void {
    this.svg.classList.toggle("has-hot", key !== null);
    for (const c of this.curves) {
      const hot = c.link.key === key;
      c.base.classList.toggle("hot", hot);
      c.flow.classList.toggle("hot", hot);
    }
  }

  private toScreen(p: THREE.Vector3, camera: THREE.Camera, rect: DOMRect): [number, number] {
    this.v.copy(p).project(camera);
    return [rect.left + ((this.v.x + 1) / 2) * rect.width, rect.top + ((1 - this.v.y) / 2) * rect.height];
  }

  private hidden(p: THREE.Vector3, camera: THREE.Camera): boolean {
    const dir = this.v.copy(p).sub(camera.position);
    const dist = dir.length();
    this.raycaster.set(camera.position, dir.normalize());
    const hit = this.raycaster.intersectObject(this.occluder, false)[0];
    return !!hit && hit.distance < dist - 0.05;
  }

  // True when the straight run from the element to the point outside the pin crosses the chip.
  private crosses(poly: P2[], ax: number, ay: number, ox: number, oy: number): boolean {
    for (let t = 0.1; t < 0.95; t += 0.1) {
      if (inside(poly, ax + (ox - ax) * t, ay + (oy - ay) * t)) return true;
    }
    return false;
  }

  update(camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (!this.svg.classList.contains("on")) return;
    const rect = canvas.getBoundingClientRect();
    this.svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    const rects = new Map<HTMLElement, DOMRect>();
    const poly = OUTLINE.map((p) => this.toScreen(p, camera, rect));
    const top = Math.min(...poly.map((p) => p[1]));
    const bottom = Math.max(...poly.map((p) => p[1]));
    for (const c of this.curves) {
      let r = rects.get(c.link.el);
      if (!r) rects.set(c.link.el, (r = c.link.el.getBoundingClientRect()));
      const s = c.link.side === "in" ? 1 : -1;
      const ax = c.link.side === "in" ? r.right : r.left;
      const ay = r.top + r.height * (c.link.y ?? 0.5) + c.link.spread;
      const [px, py] = this.toScreen(c.foot, camera, rect);
      const [qx, qy] = this.toScreen(c.out, camera, rect);
      // Arrive at the pin from outside the package, along the pin's own direction.
      const len = Math.hypot(qx - px, qy - py) || 1;
      const reach = Math.max(36, Math.hypot(px - ax, py - ay) * 0.3);
      const ox = px + ((qx - px) / len) * reach;
      const oy = py + ((qy - py) / len) * reach;
      let d: string;
      if (this.crosses(poly, ax, ay, ox, oy)) {
        // Go around: through a point under (or over) the chip, halfway across.
        const wx = (ax + ox) / 2;
        const under: P2 = [wx, bottom + 26];
        const over: P2 = [wx, top - 26];
        const cost = (w: P2) => Math.hypot(w[0] - ax, w[1] - ay) + Math.hypot(ox - w[0], oy - w[1]);
        const [, wy] = cost(under) <= cost(over) ? under : over;
        const k1 = Math.max(40, Math.abs(wx - ax) * 0.5);
        const k2 = Math.max(30, Math.abs(ox - wx) * 0.5);
        d = `M${f(ax)},${f(ay)} C${f(ax + s * k1)},${f(ay)} ${f(wx - s * k2)},${f(wy)} ${f(wx)},${f(wy)} C${f(wx + s * k2)},${f(wy)} ${f(ox)},${f(oy)} ${f(px)},${f(py)}`;
      } else {
        const k = Math.max(40, Math.abs(px - ax) * 0.4);
        d = `M${f(ax)},${f(ay)} C${f(ax + s * k)},${f(ay)} ${f(ox)},${f(oy)} ${f(px)},${f(py)}`;
      }
      c.base.setAttribute("d", d);
      c.flow.setAttribute("d", d);
      const behind = this.hidden(c.foot, camera);
      c.base.classList.toggle("behind", behind);
      c.flow.classList.toggle("behind", behind);
    }
  }
}
