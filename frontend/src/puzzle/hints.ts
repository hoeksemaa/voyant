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
    read: "Muscle signal is fast: most of its power is at 50–150 Hz. Compare the output bursts with the target, then read CONFIG1.",
    marks: [{ reg: "CONFIG1", field: "DR[2:0]" }],
    mark: "Change DR[2:0] in CONFIG1: the data rate.",
    answer: { CONFIG1: 0xb3 },
    why: "CONFIG1 = 0xB3: DR = 011, 2,000 SPS. At 250 SPS the filter cuts at 65 Hz and folds the rest of the muscle signal down.",
  },
  eog: {
    clip: "chnset",
    read: "Both eye channels sit flat at the edge of their range. Read what sets a channel's input range in CHnSET.",
    marks: [
      { reg: "CH1SET", field: "GAIN1[2:0]" },
      { reg: "CH2SET", field: "GAIN2[2:0]" },
    ],
    mark: "Change GAIN[2:0] in CH1SET and CH2SET.",
    answer: { CH1SET: 0x50, CH2SET: 0x50 },
    why: "CH1SET = CH2SET = 0x50: gain 12, ±375 mV. The eye electrodes sit about ±200 mV from the reference, past the ±187.5 mV range of gain 24.",
  },
  eeg: {
    clip: "bias-sensp",
    read: "Every channel has 60 Hz hum from the room. Read which inputs feed the bias drive in BIAS_SENSP.",
    marks: [{ reg: "BIAS_SENSP", field: "*" }],
    mark: "Change BIAS_SENSP: which positive inputs go into the bias drive.",
    answer: { BIAS_SENSP: 0xff },
    why: "BIAS_SENSP = 0xFF: all 8 scalp electrodes in the bias average. The loop gain goes from 14 to 63, and the hum falls about 4.3×.",
  },
};
