import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "./chip";
import { Curves } from "./curves";
import { PinView } from "./pin-view";
import { Player } from "./player";
import { PROBE_STYLE, Scopes } from "./scopes";
import { GROUPS } from "./pins";
import { loadRun } from "./sim-data";
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

// Camera framings. Each fits a box of chip (millimeters) into a region of the screen:
// the whole canvas, or, with the scopes open, the space between them.
interface View {
  polar: number;
  height: number;
  width: number;
}
const VIEWS = {
  chip: { polar: Math.acos(15 / Math.hypot(9, 15, 19)), height: 13, width: 17.5 },
  pins: { polar: THREE.MathUtils.degToRad(32), height: 18.5, width: 22 },
  sim: { polar: THREE.MathUtils.degToRad(40), height: 13.5, width: 15 },
};
let view: View = VIEWS.chip;

// The screen region the chip should fill, in canvas pixels.
function region(): { cx: number; cy: number; w: number; h: number } {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (view !== VIEWS.sim || !player) return { cx: w / 2, cy: h / 2, w, h };
  const left = scopes!.columns.in.getBoundingClientRect();
  const right = scopes!.columns.out.getBoundingClientRect();
  const panel = player.stepPanel.getBoundingClientRect();
  const wide = w > 900;
  const x0 = wide ? left.right : 0;
  const x1 = wide ? right.left : w;
  const y0 = wide ? 64 : panel.bottom; // on a phone the step panel sits on top, the scopes below
  const y1 = wide ? panel.top : left.top;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(80, x1 - x0), h: Math.max(80, y1 - y0) };
}

function fitDistance(v: View): number {
  const span = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const r = region();
  return (stage.clientHeight / span) * Math.max(v.height / r.h, v.width / r.w);
}

// Shift the projection so the chip's center lands in the middle of its region.
function applyOffset(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const r = region();
  if (r.cx === w / 2 && r.cy === h / 2) camera.clearViewOffset();
  else camera.setViewOffset(w, h, w / 2 - r.cx, h / 2 - r.cy, w, h);
}

// Camera move between framings: polar angle and distance ease to the target; azimuth stays.
let move: { from: THREE.Spherical; to: THREE.Spherical; t: number } | null = null;
const offset = new THREE.Vector3();

function moveTo(v: View): void {
  view = v;
  applyOffset();
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

// Render only when something changes. Damping, fades, camera moves, and playback keep frames coming.
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
    const playing = player?.tick(dt) ?? false;
    controls.update();
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    curves?.update(camera, renderer.domElement);
    const more = fading || moving || playing;
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
});

// The simulation loads on first use.
let scopes: Scopes | null = null;
let curves: Curves | null = null;
let player: Player | null = null;

async function simulation(): Promise<Player> {
  if (player) return player;
  const run = await loadRun();
  scopes = new Scopes(run);
  curves = new Curves(scopes.links, chip.body);
  player = new Player(run, scopes, curves);
  return player;
}

// Toolbar: pin view, or one of the three sequences. Pressing the active one turns it off.
type Mode = "chip" | "pins" | string;
let mode: Mode = "chip";
const buttons = document.querySelectorAll<HTMLButtonElement>(".toolbar button");

async function setMode(next: Mode): Promise<void> {
  if (next === mode) next = "chip";
  mode = next;
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  pinView.setOn(mode === "pins");
  if (mode === "chip" || mode === "pins") {
    player?.close();
    pinView.setHighlight(null);
    moveTo(mode === "pins" ? VIEWS.pins : VIEWS.chip);
    return;
  }
  const p = await simulation();
  if (mode !== next) return; // another button was pressed while loading
  p.play(mode);
  const lit = new Map<number, string>();
  for (const link of scopes!.links) lit.set(link.pin, GROUPS[PROBE_STYLE[link.probe].group].color);
  pinView.setHighlight(lit);
  moveTo(VIEWS.sim);
}

buttons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode!)));
window.addEventListener("keydown", (e) => {
  if (e.key === "p" && !e.metaKey && !e.ctrlKey) setMode("pins");
  if (e.key === "Escape" && mode !== "chip" && mode !== "pins") setMode("chip");
});

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  applyOffset();
  controls.maxDistance = Math.max(70, fitDistance(VIEWS.pins) * 1.5);
  if (!move) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, fitDistance(view));
  }
  camera.updateProjectionMatrix();
  requestRender();
}
window.addEventListener("resize", resize);
resize();
requestRender();
