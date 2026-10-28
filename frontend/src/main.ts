import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildChip } from "./chip";
import "./style.css";

// A blurred square: white in the middle (dark shadow), fading to black (none) past the body edge.
function contactShadow(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.filter = `blur(${size * 0.045}px)`;
  ctx.fillStyle = "#fff";
  const inset = size * 0.19; // the 15 mm plane minus a body of about 9.6 mm
  ctx.fillRect(inset, inset, size - 2 * inset, size - 2 * inset);
  return new THREE.CanvasTexture(c);
}

const stage = document.getElementById("stage")!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // nothing moves but the camera, so draw shadows once
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
scene.environmentRotation.set(0, Math.PI / 5, 0);
pmrem.dispose();

// Key light from the upper left; it also casts the soft shadow on the floor.
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-8, 16, 10);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.radius = 5;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.01;
Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 });
scene.add(key);

const chip = buildChip(renderer.capabilities.getMaxAnisotropy());
scene.add(chip);

// Invisible floor that only shows the chip's shadow.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.38 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Soft dark patch right under the body, where little light reaches (cheap ambient occlusion).
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(15, 15),
  new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: contactShadow(), transparent: true, opacity: 0.7, depthWrite: false }),
);
contact.rotation.x = -Math.PI / 2;
contact.position.y = 0.002;
scene.add(contact);

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
renderer.shadowMap.needsUpdate = true;
requestRender();
