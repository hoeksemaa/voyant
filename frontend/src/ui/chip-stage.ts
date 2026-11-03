import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "../chip";
import { Curves, type Link } from "../curves";
import { PinView } from "../pin-view";

// The 3D chip, drag to rotate. The canvas fills the window behind the page; the camera frames
// the chip into a box (the center column, or the whole board in the pin view).

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// A framing: camera angles, and the box of chip (millimeters) that must fit the region.
interface View {
  polar: number;
  height: number;
  width: number;
}

const deg = THREE.MathUtils.degToRad;
const VIEWS = {
  board: { polar: deg(40), height: 12.5, width: 14.5 },
  pins: { polar: deg(32), height: 18.5, width: 22 },
};
const AZIMUTH = deg(22); // start angle around the chip; a drag can change it

export class ChipStage {
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.5, 300);
  private controls: OrbitControls;
  private pinView: PinView;
  private curves: Curves;
  private view: View = VIEWS.board;
  private move: { from: THREE.Spherical; to: THREE.Spherical; t: number } | null = null;
  private offset = new THREE.Vector3();
  private queued = false;
  private last = 0;

  constructor(
    private stage: HTMLElement,
    private region: (pins: boolean) => Box,
  ) {
    const { renderer, scene, camera } = this;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    stage.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.9;
    scene.environmentRotation.set(0, Math.PI / 5, 0);
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-8, 16, 10);
    scene.add(key);

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    const chip = buildChip(maxAnisotropy);
    scene.add(chip.group);

    camera.position.setFromSpherical(new THREE.Spherical(40, VIEWS.board.polar, AZIMUTH));
    this.controls = new OrbitControls(camera, renderer.domElement);
    const c = this.controls;
    c.target.set(0, 0.55, 0);
    camera.position.add(c.target);
    c.enablePan = false;
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 9;
    c.maxDistance = 90;
    c.addEventListener("start", () => (this.move = null)); // a drag takes over
    c.addEventListener("change", () => this.requestRender());

    const requestRender = () => this.requestRender();
    this.pinView = new PinView({ scene, camera, canvas: renderer.domElement, leads: chip.leads, maxAnisotropy, requestRender });
    this.curves = new Curves(chip.body);
    this.curves.setVisible(true);
    this.resize();
  }

  get pins(): boolean {
    return this.pinView.isOn;
  }

  setPins(on: boolean): void {
    this.pinView.setOn(on);
    this.curves.setVisible(!on);
    this.moveTo(on ? VIEWS.pins : VIEWS.board);
  }

  setLinks(links: Link[], lit: Map<number, string>): void {
    this.curves.setLinks(links);
    this.pinView.setHighlight(lit);
    this.requestRender();
  }

  setHot(key: number | string | null): void {
    this.curves.setHot(key);
  }

  private box(): Box {
    return this.region(this.pinView.isOn);
  }

  private fitDistance(v: View): number {
    const span = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const r = this.box();
    return (this.stage.clientHeight / span) * Math.max(v.height / Math.max(80, r.height), v.width / Math.max(80, r.width));
  }

  // Shift the projection so the chip's center lands in the middle of the box.
  private applyOffset(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const r = this.box();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    this.camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
  }

  private moveTo(v: View): void {
    this.view = v;
    this.applyOffset();
    const { camera, controls } = this;
    const from = new THREE.Spherical().setFromVector3(this.offset.copy(camera.position).sub(controls.target));
    const to = new THREE.Spherical(this.fitDistance(v), v.polar, from.theta);
    this.move = { from, to, t: 0 };
    this.requestRender();
  }

  private tickMove(dt: number): boolean {
    const m = this.move;
    if (!m) return false;
    m.t = Math.min(1, m.t + dt / 0.6);
    const k = 1 - (1 - m.t) ** 3; // ease out
    const s = new THREE.Spherical(
      THREE.MathUtils.lerp(m.from.radius, m.to.radius, k),
      THREE.MathUtils.lerp(m.from.phi, m.to.phi, k),
      m.from.theta,
    );
    this.camera.position.copy(this.controls.target).add(this.offset.setFromSpherical(s));
    if (m.t === 1) this.move = null;
    return this.move !== null;
  }

  // Render only when something changes: damping, fades, and camera moves keep frames coming.
  requestRender(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame((now) => {
      this.queued = false;
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
      const fading = this.pinView.tick(dt);
      const moving = this.tickMove(dt);
      this.controls.update();
      this.camera.updateMatrixWorld();
      this.renderer.render(this.scene, this.camera);
      this.curves.update(this.camera, this.renderer.domElement);
      const more = fading || moving;
      this.last = more ? now : 0;
      if (more) this.requestRender();
    });
  }

  resize(): void {
    const { camera, controls, stage } = this;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    camera.aspect = w / h;
    this.applyOffset();
    if (!this.move) {
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, this.fitDistance(this.view));
    }
    camera.updateProjectionMatrix();
    this.requestRender();
  }
}
