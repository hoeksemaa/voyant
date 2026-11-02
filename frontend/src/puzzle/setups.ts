import { STOCK, withRegs } from "./registers";
import type { Setup } from "./types";

// The three hardware setups. Each one: electrodes on a body, wired to ADS1299 pins on a
// Cerelog X8, with the board switch set to SRB1 or bipolar. The target is the firmware
// that gives the target output. Every puzzle starts from STOCK (Cerelog stock V2).
//
// Drawing coordinates (x, y) are 0–1 inside each body drawing:
// - head: top view, nose up; the subject's left is on the left (10–20 system drawings).
// - face: front view; the subject's left eye is on the right of the drawing.
// - arm: right forearm, palm up; elbow on the left, hand on the right.

export const SETUPS: Setup[] = [
  {
    id: "eeg",
    name: "EEG",
    detail: "8 electrodes on the scalp",
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
  },
  {
    id: "eog",
    name: "EOG",
    detail: "2 electrodes beside the eyes",
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
  },
  {
    id: "emg",
    name: "EMG",
    detail: "3 electrodes on the arm",
    body: "arm",
    montage: "bipolar",
    electrodes: [
      { id: "muscle", label: "Forearm muscle", pin: "IN1P", x: 0.4, y: 0.42 },
      { id: "elbow", label: "Elbow crease", pin: "IN1N", x: 0.12, y: 0.5 },
      { id: "wrist", label: "Wrist · bias", pin: "BIASOUT", x: 0.84, y: 0.5 },
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
  },
];
