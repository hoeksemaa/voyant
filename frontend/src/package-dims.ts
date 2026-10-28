// ADS1299 package: 64-pin TQFP, TI package code PAG (JEDEC MS-026).
// Source: reference/ads1299-datasheet.pdf, mechanical drawing "PAG (S-PQFP-G64)".
// All values in millimeters. Each value is the middle of the datasheet's min–max range.
export const PKG = {
  bodySize: 10.0, // 9.80–10.20 square
  leadSpan: 12.0, // 11.80–12.20 square, lead tip to lead tip
  bodyThickness: 1.0, // 0.95–1.05
  standoff: 0.1, // 0.05 min; total height stays under the 1.20 max
  pitch: 0.5,
  pinsPerSide: 16,
  leadWidth: 0.22, // 0.17–0.27
  leadThickness: 0.13, // 0.13 nominal
} as const;

// Shape details the drawing does not give. Chosen to look like a molded TQFP.
export const MOLD = {
  partingBottom: 0.5, // height (above the seating plane) where the leads leave the body
  partingTop: 0.62,
  draftDeg: 10, // side taper above and below the parting line
  cornerRadius: 0.25,
  topEdge: 0.04, // rounded edge around the top face
  pin1Dimple: { x: -3.6, z: 3.6, radius: 0.45 }, // pin-1 mark, near pin 1
} as const;
