import { usedChannels } from "../puzzle/setups";
import type { Electrode, Setup, SetupId } from "../puzzle/types";
import { BIAS_COLOR, CH_INK, REF_COLOR } from "./wiring";

// The Overview sheet, for two kinds of reader: people from software, new to hardware, and
// hardware and firmware engineers who have not met the ADS1299. Each point is a plain sentence
// first. A "tech" line under it gives the engineer's detail; a newcomer can skip it.
// 1. This level: the signal, what looks wrong, and clues. The clues
//    point at what to try and what it does; they do not give the register values (Hints do).
//    It comes first: a player opens the Overview from inside a level.
// 2. The ADS1299: what it is, how a channel works, and the knobs (registers) and what each does
//    to the output. The same on each level.
// Facts: checked against the model (puzzle/model.ts, body.ts) and docs/solutions.md.

interface Point {
  t: string; // plain sentence(s); `x` is a pin or register name
  tech?: string; // the engineer's detail
}

const CHIP = {
  what: {
    t: "A chip that turns tiny voltages from the body into numbers. It reads 8 channels at the same moment.",
    tech: "TI ADS1299: 8 channels, 24-bit delta-sigma ADC, programmable gain, internal 4.5 V reference, bias drive.",
  } as Point,
  steps: [
    { t: "Measure: each channel reads the voltage between two pins, `INnP` and `INnN`." },
    {
      t: "Amplify by the gain (×1 to ×24). The gain sets the range: ±4.5 V ÷ gain. An input past the range clips: the output goes flat at the edge. The plots divide the gain back out, so the gain does not change the size of the trace.",
      tech: "Plots are in µV, referred to the input.",
    },
    {
      t: "Sample: the data rate is 250 to 16,000 samples per second (SPS). Each sample is the average of the input over a window of about 3 sample periods. A slow rate has a long window, so fast wiggles average out and shrink.",
      tech: "Delta-sigma: the sinc³ decimation filter is the only low-pass, so the data rate also sets the bandwidth: −3 dB at 0.262 × data rate (65 Hz at 250 SPS). It rolls off slowly, and what is left above half the data rate aliases.",
    },
    { t: "Send: the board reads the samples over SPI and sends them to the computer." },
  ] as Point[],
  pins: [
    { t: "`SRB1`: the reference. One electrode that every channel subtracts." },
    {
      t: "`BIASOUT`: the bias drive. It senses the inputs you pick and pushes the body the other way, to make what they share smaller: mostly 60 Hz hum from the room's wiring. The more inputs it senses, the harder it pushes.",
      tech: "A right-leg-drive loop: an inverting amp sums the sensed inputs, each through its own resistor. Loop gain ≈ N × Rf / R, so it grows with each input. The hum falls by 1 + loop gain.",
    },
  ] as Point[],
  knobs: [
    { t: "`CONFIG1`, DR: the data rate. A faster rate keeps fast wiggles at full size. Each step down in DR doubles the rate." },
    { t: "`CHnSET`, one per channel: on or off, gain, and source. A lower gain fits a larger input. The source can also be a test signal, such as \"input shorted\" (the chip's own noise)." },
    { t: "`BIAS_SENSP`, `BIAS_SENSN`: one bit per input. A bit on adds that input to the bias drive. Do not turn on a bit for a pin with no electrode: that pin floats, and the bias drive pushes its large hum into every channel." },
    { t: "`CONFIG3`: the reference buffer, the bias drive's power, and the bias drive's reference. Change one to see what breaks. No level needs a change here." },
  ] as Point[],
  board: "The board is a Cerelog X8 (one ADS1299). Each level starts from its stock firmware and has one problem. When it is fixed, the colored output runs inside the grey target band.",
};

// Each level: the signal, what looks wrong at the start, and clues. Measured in the model:
// EMG hard-flex rms is 223 µV at 250 SPS, 310 at 500, 364 at 1,000, 387 at 2,000 (target); only
// 2,000 passes. EOG: any gain ×1–×12 passes, each channel on its own. EEG: mean 60 Hz hum 39 µV
// at the start, 9 µV in the target; 3 bias bits in total give 0/8 channels, 4 give 1/8, 5 give
// 3/8, 6 or more pass. No target settings here: the EMG rate would give the answer away.
const LEVEL: Record<SetupId, { signal: string; wrong: string; clues: string[] }> = {
  emg: {
    signal: "Surface EMG: muscle fibers firing. Bursts when the forearm muscle works, almost flat at rest. It wiggles fast: mostly 50 to 150 times a second (50–150 Hz).",
    wrong: "The output bursts are smaller and smoother than the target's.",
    clues: [
      "Gain will not help: the plot divides it back out, so the bursts stay the same size.",
      "Each sample is an average over a window about 3 sample periods long. At 250 SPS, that is 12 ms: longer than one 100 Hz wiggle (10 ms). The ups and downs cancel, so the bursts shrink.",
      "A faster data rate gives a shorter window, so less cancels and the bursts grow taller. To pass, the rate must match the target's.",
    ],
  },
  eog: {
    signal: "EOG: the eye is like a small battery, with the front positive. When the eyes turn, the voltage beside each eye moves about 10 µV per degree.",
    wrong: "Both outputs are flat, stuck at the edge of their range.",
    clues: [
      "Flat at the edge means the input is larger than the range: it clips.",
      "Each eye electrode also sits about 200 mV away from the reference, all the time. This steady offset comes from the electrode's contact with the skin, not from the eye.",
      "A lower gain gives a wider range, and each channel has its own gain. When the range fits, the flat line comes off the edge and follows the eyes.",
    ],
  },
  eeg: {
    signal: "EEG: brain waves on the scalp, tens of µV. With the eyes closed, a 10 Hz alpha rhythm grows at the back of the head (O1, O2). With the eyes open, blinks show at the forehead (Fp1, Fp2).",
    wrong: "Every channel carries extra 60 Hz hum from the room, about as large as the brain signal. In a short row, it looks like a thick, fuzzy line. Tap the magnifier at the end of an output row to compare it with the target.",
    clues: [
      "The hum is on the whole body. Each skin contact passes it a little differently, so some hum gets into every channel. The bias drive pushes back on the body's hum and makes it smaller.",
      "Count the bits that are on in `BIAS_SENSP` and `BIAS_SENSN`: that is how many inputs the bias drive senses now. Turn on more, one at a time: the hum gets smaller, and the match count climbs.",
      "The data rate and gain already match the target.",
    ],
  },
};

