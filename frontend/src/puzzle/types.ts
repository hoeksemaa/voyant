// Shared types for the register puzzle. The model (body.ts, model.ts, match.ts), the
// datasheet clips (clips.ts), and the UI (src/ui/) all build on these.

/** All 24 ADS1299 registers. Index = register address (00h–17h). Each value is 0–255. */
export type Bank = number[];

/**
 * How a field's bits can change in the puzzle.
 * - "reserved": the datasheet gives a required value. The bit grid does not toggle these bits,
 *   but a typed hex value can set them wrong. The model then flags the register and marks the
 *   output invalid.
 * - "fixed": the puzzle locks these bits (read-only bits, or bits with no effect here).
 *   The editor rejects any hex value that changes them.
 */
export type FieldLock = "reserved" | "fixed";

export interface FieldDef {
  name: string; // datasheet field name, for example "DR[2:0]" or "PD_BIAS"
  hi: number; // highest bit of the field
  lo: number; // lowest bit of the field
  lock?: FieldLock;
  required?: number; // the datasheet value for a reserved field
  why?: string; // reason for a lock, shown in the tooltip
  decode: (v: number) => string; // field value → short meaning, for example 6 → "250 SPS"
}

/** The register groups that the user can edit. Each group has datasheet clips. */
export type Group = "CONFIG1" | "CHnSET" | "BIAS_SENS" | "CONFIG3";

export interface RegisterDef {
  addr: number;
  name: string; // "CONFIG1", "CH1SET", "BIAS_SENSP", ...
  reset: number; // datasheet reset value
  group: Group | null; // null = locked in the puzzle
  readOnly?: boolean; // the chip does not take writes (ID, LOFF_STATP, LOFF_STATN)
  note?: string; // why a locked register is locked, for example "X8: a board switch sets SRB1"
  fields: FieldDef[];
}

/** The board switch on the Cerelog X8: SRB1 on all IN−, or each channel its own IN− (bipolar). */
export type Montage = "srb1" | "bipolar";

export type SetupId = "eeg" | "eog" | "emg";

export interface Electrode {
  id: string; // "O1", "L", "muscle", ...
  label: string; // "O1 · left occipital"
  pin: string; // ADS1299 pin: "IN7P", "IN1N", "SRB1", or "BIASOUT"
  x: number; // position on the body drawing, 0–1 from the left
  y: number; // position on the body drawing, 0–1 from the top
}

/** One part of the activity, for example "eyes closed" from 3 s to 7 s. */
export interface Phase {
  t0: number;
  t1: number;
  label: string;
}

export interface Setup {
  id: SetupId;
  name: string; // "EEG"
  detail: string; // "8 electrodes on the scalp"
  body: "head" | "face" | "arm"; // which drawing
  electrodes: Electrode[];
  montage: Montage;
  duration: number; // seconds of activity
  phases: Phase[];
  target: Bank; // the firmware that makes the target output
  spec: string; // the line under the target, for example "2,000 SPS · ±187.5 mV"
}

export type Level = "act" | "watch"; // act: wrong output. watch: works, but not as intended.

export interface Flag {
  level: Level;
  reg?: string; // register name, when one register causes it
  ch?: number; // channel, when one channel causes it
  text: string; // plain words, for example "CH3 is on, but no electrode is on IN3P. The input floats."
}

/** The analog voltage between a channel's two input pins, before the chip. */
export interface AnalogIn {
  ch: number; // 1–8
  rate: number; // samples per second of this trace (display only)
  uv: Float32Array | null; // INxP − INxN in µV; null when no electrode is on INxP
  pLabel: string; // electrode on INxP, for example "O1", or "open"
  nLabel: string; // electrode on INxN, for example "SRB1", or "open"
}

export type ChannelStatus = "on" | "off" | "invalid";

/** One channel of digital output, as the host converts it to µV with the channel's real gain. */
export interface ChannelOut {
  ch: number; // 1–8
  rate: number; // samples per second (from CONFIG1 DR)
  uv: Float32Array; // one value per sample, over the setup's duration
  rail: number; // full scale in µV (VREF / gain); a sample at ±rail is clipped
  clipped: boolean; // any sample at a rail
  status: ChannelStatus;
}

export interface SimResult {
  analog: AnalogIn[]; // 8, in channel order
  out: ChannelOut[]; // 8, in channel order
  flags: Flag[]; // the validator's findings for this bank and this wiring
}

export interface ChannelMatch {
  ch: number;
  score: number; // 0–1; 1 = the same as the target
  pass: boolean;
}

export interface MatchResult {
  channels: ChannelMatch[]; // 8, in channel order
  used: number[]; // the channels that count (see usedChannels in setups.ts)
  pass: boolean; // true when every used channel passes
}

/** One image cut from the datasheet. */
export interface Clip {
  id: string; // "register-map", "config1", ...
  title: string; // "Register map"
  group: Group | "map" | "extra";
  file: string; // URL path under public/, for example "/datasheet/config1.png"
  width: number; // image size in pixels
  height: number;
  page: number; // page in the TI PDF, for the "#page=" link
  caption: string; // datasheet figure or table name, for example "Figure 51. CONFIG1"
}
