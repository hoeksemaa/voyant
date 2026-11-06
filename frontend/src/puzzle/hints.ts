import type { SetupId } from "./types";

// Three hints per level, each a bigger step than the last (John, 2026-11-05):
//   1. read: open the datasheet at the register that must change, with one line on what to see.
//   2. mark: highlight the bits to change in the firmware.
//   3. answer: set those registers (on stock firmware) and show the result.
// puzzle.test.ts checks that each answer solves its level from STOCK, and that each mark names a
// real field.

export interface Mark {
  reg: string; // register name, for example "CH1SET"
  field: string; // field name in registers.ts, for example "GAIN1[2:0]"
}

export interface LevelHints {
  clip: string; // datasheet clip id (puzzle/clips.ts)
  read: string; // hint 1
  marks: Mark[]; // hint 2: the bits to change
  mark: string;
  answer: Record<string, number>; // hint 3: register values on top of STOCK
  why: string;
}

export const HINTS: Record<SetupId, LevelHints> = {
  emg: {
    clip: "config1",
    read: "The output bursts are smaller and smoother than the target. Each sample is an average over a window of about 3 sample periods, so at a slow data rate, fast wiggles average out. Read CONFIG1: it sets the data rate.",
    marks: [{ reg: "CONFIG1", field: "DR[2:0]" }],
    mark: "Change DR[2:0] in CONFIG1. Each step down in DR doubles the data rate. Set the target's rate: 2,000 SPS.",
    answer: { CONFIG1: 0xb3 },
    why: "CONFIG1 = 0xB3: DR = 011, 2,000 SPS. At 250 SPS, the window is 12 ms, longer than one 100 Hz muscle wiggle (10 ms), so a 100 Hz wiggle keeps only 43% of its size. At 2,000 SPS, the window is 1.5 ms, and it keeps 99%.",
  },
  eog: {
    clip: "chnset",
    read: "Both outputs are flat at the edge of their range: the input is too large, so it clips. Each eye electrode sits about 200 mV from the reference. The gain sets the range: ±4.5\u00a0V ÷ gain. Read CHnSET.",
    marks: [
      { reg: "CH1SET", field: "GAIN1[2:0]" },
      { reg: "CH2SET", field: "GAIN2[2:0]" },
    ],
    mark: "Change GAIN[2:0] in CH1SET and CH2SET. A lower gain gives a wider range.",
    answer: { CH1SET: 0x50, CH2SET: 0x50 },
    why: "CH1SET = CH2SET = 0x50: gain 12, range ±375 mV. Each eye electrode sits about 200 mV from the reference. That is past the ±187.5 mV range of gain 24.",
  },
  eeg: {
    clip: "bias-sensp",
    read: "Every channel has 60 Hz hum from the room. The bias drive cancels hum, but it uses only the inputs that it senses. Read BIAS_SENSP: one bit per input.",
    marks: [{ reg: "BIAS_SENSP", field: "*" }],
    mark: "Change BIAS_SENSP. Each bit that you turn on adds one input to the bias drive.",
    answer: { BIAS_SENSP: 0xff },
    why: "BIAS_SENSP = 0xFF: all 8 scalp electrodes go into the bias drive. With the reference (through BIAS_SENSN), it senses 9 inputs, not 2. It pushes back 4.5× harder, and the hum falls about 4×.",
  },
};
