import * as THREE from "three";
import { MOLD, PKG } from "./package-dims";
import { HALF, pinPoint, sideRotation } from "./pin-layout";
import { makeGrainTextures, makeTopTextures } from "./textures";

// Coordinates: millimeters, Y up, seating plane at y = 0.
// Top view, pin 1 at the lower left: pins 1–16 run along +Z (left to right),
// 17–32 up +X, 33–48 along −Z (right to left), 49–64 down −X.

// Points around a rounded square, in order of increasing angle in the XZ plane.
function ring(half: number, radius: number, segments = 6): [number, number][] {
  const c = half - radius;
  const corners: [number, number, number][] = [
    [c, c, 0],
    [-c, c, Math.PI / 2],
    [-c, -c, Math.PI],
    [c, -c, (3 * Math.PI) / 2],
  ];
  const pts: [number, number][] = [];
  for (const [cx, cz, start] of corners) {
    for (let k = 0; k <= segments; k++) {
      const a = start + (k / segments) * (Math.PI / 2);
      pts.push([cx + radius * Math.cos(a), cz + radius * Math.sin(a)]);
    }
  }
  return pts;
}

function bodyGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const groups: { start: number; count: number; material: number }[] = [];

  const vertex = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  const topUv = (x: number, z: number): [number, number] => [(x + HALF) / PKG.bodySize, (HALF - z) / PKG.bodySize];
  const sideUv = (x: number, y: number, z: number): [number, number] => [(x - z) * 2.5, y * 2.5];

  const tan = Math.tan((MOLD.draftDeg * Math.PI) / 180);
  const top = PKG.standoff + PKG.bodyThickness;
  const edge = MOLD.topEdge;
  const topHalf = HALF - (top - edge - MOLD.partingTop) * tan;
  const levels = [
    { y: PKG.standoff, half: HALF - (MOLD.partingBottom - PKG.standoff) * tan },
    { y: MOLD.partingBottom, half: HALF },
    { y: MOLD.partingTop, half: HALF },
    { y: top - edge, half: topHalf },
    { y: top, half: topHalf - edge }, // small rounded edge that catches a line of light
  ];
  const last = levels.length - 1;
  const r = MOLD.cornerRadius;

  // Side bands. Each band has its own vertices, so the creases between bands stay sharp.
  const sideStart = index.length;
  for (let b = 0; b < levels.length - 1; b++) {
    const lo = ring(levels[b].half, r);
    const hi = ring(levels[b + 1].half, r);
    const base = pos.length / 3;
    for (const [x, z] of lo) vertex(x, levels[b].y, z, ...sideUv(x, levels[b].y, z));
    for (const [x, z] of hi) vertex(x, levels[b + 1].y, z, ...sideUv(x, levels[b + 1].y, z));
    const n = lo.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      index.push(base + i, base + n + i, base + j, base + j, base + n + i, base + n + j);
    }
  }

  // Bottom cap, facing down.
  const bottom = ring(levels[0].half, r);
  const bc = vertex(0, levels[0].y, 0, 0, 0);
  const bStart = pos.length / 3;
  for (const [x, z] of bottom) vertex(x, levels[0].y, z, x * 2.5, z * 2.5);
  for (let i = 0; i < bottom.length; i++) index.push(bc, bStart + i, bStart + ((i + 1) % bottom.length));
  groups.push({ start: sideStart, count: index.length - sideStart, material: 0 });

  // Top cap, facing up; it carries the marking textures.
  const topStart = index.length;
  const topRing = ring(levels[last].half, r - edge);
  const tc = vertex(0, top, 0, ...topUv(0, 0));
  const tStart = pos.length / 3;
  for (const [x, z] of topRing) vertex(x, top, z, ...topUv(x, z));
  for (let i = 0; i < topRing.length; i++) index.push(tc, tStart + ((i + 1) % topRing.length), tStart + i);
  groups.push({ start: topStart, count: index.length - topStart, material: 1 });

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  for (const grp of groups) g.addGroup(grp.start, grp.count, grp.material);
  g.computeVertexNormals();
  return g;
}

