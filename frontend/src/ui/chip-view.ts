import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "../chip";
import { PKG } from "../package-dims";
import { HALF, pinPoint } from "../pin-layout";
import { PinView } from "../pin-view";

// One 3D ADS1299 in a box on the page. The canvas fills its container. The home screen, the
// level, and the pin sheet each have one. Each renders only when something changes, except the
// home chip, which turns slowly while nobody drags it.

const deg = THREE.MathUtils.degToRad;

/** Middle of a lead's foot, and a point 4 mm further out along the same pin line. */
const FOOT = HALF + (PKG.leadSpan - PKG.bodySize) / 2 - 0.25;
const FOOT_Y = PKG.leadThickness / 2;

export interface ChipViewOptions {
  azimuth: number; // degrees around the chip; 0 = camera on the pin 1–16 side (lettering upright)
  polar: number; // degrees from straight down
  fit: { width: number; height: number }; // mm of chip that must fit the box
  /** Drag to turn the chip itself in any direction (home screen). With drift, it keeps
   *  turning slowly about the vertical axis while nobody drags it. */
  spin?: { drift: boolean };
  /** Pin labels and the pin card (the pin sheet). Drag to orbit, pinch to zoom. */
  pins?: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const DRIFT = 0.15; // rad/s, the idle turn

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
  private chipGroup: THREE.Object3D;
  private pivot = new THREE.Group(); // turns about the chip's center (spin)
  private queued = false;
  private last = 0;
  private idle = 0; // seconds since the last drag
  private dragging = false;
  private drag: { id: number; x: number; y: number; t: number } | null = null;
  private omega = new THREE.Vector3(); // spin: angular velocity in world space, rad/s
  private q = new THREE.Quaternion();
  private axis = new THREE.Vector3();
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
    const target = new THREE.Vector3(0, 0.55, 0);
    // The chip hangs in a pivot at its center, so a spin turns it in place.
    this.pivot.position.copy(target);
    chip.group.position.sub(target);
    this.pivot.add(chip.group);
    scene.add(this.pivot);
    this.body = chip.body;
    this.chipGroup = chip.group;

    camera.position.setFromSpherical(new THREE.Spherical(40, deg(opts.polar), deg(opts.azimuth))).add(target);
    camera.lookAt(target);

    if (opts.spin) {
      this.bindSpin();
    } else if (opts.pins) {
      const c = (this.controls = new OrbitControls(camera, this.canvas));
      c.target.copy(target);
      c.enablePan = false;
      c.enableZoom = true;
      c.enableDamping = true;
      c.dampingFactor = 0.09;
      c.rotateSpeed = 0.7;
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
    this.chipGroup.updateWorldMatrix(true, false);
    const m = this.chipGroup.matrixWorld;
    const foot = pinPoint(no, FOOT, FOOT_Y).applyMatrix4(m);
    const out = pinPoint(no, FOOT + 4, FOOT_Y).applyMatrix4(m);
    const [x, y] = this.toBox(foot);
    const [qx, qy] = this.toBox(out);
    const len = Math.hypot(qx - x, qy - y) || 1;
    return { x, y, ox: (qx - x) / len, oy: (qy - y) / len, behind: this.hidden(foot) };
  }

  /** The chip's center on screen, in container px. */
  center(): { x: number; y: number } {
    this.chipGroup.updateWorldMatrix(true, false);
    const [x, y] = this.toBox(new THREE.Vector3(0, 0.6, 0).applyMatrix4(this.chipGroup.matrixWorld));
    return { x, y };
  }

  /**
   * Project points given in the chip's own frame (mm, as in pin-layout) to container px.
   * Call it after a frame (onFrame), when the chip's matrix is current.
   */
  project(local: THREE.Vector3, out: { x: number; y: number }): void {
    this.v.copy(local).applyMatrix4(this.chipGroup.matrixWorld).project(this.camera);
    out.x = ((this.v.x + 1) / 2) * this.box.clientWidth;
    out.y = ((1 - this.v.y) / 2) * this.box.clientHeight;
  }

  private toBox(p: THREE.Vector3): [number, number] {
    this.v.copy(p).project(this.camera);
    return [((this.v.x + 1) / 2) * this.box.clientWidth, ((1 - this.v.y) / 2) * this.box.clientHeight];
  }

  // ---- spin: drag turns the chip about an axis at right angles to the drag ----

  private bindSpin(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (this.drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
      c.setPointerCapture(e.pointerId);
      this.omega.set(0, 0, 0);
      this.dragging = true;
      this.requestRender();
    });
    c.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      const len = Math.hypot(dx, dy);
      if (!len) return;
      const now = performance.now();
      const dt = Math.max(8, now - d.t) / 1000;
      d.x = e.clientX;
      d.y = e.clientY;
      d.t = now;
      // A drag across the smaller side of the box turns the chip about 225 degrees.
      const angle = (len / Math.max(120, Math.min(this.box.clientWidth, this.box.clientHeight))) * Math.PI * 1.25;
      this.axis.set(dy / len, dx / len, 0).applyQuaternion(this.camera.quaternion);
      this.turn(this.axis, angle);
      this.omega.lerp(this.axis.multiplyScalar(angle / dt), 0.6);
      this.requestRender();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      // A finger that stops before it lifts leaves the chip still.
      if (performance.now() - d.t > 90 || matchMedia("(prefers-reduced-motion: reduce)").matches) this.omega.set(0, 0, 0);
      if (this.omega.length() > 12) this.omega.setLength(12);
      this.drag = null;
      this.dragging = false;
      this.idle = 0;
      this.requestRender();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  private turn(axis: THREE.Vector3, angle: number): void {
    this.q.setFromAxisAngle(axis, angle);
    this.pivot.quaternion.premultiply(this.q).normalize();
  }

  // Inertia after a flick, then (with drift) a slow turn that fades in. True: draw again.
  private spinStep(dt: number): boolean {
    if (!this.box.offsetParent) return false;
    if (this.dragging) return true;
    const w = this.omega.length();
    if (w > 0.02) {
      this.turn(this.axis.copy(this.omega).divideScalar(w), w * dt);
      this.omega.multiplyScalar(Math.exp(-dt * 2.4));
    } else this.omega.set(0, 0, 0);
    if (!this.opts.spin!.drift) return w > 0.02;
    this.idle += dt;
    const k = Math.min(1, Math.max(0, (this.idle - 1) / 2.5));
    if (k > 0) this.turn(UP, k * DRIFT * dt);
    return true;
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
      if (this.opts.spin) more = this.spinStep(dt) || more;
      if (this.controls) this.controls.update();
      this.camera.updateMatrixWorld();
      this.renderer.render(this.scene, this.camera);
      for (const fn of this.listeners) fn();
      this.last = more ? now : 0;
      if (more) this.requestRender();
    });
  }

  /** Start the render loop again (home screen shown). */
  wake(): void {
    this.last = 0;
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
