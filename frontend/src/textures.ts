import * as THREE from "three";
import { MOLD, PKG } from "./package-dims";

// All textures are drawn in code at load time, so the site downloads no images.

// Small seeded random, so the grain looks the same on every load.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Tileable value noise in [0, 1]: random cells, box-blurred with wrap-around.
function tileNoise(size: number, seed: number, blur: number): Float32Array {
  const rand = rng(seed);
  let a = new Float32Array(size * size).map(() => rand());
  let b = new Float32Array(size * size);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -blur; k <= blur; k++) sum += a[y * size + ((x + k + size) % size)];
        b[y * size + x] = sum / (2 * blur + 1);
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -blur; k <= blur; k++) sum += b[((y + k + size) % size) * size + x];
        a[y * size + x] = sum / (2 * blur + 1);
      }
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return a.map((v) => (v - lo) / (hi - lo));
}

// Height field → tangent-space normal map (canvas rows run top to bottom).
function normalsFromHeight(h: Float32Array, size: number, strength: number, wrap: boolean): ImageData {
  const out = new ImageData(size, size);
  const at = (x: number, y: number) => {
    if (wrap) return h[((y + size) % size) * size + ((x + size) % size)];
    return h[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * strength;
      const ny = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

function texture(c: HTMLCanvasElement, srgb: boolean, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Fine grain for the molded plastic on the sides and bottom.
export function makeGrainTextures(): { normal: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const size = 256;
  const fine = tileNoise(size, 7, 1);
  const [nc, nctx] = canvas(size);
  nctx.putImageData(normalsFromHeight(fine, size, 2.0, true), 0, 0);
  const [rc, rctx] = canvas(size);
  const img = rctx.createImageData(size, size);
  for (let i = 0; i < fine.length; i++) {
    const g = (0.58 + 0.1 * fine[i]) * 255; // roughness lives in the green channel
    const j = i * 4;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = g;
    img.data[j + 3] = 255;
  }
  rctx.putImageData(img, 0, 0);
  return { normal: texture(nc, false, true), rough: texture(rc, false, true) };
}

// Top face: laser marking, pin-1 dimple, and grain. UV (0,0)–(1,1) covers the 10 × 10 mm body.
export function makeTopTextures(): { color: THREE.CanvasTexture; rough: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const mm = (v: number, size: number) => ((v + PKG.bodySize / 2) / PKG.bodySize) * size;

  // Marking mask: the text, drawn once at high resolution.
  const big = 2048;
  const [, mctx] = canvas(big);
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, big, big);
  mctx.fillStyle = "#fff";
  mctx.textAlign = "center";
  mctx.textBaseline = "alphabetic";
  const px = big / PKG.bodySize; // pixels per millimeter
  mctx.font = `600 ${1.15 * px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  mctx.fillText("ADS1299", big / 2, big / 2 + 0.2 * px);
  mctx.font = `500 ${0.7 * px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  mctx.fillText("TI   5AK   G4", big / 2, big / 2 + 1.35 * px);
  const mask = mctx.getImageData(0, 0, big, big).data;

  // Color: dark epoxy with faint mottling; marking is a light, uneven gray.
  const grain = tileNoise(512, 11, 2);
  const [cc, cctx] = canvas(big);
  const cimg = cctx.createImageData(big, big);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const i = y * big + x;
      const n = grain[(y % 512) * 512 + (x % 512)];
      const m = mask[i * 4] / 255;
      const base = 11 + 4 * n;
      const mark = 92 + 22 * n;
      const v = base + (mark - base) * m;
      const j = i * 4;
      cimg.data[j] = cimg.data[j + 1] = v;
      cimg.data[j + 2] = v + 1;
      cimg.data[j + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);

  // Height and roughness at 1024: dimple is a smooth, shiny bowl; marking is rough and slightly engraved.
  const size = 1024;
  const fine = tileNoise(256, 23, 1);
  const height = new Float32Array(size * size);
  const [rc, rctx] = canvas(size);
  const rimg = rctx.createImageData(size, size);
  const dx = mm(MOLD.pin1Dimple.x, size);
  const dy = mm(MOLD.pin1Dimple.z, size);
  const dr = (MOLD.pin1Dimple.radius / PKG.bodySize) * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const m = mask[(y * 2 * big + x * 2) * 4] / 255;
      const n = fine[(y % 256) * 256 + (x % 256)];
      const d = Math.hypot(x - dx, y - dy) / dr;
      const inDimple = d < 1;
      const bowl = inDimple ? -(Math.cos((d * Math.PI) / 2) ** 0.6) : 0;
      height[i] = 0.02 * n - 0.03 * m + 0.3 * bowl;
      let r = 0.5 + 0.12 * n; // matte epoxy
      r += 0.3 * m; // laser marks are rougher
      if (inDimple) r = 0.34 + 0.05 * n; // the mold leaves the dimple smoother
      const g = Math.min(1, r) * 255;
      const j = i * 4;
      rimg.data[j] = rimg.data[j + 1] = rimg.data[j + 2] = g;
      rimg.data[j + 3] = 255;
    }
  }
  rctx.putImageData(rimg, 0, 0);
  const [nc, nctx] = canvas(size);
  nctx.putImageData(normalsFromHeight(height, size, 6.0, false), 0, 0);

  return { color: texture(cc, true), rough: texture(rc, false), normal: texture(nc, false) };
}
