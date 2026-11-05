import { usedChannels } from "../puzzle/setups";
import type { Electrode, Setup, SetupId } from "../puzzle/types";
import { BIAS_COLOR, CH_INK, REF_COLOR } from "./wiring";

// The Overview sheet: a short text summary in two parts.
// 1. The ADS1299: what it is and how it works. The same on each level.
// 2. This level: the signal, and each electrode with its pin and its job.
// It names no fix: the Hints do that.

// `x` in the text below is a pin or register name (code type).
const CHIP = {
  what: "A Texas Instruments chip that measures the body's small voltages: brain (EEG), eyes (EOG), muscle (EMG), and heart (ECG). Its 8 channels sample at the same time.",
  steps: [
    "Each channel reads the voltage between two pins: `INnP` and `INnN`.",
    "An amplifier multiplies it by the channel's gain, ×1 to ×24. The input range is ±4.5 V ÷ gain.",
    "A 24-bit ADC turns it into numbers, at 250 to 16,000 samples per second (SPS).",
    "The board reads the numbers over SPI and sends them to a computer.",
  ],
  pins: [
    "`SRB1`: the shared reference. It joins every `INnN`, so each channel reads its electrode minus the reference electrode.",
    "`BIASOUT`: the bias drive. It drives the body with the inverted average of the inputs it senses, to cancel noise that all electrodes share (mostly 60 Hz hum).",
  ],
  regs: [
    "`CONFIG1`: the data rate.",
    "`CHnSET`: each channel's power, gain, and input.",
    "`BIAS_SENSP`, `BIAS_SENSN`: the inputs the bias drive senses.",
    "`CONFIG3`: the reference buffer and the bias drive.",
  ],
  board: "The board is a Cerelog X8 (one ADS1299). Each level starts from its stock firmware.",
};

// What the electrodes pick up on each level. Facts from the body model (puzzle/body.ts).
const SIGNAL: Record<SetupId, string> = {
  emg: "Surface EMG. When the forearm muscle works, the pad on it picks up bursts of spiky voltage: hundreds of µV, with peaks past 1 mV on a hard flex. At rest, the signal is almost flat.",
  eog: "EOG. The eye is like a small battery, with the front positive. When the eyes turn, the voltage beside each eye moves about 10 µV per degree: a look to the left makes the left electrode go up and the right one go down.",
  eeg: "EEG. Brain activity on the scalp, tens of µV. With the eyes closed, the alpha rhythm (about 10 Hz) grows, most at the back of the head (O1, O2). With the eyes open, blinks show at the forehead (Fp1, Fp2).",
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
      make("p", "", ...rich(CHIP.what)),
      make("h4", "", "How it works"),
      make("ol", "", ...CHIP.steps.map((t) => make("li", "", ...rich(t)))),
      make("h4", "", "Reference and bias"),
      make("ul", "", ...CHIP.pins.map((t) => make("li", "", ...rich(t)))),
      make("h4", "", "Registers you can edit"),
      make("ul", "", ...CHIP.regs.map((t) => make("li", "", ...rich(t)))),
      make("p", "", ...rich(CHIP.board)),
    );
    this.el.append(chip, this.level);
  }

  /** Fill part 2 for a level. */
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

    this.level.replaceChildren(
      make("h3", "", `This level: ${setup.name}`),
      make("p", "", SIGNAL[setup.id]),
      make("p", "ov-time", ...timeline),
      make("h4", "", "Electrodes and pins"),
      make("ul", "ov-pins", ...rows),
      make("p", "", check),
    );
  }
}
