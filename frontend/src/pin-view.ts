import * as THREE from "three";
import { PKG } from "./package-dims";
import { HALF, TOP_HALF, TOP_Y, pinNear, pinPoint } from "./pin-layout";
import { GROUPS, PINS, type Pin } from "./pins";

// Pin view: a colored dot on the top face at each pin, leads tinted by group, and pin
// names on the board outside the leads, laid out like the datasheet's Top View drawing.
// Click a pin for its datasheet description.

const DOT_D = TOP_HALF - 0.28; // dot center, mm out from the package center
const DOT_R = 0.11;
const LABEL_D0 = HALF + (PKG.leadSpan - PKG.bodySize) / 2 + 0.12; // labels start just past the lead tips
const LABEL_D1 = LABEL_D0 + 2.1;
const LABEL_SPAN = (PKG.pinsPerSide / 2) * PKG.pitch; // half-length of a row of labels

const FONT = "Inter, system-ui, sans-serif";

// A flat transparent canvas in the XZ plane. Canvas x follows world +X and canvas y follows
// world +Z, so the canvas reads like the datasheet's top view.
class TopCanvas {
  readonly canvas = document.createElement("canvas");
  readonly ctx: CanvasRenderingContext2D;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(
    private x0: number,
    private z0: number,
    w: number,
    h: number,
    y: number,
    readonly px: number, // canvas pixels per mm
    anisotropy: number,
  ) {
    this.canvas.width = Math.round(w * px);
    this.canvas.height = Math.round(h * px);
    this.ctx = this.canvas.getContext("2d")!;
    const tex = new THREE.CanvasTexture(this.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x0 + w / 2, y, z0 + h / 2);
  }

  at(p: THREE.Vector3): [number, number] {
    return [(p.x - this.x0) * this.px, (p.z - this.z0) * this.px];
  }

  done(): void {
    this.mesh.material.map!.needsUpdate = true;
  }
}

function drawDots(face: TopCanvas): void {
  const { ctx, px } = face;
  for (const pin of PINS) {
    const [x, y] = face.at(pinPoint(pin.no, DOT_D));
    ctx.fillStyle = GROUPS[pin.group].color;
    ctx.beginPath();
    ctx.arc(x, y, DOT_R * px, 0, Math.PI * 2);
    ctx.fill();
  }
  face.done();
}

// One row of labels: the 16 pins of one side.
function drawLabels(strip: TopCanvas, side: number): void {
  const { ctx, px } = strip;
  const nameFont = `600 ${0.28 * px}px ${FONT}`;
  const numberFont = `500 ${0.2 * px}px ${FONT}`;
  ctx.font = numberFont;
  const numberWidth = ctx.measureText("64").width;
  const gap = 0.12 * px;
  // Text reads left to right on the ±X sides and bottom to top on the ±Z sides, so it is
  // upright from the front. The pin number sits next to the lead tip, then the name.
  const outward = side === 1 || side === 2; // reading direction points away from the chip
  for (const pin of PINS.slice(side * PKG.pinsPerSide, (side + 1) * PKG.pinsPerSide)) {
    const [x, y] = strip.at(pinPoint(pin.no, LABEL_D0));
    ctx.save();
    ctx.translate(x, y);
    if (side % 2 === 0) ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.textAlign = outward ? "left" : "right";
    ctx.font = numberFont;
    ctx.fillStyle = "#8a919b";
    ctx.fillText(String(pin.no), 0, 0);
    ctx.font = nameFont;
    ctx.fillStyle = GROUPS[pin.group].color;
    ctx.fillText(pin.name, outward ? numberWidth + gap : -(numberWidth + gap), 0);
    ctx.restore();
  }
  strip.done();
}

// The canvas for one side's labels, in world coordinates. It starts at the lead tips,
// so a click between a lead and its label still lands on the pin.
function labelStrip(side: number, anisotropy: number): TopCanvas {
  const d0 = HALF + (PKG.leadSpan - PKG.bodySize) / 2;
  const len = 2 * LABEL_SPAN;
  const depth = LABEL_D1 - d0;
  const px = 256;
  const y = 0.002;
  switch (side) {
    case 0: return new TopCanvas(-LABEL_SPAN, d0, len, depth, y, px, anisotropy);
    case 1: return new TopCanvas(d0, -LABEL_SPAN, depth, len, y, px, anisotropy);
    case 2: return new TopCanvas(-LABEL_SPAN, -LABEL_D1, len, depth, y, px, anisotropy);
    default: return new TopCanvas(-LABEL_D1, -LABEL_SPAN, depth, len, y, px, anisotropy);
  }
}

function ring(inner: number, outer: number, opacity: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(inner, outer, 40);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}

export interface PinViewOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  leads: THREE.InstancedMesh;
  maxAnisotropy: number;
  requestRender: () => void;
  onToggle: (on: boolean) => void;
}

export class PinView {
  private on = false;
  private fade = 0; // 0 = hidden, 1 = shown
  private hovered: number | null = null;
  private selected: number | null = null;
  private face: TopCanvas;
  private strips: TopCanvas[];
  private layers: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  private hoverRing = ring(DOT_R * 1.6, DOT_R * 2.1, 0.45);
  private selectRing = ring(DOT_R * 1.6, DOT_R * 2.4, 1);
  private tints = PINS.map((p) => new THREE.Color(GROUPS[p.group].color));
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private down: { x: number; y: number } | null = null;
  private card = document.createElement("aside");
  private legend = document.createElement("ul");
  private button: HTMLButtonElement | null = null;