type Kid = string | Node;
function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

/** Text with `names` as code. */
function rich(text: string): Kid[] {
  return text.split("`").map((part, i) => (i % 2 ? make("code", "", part) : part));
}

/** A point: its sentence, then its tech line (smaller, muted) when it has one. */
function point(x: Point, tag: "p" | "li"): HTMLElement {
  const el = make(tag, "", ...rich(x.t));
  if (x.tech) el.append(make("span", "ov-tech", ...rich(x.tech)));
  return el;
}

/** "s" seconds as text: 2 → "2", 4.5 → "4.5". */
const sec = (s: number) => String(Math.round(s * 10) / 10);

/** The channel list as words: [2, 3, 4] → "CH2–CH4". */
function chRange(chs: number[]): string {
  if (!chs.length) return "";
  if (chs.length === 1) return `CH${chs[0]}`;
  return `CH${chs[0]}–CH${chs[chs.length - 1]}`;
}

export class Overview {
  readonly el = make("div", "ov");
  private readonly level = make("section", "ov-sec");

  constructor() {
    const chip = make(
      "section",
      "ov-sec",
      make("h3", "", "The ADS1299"),
      point(CHIP.what, "p"),
      make("h4", "", "How a channel works"),
      make("ol", "", ...CHIP.steps.map((x) => point(x, "li"))),
      make("h4", "", "Reference and bias"),
      make("ul", "", ...CHIP.pins.map((x) => point(x, "li"))),
      make("h4", "", "Knobs (registers) you can turn"),
      make("ul", "", ...CHIP.knobs.map((x) => point(x, "li"))),
      make("p", "", ...rich(CHIP.board)),
    );
    this.el.append(this.level, chip);
  }

  /** Fill part 1 for a level. */
  setSetup(setup: Setup): void {
    const pinOf = (e: Electrode) => /^IN(\d)P$/.exec(e.pin);
    const inputs = setup.electrodes.filter((e) => pinOf(e)).sort((a, b) => a.pin.localeCompare(b.pin));
    const rank = (e: Electrode) => (e.pin === "SRB1" ? 0 : 1); // the reference, then the bias
    const others = setup.electrodes.filter((e) => !pinOf(e)).sort((a, b) => rank(a) - rank(b));
    const rows = [...inputs, ...others].map((e) => {
      const m = pinOf(e);
      const ch = m ? Number(m[1]) : 0;
      const job = ch ? `CH${ch}` : e.pin === "SRB1" ? "Reference" : "Bias drive";
      const color = ch ? CH_INK[ch - 1] : e.pin === "SRB1" ? REF_COLOR : BIAS_COLOR;
      // The label's place only: the job is in its own column.
      const where = e.label.replace(/ · (reference|bias)$/, "").replace(/ · /g, ", ");
      const pin = make("code", "ov-pin", e.pin);
      pin.style.color = color;
      return make("li", "", pin, make("span", "", make("b", "", job), ` · ${where}`));
    });

    const used = usedChannels(setup);
    const free = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => !used.includes(n));
    const check =
      used.length === 8
        ? "Checked: all 8 channels."
        : `Checked: ${used.map((n) => `CH${n}`).join(" and ")}. ${chRange(free)} have no electrode.`;
    // One phase never breaks across lines; a line can end on "·" but not start with it.
    const timeline: Kid[] = ["Recording: "];
    setup.phases.forEach((p, i) => {
      timeline.push(make("span", "ov-phase", `${p.label} ${sec(p.t0)}–${sec(p.t1)} s`));
      if (i < setup.phases.length - 1) timeline.push("\u00a0· ");
    });

    const lv = LEVEL[setup.id];
    this.level.replaceChildren(
      make("h3", "", `This level: ${setup.name}`),
      make("p", "", lv.signal),
      make("p", "ov-time", ...timeline),
      make("h4", "", "What looks wrong"),
      make("p", "", lv.wrong),
      make("h4", "", "Clues"),
      make("ul", "", ...lv.clues.map((c) => make("li", "", ...rich(c)))),
      make("h4", "", "Electrodes and pins"),
      make("ul", "ov-pins", ...rows),
      make("p", "", check),
    );
  }
}
