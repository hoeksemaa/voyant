import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "./chip";
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

const chip = buildChip(renderer.capabilities.getMaxAnisotropy());
scene.add(chip);

const camera = new THREE.PerspectiveCamera(28, 1, 0.5, 300);
camera.position.set(9, 15, 19);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.55, 0);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 9;
controls.maxDistance = 70;

// Render only when something changes; damping keeps frames coming until the motion stops.
let queued = false;
function requestRender(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    controls.update();
    renderer.render(scene, camera);
  });
}
controls.addEventListener("change", requestRender);

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Fit the chip: about 13 mm tall and 17.5 mm wide on screen from the starting angle.
  const span = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fit = Math.max(13 / span, 17.5 / (span * camera.aspect));
  controls.maxDistance = Math.max(70, fit * 1.5);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, fit);
  camera.updateProjectionMatrix();
  requestRender();
}
window.addEventListener("resize", resize);
resize();
requestRender();