// One gull-wing lead, seen from the side: out of the body, down, then a flat foot.
// Local axes: x = outward from the body edge, y = up, z = across the lead width.
function leadGeometry(): THREE.BufferGeometry {
  const t = PKG.leadThickness;
  const vc = (MOLD.partingBottom + MOLD.partingTop) / 2; // lead center height at the body
  const reach = (PKG.leadSpan - PKG.bodySize) / 2; // 1.0 mm from body edge to tip
  const R = 0.12; // bend radius at the lead center line
  const alpha = (72 * Math.PI) / 180; // slope of the leg
  const shoulder = 0.1;

  // Center line as a list of points.
  const pts: [number, number][] = [[-0.15, vc], [shoulder, vc]];
  const arc = (cx: number, cy: number, from: number, to: number) => {
    for (let k = 1; k <= 8; k++) {
      const a = from + ((to - from) * k) / 8;
      pts.push([cx + R * Math.sin(a), cy + R * Math.cos(a)]);
    }
  };
  arc(shoulder, vc - R, 0, alpha); // first bend, turning down
  const drop = vc - t / 2 - 2 * R * (1 - Math.cos(alpha));
  const leg = drop / Math.sin(alpha);
  const [lx] = pts[pts.length - 1];
  const ex = lx + leg * Math.cos(alpha); // the leg ends at height ly − leg·sin(alpha)
  // Second bend, back to flat: center sits R above the foot's center line.
  const c2x = ex + R * Math.sin(alpha);
  const c2y = t / 2 + R;
  for (let k = 0; k <= 8; k++) {
    const a = alpha - (alpha * k) / 8;
    pts.push([c2x - R * Math.sin(a), c2y - R * Math.cos(a)]);
  }
  pts.push([reach, t / 2]);

  // Offset the center line by half the thickness on each side to get the outline.
  const outer: THREE.Vector2[] = [];
  const inner: THREE.Vector2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[Math.max(0, i - 1)];
    const [bx, by] = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(bx - ax, by - ay);
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    outer.push(new THREE.Vector2(pts[i][0] + (nx * t) / 2, pts[i][1] + (ny * t) / 2));
    inner.push(new THREE.Vector2(pts[i][0] - (nx * t) / 2, pts[i][1] - (ny * t) / 2));
  }
  const shape = new THREE.Shape([...outer, ...inner.reverse()]);
  const w = PKG.leadWidth;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: w - 0.02,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.008,
    bevelSegments: 2,
    curveSegments: 4,
  });
  g.translate(0, 0, -(w - 0.02) / 2);
  return g;
}

function leads(): THREE.InstancedMesh {
  const count = PKG.pinsPerSide * 4;
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xe4dfd4, // NiPdAu finish (datasheet "Lead finish"): silver with a faint warm tone
    metalness: 1,
    roughness: 0.16,
    envMapIntensity: 1.4,
  });
  const mesh = new THREE.InstancedMesh(leadGeometry(), mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const white = new THREE.Color(1, 1, 1);
  // Instance i is pin i + 1. Each pin also gets a color, so the pin view can tint it.
  for (let i = 0; i < count; i++) {
    q.setFromAxisAngle(up, sideRotation(i + 1));
    m.compose(pinPoint(i + 1, HALF), q, one);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, white);
  }
  return mesh;
}

export interface Chip {
  group: THREE.Group;
  leads: THREE.InstancedMesh; // instance i is pin i + 1
}

export function buildChip(maxAnisotropy: number): Chip {
  const grain = makeGrainTextures();
  const topTex = makeTopTextures();
  for (const t of [topTex.color, topTex.rough, topTex.normal]) t.anisotropy = maxAnisotropy;

  const epoxy = new THREE.MeshPhysicalMaterial({
    color: 0x141416,
    roughness: 1,
    roughnessMap: grain.rough,
    normalMap: grain.normal,
    normalScale: new THREE.Vector2(0.08, 0.08),
    envMapIntensity: 0.35,
  });
  const topFace = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: topTex.color,
    roughness: 1,
    roughnessMap: topTex.rough,
    normalMap: topTex.normal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    envMapIntensity: 0.3,
  });

  const body = new THREE.Mesh(bodyGeometry(), [epoxy, topFace]);

  const pins = leads();
  const group = new THREE.Group();
  group.add(body, pins);
  return { group, leads: pins };
}
