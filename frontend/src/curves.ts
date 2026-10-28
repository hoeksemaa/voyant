import * as THREE from "three";
import { PKG } from "./package-dims";
import { HALF, pinPoint } from "./pin-layout";
import type { Link } from "./scopes";

// Smooth curves from each scope lane to the pins it measures. Dashes flow toward the chip
// on inputs and away from it on outputs while that signal changes in the current step.

const NS = "http://www.w3.org/2000/svg";
const FOOT = HALF + (PKG.leadSpan - PKG.bodySize) / 2 - 0.25; // middle of the lead's foot
const FOOT_Y = PKG.leadThickness / 2;

interface Curve {
  link: Link;
  base: SVGPathElement;
  flow: SVGPathElement;
  foot: THREE.Vector3;
  out: THREE.Vector3;
  spread: number; // small vertical offset, so curves from one lane fan out
}

export class Curves {
  private svg = document.createElementNS(NS, "svg");
  private curves: Curve[] = [];
  private raycaster = new THREE.Raycaster();
  private v = new THREE.Vector3();

  constructor(links: Link[], private occluder: THREE.Object3D) {
    this.svg.classList.add("curves");
    document.body.append(this.svg);
    const perLane = new Map<HTMLElement, number>();
    for (const link of links) {
      const k = perLane.get(link.el) ?? 0;
      perLane.set(link.el, k + 1);
      const base = document.createElementNS(NS, "path");
      base.setAttribute("class", "curve");
      base.setAttribute("stroke", link.color);
      const flow = document.createElementNS(NS, "path");
      flow.setAttribute("class", `curve-flow flow-${link.side}`);
      flow.setAttribute("stroke", link.color);
      this.svg.append(base, flow);
      this.curves.push({
        link,
        base,
        flow,
        foot: pinPoint(link.pin, FOOT, FOOT_Y),
        out: pinPoint(link.pin, FOOT + 4, FOOT_Y),
        spread: k,
      });
    }
  }

  setVisible(on: boolean): void {
    this.svg.classList.toggle("on", on);
  }

  setPlaying(on: boolean): void {
    this.svg.classList.toggle("paused", !on);
  }

  // Probes whose signal changes during the current step.
  setActive(active: Set<string>): void {
    for (const c of this.curves) {
      const on = active.has(c.link.probe);
      c.base.classList.toggle("active", on);
      c.flow.classList.toggle("active", on);
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

  update(camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (!this.svg.classList.contains("on")) return;
    const rect = canvas.getBoundingClientRect();
    this.svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    const laneRects = new Map<HTMLElement, DOMRect>();
    const narrow = window.innerWidth <= 900; // scopes sit below the chip instead of beside it
    for (const c of this.curves) {
      let r = laneRects.get(c.link.el);
      if (!r) laneRects.set(c.link.el, (r = c.link.el.getBoundingClientRect()));
      const s = c.link.side === "in" ? 1 : -1;
      const ax = narrow ? r.left + r.width / 2 + (c.spread - 1) * 3 : c.link.side === "in" ? r.right : r.left;
      const ay = narrow ? r.top : r.top + r.height / 2 + (c.spread - 1) * 3;
      const [px, py] = this.toScreen(c.foot, camera, rect);
      const [qx, qy] = this.toScreen(c.out, camera, rect);
      // Arrive at the pin from outside the package, along the pin's own direction.
      const len = Math.hypot(qx - px, qy - py) || 1;
      const reach = Math.max(40, Math.hypot(px - ax, py - ay) * 0.3);
      const ox = px + ((qx - px) / len) * reach;
      const oy = py + ((qy - py) / len) * reach;
      const k = Math.max(50, Math.abs((narrow ? py - ay : px - ax)) * 0.35);
      const [c1x, c1y] = narrow ? [ax, ay - k] : [ax + s * k, ay];
      const d = `M${ax.toFixed(1)},${ay.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${ox.toFixed(1)},${oy.toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}`;
      c.base.setAttribute("d", d);
      c.flow.setAttribute("d", d);
      const behind = this.hidden(c.foot, camera);
      c.base.classList.toggle("behind", behind);
      c.flow.classList.toggle("behind", behind);
    }
  }
}