  constructor(private opts: PinViewOptions) {
    this.face = new TopCanvas(-HALF, -HALF, PKG.bodySize, PKG.bodySize, TOP_Y + 0.002, 204.8, opts.maxAnisotropy);
    this.strips = [0, 1, 2, 3].map((side) => labelStrip(side, opts.maxAnisotropy));
    this.layers = [this.face, ...this.strips].map((c) => c.mesh);
    for (const m of this.layers) {
      m.material.opacity = 0;
      m.visible = false;
    }
    this.hoverRing.position.y = this.selectRing.position.y = TOP_Y + 0.004;
    opts.scene.add(...this.layers, this.hoverRing, this.selectRing);

    // Draw once the web font is ready, so the canvases use Inter.
    document.fonts.load(`600 40px Inter`).finally(() => {
      drawDots(this.face);
      this.strips.forEach((strip, side) => drawLabels(strip, side));
      opts.requestRender();
    });

    this.buildDom();
    const c = opts.canvas;
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointerleave", () => this.setHovered(null));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.select(null);
      if (e.key === "p" && !e.metaKey && !e.ctrlKey) this.toggle();
    });
  }

  private buildDom(): void {
    this.card.className = "pin-card";
    this.card.hidden = true;
    this.legend.className = "pin-legend";
    for (const g of Object.values(GROUPS)) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch" style="background:${g.color}"></span>${g.label}`;
      this.legend.append(li);
    }
    document.body.append(this.legend, this.card);
    this.button = document.querySelector<HTMLButtonElement>("#pins-toggle");
    this.button?.addEventListener("click", () => this.toggle());
  }

  toggle(): void {
    this.on = !this.on;
    this.button?.setAttribute("aria-pressed", String(this.on));
    document.body.classList.toggle("pins-on", this.on);
    if (!this.on) this.select(null);
    this.setHovered(null);
    this.opts.onToggle(this.on);
    this.opts.requestRender();
  }

  // Advance the fade. Returns true while it still needs frames.
  tick(dt: number): boolean {
    const target = this.on ? 1 : 0;
    if (this.fade === target) return false;
    const step = dt / 0.25;
    this.fade = target > this.fade ? Math.min(1, this.fade + step) : Math.max(0, this.fade - step);
    for (const m of this.layers) {
      m.material.opacity = this.fade;
      m.visible = this.fade > 0;
    }
    this.paintLeads();
    return this.fade !== target;
  }

  private paintLeads(): void {
    const c = new THREE.Color();
    const leads = this.opts.leads;
    for (let i = 0; i < PINS.length; i++) {
      c.setRGB(1, 1, 1).lerp(this.tints[i], 0.8 * this.fade);
      const no = i + 1;
      if (no === this.selected) c.multiplyScalar(1.9);
      else if (no === this.hovered) c.multiplyScalar(1.5);
      leads.setColorAt(i, c);
    }
    leads.instanceColor!.needsUpdate = true;
  }

  private pick(e: PointerEvent): number | null {
    const rect = this.opts.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.opts.camera);
    const hits = this.raycaster.intersectObjects([this.opts.leads, ...this.layers], false);
    for (const hit of hits) {
      if (hit.object === this.opts.leads && hit.instanceId !== undefined) return hit.instanceId + 1;
      const { x, z } = hit.point;
      // On the top face, only the band of dots along the edge counts.
      if (hit.object === this.face.mesh && Math.max(Math.abs(x), Math.abs(z)) < DOT_D - 0.4) return null;
      return pinNear(x, z);
    }
    return null;
  }

  private onMove(e: PointerEvent): void {
    if (!this.on || e.buttons) return;
    this.setHovered(this.pick(e));
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    this.down = null;
    if (!this.on || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const no = this.pick(e);
    this.select(no === this.selected ? null : no);
  }

  private setHovered(no: number | null): void {
    if (no === this.hovered) return;
    this.hovered = no;
    this.opts.canvas.style.cursor = no ? "pointer" : "";
    this.placeRing(this.hoverRing, no !== this.selected ? no : null);
    this.paintLeads();
    this.opts.requestRender();
  }

  private select(no: number | null): void {
    this.selected = no;
    this.placeRing(this.selectRing, no);
    this.placeRing(this.hoverRing, this.hovered !== no ? this.hovered : null);
    this.paintLeads();
    this.showCard(no ? PINS[no - 1] : null);
    this.opts.requestRender();
  }

  private placeRing(mesh: THREE.Mesh, no: number | null): void {
    mesh.visible = no !== null;
    if (no !== null) {
      const p = pinPoint(no, DOT_D);
      mesh.position.set(p.x, mesh.position.y, p.z);
    }
  }

  private showCard(pin: Pin | null): void {
    this.card.hidden = !pin;
    if (!pin) return;
    const g = GROUPS[pin.group];
    this.card.innerHTML = `
      <p class="pin-card-title"><span class="swatch" style="background:${g.color}"></span>
        <b>${pin.name}</b><span class="pin-card-no">Pin ${pin.no}</span></p>
      <p class="pin-card-desc">${pin.description}</p>
      <p class="pin-card-meta">${pin.type} · ${g.label}</p>`;
  }
}
