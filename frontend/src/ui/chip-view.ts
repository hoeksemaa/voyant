import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "../chip";
import { PKG } from "../package-dims";
import { HALF, pinPoint } from "../pin-layout";
import { PinView } from "../pin-view";

// One 3D ADS1299 in a box on the page. The canvas fills its container. The home screen, the
// level, and the pin sheet each have one. Each renders only when something changes.

const deg = THREE.MathUtils.degToRad;

/** Middle of a lead's foot, and a point 4 mm further out along the same pin line. */
const FOOT = HALF + (PKG.leadSpan - PKG.bodySize) / 2 - 0.25;
const FOOT_Y = PKG.leadThickness / 2;

export interface ChipViewOptions {
  azimuth: number; // degrees around the chip; 0 = camera on the pin 1–16 side (lettering upright)
  polar: number; // degrees from straight down
  fit: { width: number; height: number }; // mm of chip that must fit the box
  /** Drag to swivel, inside these limits (degrees). None: the chip does not move. */
  swivel?: { azimuth: [number, number]; polar: [number, number] };
  /** A slow sway while nobody drags (home screen). */
  sway?: boolean;
  /** Pin labels and the pin card (the pin sheet). */
  pins?: boolean;
}

export interface Pt {
  x: number; // css px from the container's left
  y: number;
  ox: number; // unit direction on screen, outward along the pin
  oy: number;
  behind: boolean; // the chip body hides the pin
}

