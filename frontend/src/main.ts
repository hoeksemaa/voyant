import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "./chip";
import { PinView } from "./pin-view";
import "./style.css";

const stage = document.getElementById("stage")!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
scene.environmentRotation.set(0, Math.PI / 5, 0);
pmrem.dispose();

// Key light from the upper left.
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-8, 16, 10);
scene.add(key);

const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
const chip = buildChip(maxAnisotropy);
scene.add(chip.group);

const camera = new THREE.PerspectiveCamera(28, 1, 0.5, 300);
camera.position.set(9, 15, 19);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.55, 0);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 9;
controls.maxDistance = 70;

// Two camera framings: the chip alone, and a higher, wider one that shows every pin label.
const VIEWS = {
  chip: { polar: Math.acos(15 / Math.hypot(9, 15, 19)), height: 13, width: 17.5 },
  pins: { polar: THREE.MathUtils.degToRad(32), height: 18.5, width: 22 },
};
let view = VIEWS.chip;

function fitDistance(v: typeof view): number {
  const span = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return Math.max(v.height / span, v.width / (span * camera.aspect));
}

// Camera move between framings: polar angle and distance ease to the target; azimuth stays.
let move: { from: THREE.Spherical; to: THREE.Spherical; t: number } | null = null;
const offset = new THREE.Vector3();

function moveTo(v: typeof view): void {
  view = v;
  const from = new THREE.Spherical().setFromVector3(offset.copy(camera.position).sub(controls.target));
  const to = new THREE.Spherical(fitDistance(v), v.polar, from.theta);
  move = { from, to, t: 0 };
  requestRender();
}
controls.addEventListener("start", () => (move = null)); // a drag takes over

function tickMove(dt: number): boolean {
  if (!move) return false;
  move.t = Math.min(1, move.t + dt / 0.7);
  const k = move.t < 0.5 ? 4 * move.t ** 3 : 1 - (-2 * move.t + 2) ** 3 / 2; // ease in-out
  const s = new THREE.Spherical(
    THREE.MathUtils.lerp(move.from.radius, move.to.radius, k),
    THREE.MathUtils.lerp(move.from.phi, move.to.phi, k),
    move.from.theta,
  );
  camera.position.copy(controls.target).add(offset.setFromSpherical(s));
  if (move.t === 1) move = null;
  return move !== null;
}

// Render only when something changes. Damping, fades, and camera moves keep frames coming.
let queued = false;
let last = 0;
function requestRender(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame((now) => {
    queued = false;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    const fading = pinView.tick(dt);
    const moving = tickMove(dt);
    controls.update();
    renderer.render(scene, camera);
    const more = fading || moving;
    last = more ? now : 0;
    if (more) requestRender();
  });
}
controls.addEventListener("change", requestRender);

const pinView = new PinView({
  scene,
  camera,
  canvas: renderer.domElement,
  leads: chip.leads,
  maxAnisotropy,
  requestRender,
  onToggle: (on) => moveTo(on ? VIEWS.pins : VIEWS.chip),
});

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const fit = fitDistance(view);
  controls.maxDistance = Math.max(70, fitDistance(VIEWS.pins) * 1.5);
  if (!move) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, fit);
  }
  camera.updateProjectionMatrix();
  requestRender();
}
window.addEventListener("resize", resize);
resize();
requestRender();
