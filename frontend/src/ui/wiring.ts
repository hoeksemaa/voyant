import { field, byName } from "../puzzle/registers";
import type { Bank, ChannelOut, Electrode, Setup } from "../puzzle/types";
import { PINS } from "../pins";

// How a setup connects to the chip, and the short words that the rows show.

// One color per channel. The drawing, the analog rows, the output rows, and the curves use them.
// Bright for the dark scope screens. The CH label on each row is the second sign, so color
// is never the only one.
export const CH_COLORS = ["#4dabf7", "#ffa94d", "#f783ac", "#3bc9db", "#b197fc", "#c0eb75", "#e599f7", "#63e6be"];
// The same hues, deep enough to read as lines on the paper background (wires, ports).
export const CH_INK = ["#1c7ed6", "#e67700", "#d6336c", "#0c8599", "#7048e8", "#5c940d", "#ae3ec9", "#099268"];
export const REF_COLOR = "#5d636d"; // SRB1 reference electrode
export const BIAS_COLOR = "#8b5cf6"; // bias drive (pin group "bias")
export const SERIAL_INK = "#b07800"; // serial interface wires (DOUT, DRDY): the pin view's amber, deep enough for paper
export const TARGET_COLOR = "#aab1bb"; // the target trace: quiet grey
// The target as a pale band (3 css px each way) under the output line: the output is a sharp
// line in its channel color, and the target is the wide track that it must follow.
export const TARGET_BAND = { color: TARGET_COLOR, alpha: 0.42, band: 3 };

export const pinNo = (name: string): number => PINS.find((p) => p.name === name)!.no;

export interface Wire {
  ch: number; // 1–8
  p: Electrode | null; // electrode on INnP
  n: Electrode | null; // electrode on INnN (bipolar), or the SRB1 electrode (SRB1 montage)
  pLabel: string;
  nLabel: string;
}

export function wires(setup: Setup): Wire[] {
  const at = (pin: string) => setup.electrodes.find((e) => e.pin === pin) ?? null;
  const ref = at("SRB1");
  return [1, 2, 3, 4, 5, 6, 7, 8].map((ch) => {
    const p = at(`IN${ch}P`);
    const n = setup.montage === "srb1" ? ref : at(`IN${ch}N`);
    return {
      ch,
      p,
      n,
      pLabel: p?.id ?? "open",
      nLabel: setup.montage === "srb1" ? "SRB1" : (n?.id ?? "open"),
    };
  });
}

export const refElectrode = (s: Setup) => s.electrodes.find((e) => e.pin === "SRB1") ?? null;
export const biasElectrode = (s: Setup) => s.electrodes.find((e) => e.pin === "BIASOUT") ?? null;

/** The color of an electrode in the drawing. */
export function electrodeColor(e: Electrode): string {
  if (e.pin === "SRB1") return REF_COLOR;
  if (e.pin === "BIASOUT") return BIAS_COLOR;
  const m = /^IN(\d)[PN]$/.exec(e.pin);
  return m ? CH_COLORS[Number(m[1]) - 1] : REF_COLOR;
}

const MUX_TAG = ["", "shorted", "bias meas", "supply", "temp", "test", "bias drive", "bias drive"];

export interface Tag {
  text: string;
  bad: boolean; // red when the row fails
}

/**
 * The short word on a row: why the trace looks the way it does.
 * Order: invalid, off, a non-electrode input, a floating input. (A clipped trace shows its red
 * edge; it gets no tag.)
 */
export function channelTag(setup: Setup, bank: Bank, out: ChannelOut, pass: boolean): Tag | null {
  const reg = byName(`CH${out.ch}SET`);
  const mux = field(bank[reg.addr], reg.fields[3]);
  const hasP = setup.electrodes.some((e) => e.pin === `IN${out.ch}P`);
  let text = "";
  if (out.status === "invalid") text = "invalid";
  else if (out.status === "off") text = "off";
  else if (mux !== 0) text = MUX_TAG[mux];
  else if (!hasP) text = "floats";
  if (!text) return null;
  return { text, bad: !pass };
}