export class ChipView {
  readonly canvas: HTMLCanvasElement;
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 1, 0.5, 400);
  private controls: OrbitControls | null = null;
  private pinView: PinView | null = null;
  private body: THREE.Object3D;
  private queued = false;
  private last = 0;
  private idle = 0; // seconds since the last drag (sway)
  private dragging = false;
  private swayT = 0;
  private listeners: (() => void)[] = [];
  private raycaster = new THREE.Raycaster();
  private v = new THREE.Vector3();
  private alive = true;
  private ro: ResizeObserver;

  constructor(
    private box: HTMLElement,
    private opts: ChipViewOptions,
  ) {
    const { renderer, scene, camera } = this;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = renderer.domElement;
    this.canvas.className = "chip-canvas";
    box.append(this.canvas);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.9;
    scene.environmentRotation.set(0, Math.PI / 5, 0);
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-8, 16, 10);
    scene.add(key);

    const max = renderer.capabilities.getMaxAnisotropy();
    const chip = buildChip(max);
    scene.add(chip.group);
    this.body = chip.body;

    const target = new THREE.Vector3(0, 0.55, 0);
    camera.position.setFromSpherical(new THREE.Spherical(40, deg(opts.polar), deg(opts.azimuth))).add(target);
    camera.lookAt(target);

    if (opts.swivel || opts.pins) {
      const c = (this.controls = new OrbitControls(camera, this.canvas));
      c.target.copy(target);
      c.enablePan = false;
      c.enableZoom = !!opts.pins;
      c.enableDamping = true;
      c.dampingFactor = 0.09;
      c.rotateSpeed = 0.7;
      if (opts.swivel) {
        c.minAzimuthAngle = deg(opts.swivel.azimuth[0]);
        c.maxAzimuthAngle = deg(opts.swivel.azimuth[1]);
        c.minPolarAngle = deg(opts.swivel.polar[0]);
        c.maxPolarAngle = deg(opts.swivel.polar[1]);
      }
      c.addEventListener("start", () => (this.dragging = true));
      c.addEventListener("end", () => {
        this.dragging = false;
        this.idle = 0;
      });
      c.addEventListener("change", () => this.requestRender());
    } else {
      this.canvas.style.pointerEvents = "none";
    }

    if (opts.pins) {
      this.pinView = new PinView({
        scene,
        camera,
        canvas: this.canvas,
        leads: chip.leads,
        maxAnisotropy: max,
        requestRender: () => this.requestRender(),
      });
    }

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(box);
    this.resize();
  }

  /** Called after each frame: overlays (wires, curves) follow the chip. */
  onFrame(fn: () => void): void {
    this.listeners.push(fn);
  }

  setPins(on: boolean): void {
    this.pinView?.setOn(on);
  }

  /** Tint some leads (the pins in use). */
  setLit(pins: Map<number, string>): void {
    this.pinView?.setHighlight(pins);
  }

  /** A pin's foot on screen, in container px, with its outward direction. */
  pin(no: number): Pt {
    const foot = pinPoint(no, FOOT, FOOT_Y);
    const out = pinPoint(no, FOOT + 4, FOOT_Y);
    const [x, y] = this.toBox(foot);
    const [qx, qy] = this.toBox(out);
    const len = Math.hypot(qx - x, qy - y) || 1;
    return { x, y, ox: (qx - x) / len, oy: (qy - y) / len, behind: this.hidden(foot) };
  }

  /** The chip's center on screen, in container px. */
  center(): { x: number; y: number } {
    const [x, y] = this.toBox(new THREE.Vector3(0, 0.6, 0));
    return { x, y };
  }

  private toBox(p: THREE.Vector3): [number, number] {
    this.v.copy(p).project(this.camera);
    return [((this.v.x + 1) / 2) * this.box.clientWidth, ((1 - this.v.y) / 2) * this.box.clientHeight];
  }

  private hidden(p: THREE.Vector3): boolean {
    const dir = this.v.copy(p).sub(this.camera.position);
    const dist = dir.length();
    this.raycaster.set(this.camera.position, dir.normalize());
    const hit = this.raycaster.intersectObject(this.body, false)[0];
    return !!hit && hit.distance < dist - 0.05;
  }

  private fitDistance(): number {
    const span = 2 * Math.tan(deg(this.camera.fov / 2));
    const w = Math.max(60, this.box.clientWidth);
    const h = Math.max(60, this.box.clientHeight);
    const { width, height } = this.opts.fit;
    return (h / span) * Math.max(height / h, width / w);
  }

  requestRender(): void {
    if (this.queued || !this.alive) return;
    this.queued = true;
    requestAnimationFrame((now) => {
      this.queued = false;
      if (!this.alive) return;
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
      let more = false;
      if (this.pinView) more = this.pinView.tick(dt) || more;
      if (this.opts.sway && this.controls && !this.dragging) more = this.sway(dt) || more;
      if (this.controls) this.controls.update();
      this.camera.updateMatrixWorld();
      this.renderer.render(this.scene, this.camera);
      for (const fn of this.listeners) fn();
      this.last = more ? now : 0;
      if (more) this.requestRender();
    });
  }

  // A slow figure-eight around the start angle, which fades in after a drag ends.
  private sway(dt: number): boolean {
    if (!this.box.offsetParent) return false;
    this.idle += dt;
    this.swayT += dt;
    const k = Math.min(1, Math.max(0, (this.idle - 1.2) / 2.5)) * 0.02;
    if (k === 0) return true;
    const c = this.controls!;
    const s = new THREE.Spherical().setFromVector3(this.v.copy(this.camera.position).sub(c.target));
    const az = deg(this.opts.azimuth + 14 * Math.sin(this.swayT * 0.35));
    const po = deg(this.opts.polar + 5 * Math.sin(this.swayT * 0.23));
    s.theta += (az - s.theta) * k;
    s.phi += (po - s.phi) * k;
    this.camera.position.copy(c.target).add(this.v.setFromSpherical(s));
    return true;
  }

  /** Start the sway loop (home screen shown). */
  wake(): void {
    this.requestRender();
  }

  resize(): void {
    const w = this.box.clientWidth;
    const h = this.box.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const target = this.controls?.target ?? new THREE.Vector3(0, 0.55, 0);
    const dir = this.camera.position.clone().sub(target).normalize();
    this.camera.position.copy(target).addScaledVector(dir, this.fitDistance());
    if (this.controls) {
      this.controls.minDistance = this.fitDistance() * 0.45;
      this.controls.maxDistance = this.fitDistance() * 1.6;
    }
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  dispose(): void {
    this.alive = false;
    this.ro.disconnect();
    this.controls?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
