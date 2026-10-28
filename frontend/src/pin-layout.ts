import * as THREE from "three";
import { MOLD, PKG } from "./package-dims";

// Where each pin sits on the package. Same coordinates as chip.ts:
// millimeters, Y up, top view with pin 1 at the lower left.
// Pins 1–16 run along +Z (left to right), 17–32 up +X, 33–48 along −Z, 49–64 down −X.

export const HALF = PKG.bodySize / 2;
export const TOP_Y = PKG.standoff + PKG.bodyThickness;

// Half-width of the flat top face (the body tapers above the parting line).
const tan = Math.tan((MOLD.draftDeg * Math.PI) / 180);
export const TOP_HALF = HALF - (TOP_Y - MOLD.topEdge - MOLD.partingTop) * tan - MOLD.topEdge;

export function pinSide(no: number): number {
  return Math.floor((no - 1) / PKG.pinsPerSide);
}

// Position along the side, centered on the side's middle.
function along(no: number): number {
  const k = (no - 1) % PKG.pinsPerSide;
  return (k - (PKG.pinsPerSide - 1) / 2) * PKG.pitch;
}

// A point on the line of pin `no`, `d` mm out from the package center, at height `y`.
export function pinPoint(no: number, d: number, y = 0): THREE.Vector3 {
  const s = along(no);
  switch (pinSide(no)) {
    case 0: return new THREE.Vector3(s, y, d);
    case 1: return new THREE.Vector3(d, y, -s);
    case 2: return new THREE.Vector3(-s, y, -d);
    default: return new THREE.Vector3(-d, y, s);
  }
}

// Rotation about Y that turns +X (the lead's outward axis) to face out from the pin's side.
export function sideRotation(no: number): number {
  return [-Math.PI / 2, 0, Math.PI / 2, Math.PI][pinSide(no)];
}

// The pin whose line is closest to the point (x, z), or null if the point is between sides.
export function pinNear(x: number, z: number): number | null {
  let side: number, s: number;
  if (z >= Math.abs(x)) [side, s] = [0, x];
  else if (x >= Math.abs(z)) [side, s] = [1, -z];
  else if (-z >= Math.abs(x)) [side, s] = [2, -x];
  else [side, s] = [3, z];
  const k = Math.round(s / PKG.pitch + (PKG.pinsPerSide - 1) / 2);
  if (k < 0 || k >= PKG.pinsPerSide) return null;
  return side * PKG.pinsPerSide + k + 1;
}
