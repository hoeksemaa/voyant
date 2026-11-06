import { STOCK, withRegs } from "./registers";
import type { Setup } from "./types";

// The three hardware setups. Each one: electrodes on a body, wired to ADS1299 pins on a
// Cerelog X8. All three use the board switch at SRB1 (the Cerelog default): one reference
// electrode for every channel, plus one bias electrode. The target is the firmware that gives
// the target output. Every puzzle starts from STOCK (Cerelog stock V2).
//
// Drawing coordinates (x, y) are 0–1 inside each body drawing:
// - head: top view, nose up; the subject's left is on the left (10–20 system drawings).
// - face: front view; the subject's left eye is on the right of the drawing.
// - arm: right forearm, palm up; elbow on the left, hand on the right. 3 gel pads, all on the
//   forearm (John, 2026-11-02): near the wrist, just below the elbow crease, and on the muscle.
//   Wiring (John, 2026-11-03): 1 channel + reference + bias. Only the muscle pad is on the
//   muscle belly, so the elbow pad is a reference (SRB1), not the second pad of a bipolar pair
//   (a bipolar pair has both pads on the belly, ~20 mm apart). The wrist pad is ground (bias).

// Tab order (John, 2026-11-03): EMG, EOG, EEG.
export const SETUPS: Setup[] = [
  {
    id: "emg",
    name: "EMG",
    body: "arm",
    montage: "srb1",
    electrodes: [
      { id: "muscle", label: "Forearm muscle · gel pad", pin: "IN1P", x: 0.3, y: 0.43 },
      { id: "elbow", label: "Below the elbow crease · gel pad · reference", pin: "SRB1", x: 0.165, y: 0.52 },
      { id: "wrist", label: "Wrist · gel pad · bias", pin: "BIASOUT", x: 0.655, y: 0.5 },
    ],
    duration: 10,
    phases: [
      { t0: 0, t1: 2, label: "Rest" },
      { t0: 2, t1: 4.5, label: "Flex" },
      { t0: 4.5, t1: 6.5, label: "Rest" },
      { t0: 6.5, t1: 9, label: "Hard flex" },
      { t0: 9, t1: 10, label: "Rest" },
    ],
    // Fix: 250 SPS cuts most of the EMG band; 2 kSPS keeps it. CH2–8 have no electrodes.
    target: withRegs(STOCK, {
      CONFIG1: 0xb3,
      CH2SET: 0x81,
      CH3SET: 0x81,
      CH4SET: 0x81,
      CH5SET: 0x81,
      CH6SET: 0x81,
      CH7SET: 0x81,
      CH8SET: 0x81,
    }),
    spec: "2,000 SPS · ±187.5 mV",
    level: { n: 1, difficulty: "Easy", what: "Arm muscle" },
    lesson:
      "Muscle signal wiggles fast: mostly 50–150 Hz. Each sample averages the input over about 3 sample periods. At 250 SPS, that window is 12 ms, so fast wiggles average out and the bursts shrink. At 2,000 SPS (CONFIG1 = 0xB3), the window is 8× shorter, and the bursts keep their size.",
  },
  {
    id: "eog",
    name: "EOG",
    body: "face",
    montage: "srb1",
    electrodes: [
      { id: "L", label: "Left eye · outer corner", pin: "IN1P", x: 0.8, y: 0.42 },
      { id: "R", label: "Right eye · outer corner", pin: "IN2P", x: 0.2, y: 0.42 },
      { id: "A1", label: "Left earlobe · reference", pin: "SRB1", x: 0.97, y: 0.6 },
      { id: "A2", label: "Right earlobe · bias", pin: "BIASOUT", x: 0.03, y: 0.6 },
    ],
    duration: 10,
    phases: [
      { t0: 0, t1: 1, label: "Center" },
      { t0: 1, t1: 3.5, label: "Left" },
      { t0: 3.5, t1: 5.5, label: "Center" },
      { t0: 5.5, t1: 8, label: "Right" },
      { t0: 8, t1: 10, label: "Center" },
    ],
    // Fix: the electrode DC offsets clip at ×24 (±187.5 mV); ×12 (±375 mV) fits. CH3–8 have
    // no electrodes, so turn them off.
    target: withRegs(STOCK, {
      CH1SET: 0x50,
      CH2SET: 0x50,
      CH3SET: 0x81,
      CH4SET: 0x81,
      CH5SET: 0x81,
      CH6SET: 0x81,
      CH7SET: 0x81,
      CH8SET: 0x81,
    }),
    spec: "250 SPS · ±375 mV",
    level: { n: 2, difficulty: "Medium", what: "Eye movement" },
    lesson:
      "Each eye electrode sits about 200 mV from the reference, from its contact with the skin (electrode DC offset). At gain 24, the range is ±187.5 mV, so both channels clipped. Gain 12 (CHnSET = 0x50) gives ±375 mV.",
  },
  {
    id: "eeg",
    name: "EEG",
    body: "head",
    montage: "srb1",
    electrodes: [
      { id: "Fp1", label: "Fp1 · left forehead", pin: "IN1P", x: 0.4, y: 0.14 },
      { id: "Fp2", label: "Fp2 · right forehead", pin: "IN2P", x: 0.6, y: 0.14 },
      { id: "C3", label: "C3 · left center", pin: "IN3P", x: 0.3, y: 0.5 },
      { id: "C4", label: "C4 · right center", pin: "IN4P", x: 0.7, y: 0.5 },
      { id: "P3", label: "P3 · left back", pin: "IN5P", x: 0.34, y: 0.72 },
      { id: "P4", label: "P4 · right back", pin: "IN6P", x: 0.66, y: 0.72 },
      { id: "O1", label: "O1 · left occipital", pin: "IN7P", x: 0.42, y: 0.88 },
      { id: "O2", label: "O2 · right occipital", pin: "IN8P", x: 0.58, y: 0.88 },
      { id: "A1", label: "Left earlobe · reference", pin: "SRB1", x: 0.03, y: 0.5 },
      { id: "A2", label: "Right earlobe · bias", pin: "BIASOUT", x: 0.97, y: 0.5 },
    ],
    duration: 10,
    phases: [
      { t0: 0, t1: 3, label: "Eyes open" },
      { t0: 3, t1: 7, label: "Eyes closed" },
      { t0: 7, t1: 10, label: "Eyes open" },
    ],
    // Fix: put all 8 scalp electrodes in the bias loop.
    target: withRegs(STOCK, { BIAS_SENSP: 0xff }),
    spec: "250 SPS · ±187.5 mV",
    level: { n: 3, difficulty: "Hard", what: "Brain waves" },
    lesson:
      "The bias drive sensed only 2 inputs (Fp1, and the reference through BIAS_SENSN), so it pushed back weakly, and 60 Hz hum got into every channel. BIAS_SENSP = 0xFF adds the other 7 scalp electrodes: 9 inputs, 4.5× more loop gain, about 4× less hum.",
  },
];

/**
 * The channels that the puzzle shows and checks: each channel with an electrode on its INnP pin.
 * A channel with no electrode is not drawn and does not count in the match.
 */
export function usedChannels(setup: Setup): number[] {
  const used: number[] = [];
  for (let n = 1; n <= 8; n++) if (setup.electrodes.some((e) => e.pin === `IN${n}P`)) used.push(n);
  return used;
}
