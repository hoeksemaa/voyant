import type { Bank, FieldDef, RegisterDef } from "./types";

// The 24 ADS1299 registers, from the datasheet (reference/ads1299-datasheet.pdf, SBAS499C,
// section 9.6, Table 11 and Tables 13–18). Field names are the datasheet's.
// The puzzle lets the user edit 4 groups: CONFIG1, CH1SET–CH8SET, BIAS_SENSP/N, and CONFIG3.

export const VREF = 4.5; // V, internal reference with a 5-V analog supply (datasheet 9.3.2.3)
export const GAINS = [1, 2, 4, 6, 8, 12, 24]; // GAINn[2:0] = 000 … 110; 111 = do not use
export const RATES = [16000, 8000, 4000, 2000, 1000, 500, 250]; // DR[2:0] = 000 … 110; 111 = do not use

const bit = (name: string, b: number, off: string, on: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  hi: b,
  lo: b,
  decode: (v) => (v ? on : off),
  ...extra,
});

const reserved = (hi: number, lo: number, required: number): FieldDef => ({
  name: "Reserved",
  hi,
  lo,
  lock: "reserved",
  required,
  why: `Datasheet: always write ${required.toString(2).padStart(hi - lo + 1, "0")}b`,
  decode: (v) => (v === required ? "reserved" : "reserved: wrong value"),
});

const MUX = [
  "electrode",
  "input shorted",
  "bias measurement",
  "supply (MVDD)",
  "temperature",
  "test signal",
  "bias drive (P)",
  "bias drive (N)",
];

function chset(n: number): RegisterDef {
  return {
    addr: 0x04 + n,
    name: `CH${n}SET`,
    reset: 0x61,
    group: "CHnSET",
    fields: [
      bit(`PD${n}`, 7, "on", "powered down"),
      {
        name: `GAIN${n}[2:0]`,
        hi: 6,
        lo: 4,
        decode: (v) => (v < 7 ? `×${GAINS[v]}` : "do not use"),
      },
      bit("SRB2", 3, "open", "closed"),
      { name: `MUX${n}[2:0]`, hi: 2, lo: 0, decode: (v) => MUX[v] },
    ],
  };
}

function mask(addr: number, name: string, prefix: string, group: RegisterDef["group"], sign: "P" | "N"): RegisterDef {
  const fields: FieldDef[] = [];
  for (let b = 7; b >= 0; b--) fields.push(bit(`${prefix}${b + 1}`, b, "—", `IN${b + 1}${sign}`));
  return { addr, name, reset: 0x00, group, fields };
}

const locked = (addr: number, name: string, reset: number, note: string, fields: FieldDef[] = [], readOnly = false): RegisterDef => ({
  addr,
  name,
  reset,
  group: null,
  note,
  readOnly,
  fields,
});

export const REGISTERS: RegisterDef[] = [
  locked(0x00, "ID", 0x3e, "Read-only: device ID", [
    { name: "REV_ID[2:0]", hi: 7, lo: 5, decode: (v) => `rev ${v}` },
    { name: "1", hi: 4, lo: 4, decode: () => "" },
    { name: "DEV_ID[1:0]", hi: 3, lo: 2, decode: (v) => (v === 3 ? "ADS1299" : `${v}`) },
    { name: "NU_CH[1:0]", hi: 1, lo: 0, decode: (v) => ["4 ch", "6 ch", "8 ch", "?"][v] },
  ], true),
  {
    addr: 0x01,
    name: "CONFIG1",
    reset: 0x96,
    group: "CONFIG1",
    fields: [
      reserved(7, 7, 1),
      bit("DAISY_EN", 6, "daisy-chain", "multiple readback"),
      bit("CLK_EN", 5, "clock out off", "clock out on"),
      reserved(4, 3, 2),
      {
        name: "DR[2:0]",
        hi: 2,
        lo: 0,
        decode: (v) => (v < 7 ? `${RATES[v].toLocaleString("en-US")} SPS` : "do not use"),
      },
    ],
  },
  locked(0x02, "CONFIG2", 0xc0, "Test signal: locked in this puzzle", [
    reserved(7, 5, 6),
    bit("INT_CAL", 4, "external test", "internal test"),
    reserved(3, 3, 0),
    bit("CAL_AMP", 2, "1 × VREF/2400", "2 × VREF/2400"),
    {
      name: "CAL_FREQ[1:0]",
      hi: 1,
      lo: 0,
      decode: (v) => ["fCLK / 2^21", "fCLK / 2^20", "do not use", "DC"][v],
    },
  ]),
  {
    addr: 0x03,
    name: "CONFIG3",
    reset: 0x60,
    group: "CONFIG3",
    fields: [
      bit("PD_REFBUF", 7, "reference buffer off", "reference buffer on"),
      reserved(6, 5, 3),
      bit("BIAS_MEAS", 4, "open", "BIASIN to MUX 010", {
        lock: "fixed",
        why: "Locked: no channel in these setups measures bias",
      }),
      bit("BIASREF_INT", 3, "BIASREF external", "BIASREF internal"),
      bit("PD_BIAS", 2, "bias buffer off", "bias buffer on"),
      bit("BIAS_LOFF_SENS", 1, "bias sense off", "bias sense on", {
        lock: "fixed",
        why: "Locked: lead-off detection is not in this puzzle",
      }),
      bit("BIAS_STAT", 0, "bias connected", "bias not connected", { lock: "fixed", why: "Read-only status bit" }),
    ],
  },
  locked(0x04, "LOFF", 0x00, "Lead-off detection: locked in this puzzle"),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(chset),
  mask(0x0d, "BIAS_SENSP", "BIASP", "BIAS_SENS", "P"),
  mask(0x0e, "BIAS_SENSN", "BIASN", "BIAS_SENS", "N"),
  locked(0x0f, "LOFF_SENSP", 0x00, "Lead-off detection: locked in this puzzle"),
  locked(0x10, "LOFF_SENSN", 0x00, "Lead-off detection: locked in this puzzle"),
  locked(0x11, "LOFF_FLIP", 0x00, "Lead-off detection: locked in this puzzle"),
  locked(0x12, "LOFF_STATP", 0x00, "Read-only: lead-off status", [], true),
  locked(0x13, "LOFF_STATN", 0x00, "Read-only: lead-off status", [], true),
  locked(0x14, "GPIO", 0x0f, "GPIO pins: not used"),
  locked(0x15, "MISC1", 0x00, "X8: a board switch sets SRB1, so the firmware leaves MISC1 at 00", [
    bit("SRB1", 5, "open", "closed"),
  ]),
  locked(0x16, "MISC2", 0x00, "Reserved register"),
  locked(0x17, "CONFIG4", 0x00, "Single-shot and lead-off comparators: locked in this puzzle"),
];

export const byName = (name: string): RegisterDef => {
  const r = REGISTERS.find((x) => x.name === name);
  if (!r) throw new Error(`no register ${name}`);
  return r;
};

/** Field value inside a register value. */
export const field = (value: number, f: FieldDef): number => (value >> f.lo) & ((1 << (f.hi - f.lo + 1)) - 1);

/**
 * Cerelog stock V2 firmware: the register table on the chip at the start of every puzzle.
 * Source: cerelog stock V2 (.cerelog-stock-af1a56e.bak): CONFIG1 B6, CONFIG2 D0, CONFIG3 EC,
 * LOFF 00, CH1–8 60, BIAS_SENSP/N 01/01, MISC1 00 (the X8 sets SRB1 with a board switch).
 */
export const STOCK: Bank = REGISTERS.map((r) => r.reset);
STOCK[0x01] = 0xb6;
STOCK[0x02] = 0xd0;
STOCK[0x03] = 0xec;
for (let a = 0x05; a <= 0x0c; a++) STOCK[a] = 0x60;
STOCK[0x0d] = 0x01;
STOCK[0x0e] = 0x01;

/** A copy of a bank with some registers changed, by name. */
export function withRegs(base: Bank, regs: Record<string, number>): Bank {
  const b = base.slice();
  for (const [name, v] of Object.entries(regs)) b[byName(name).addr] = v;
  return b;
}

/**
 * Check a typed value for an editable register. Returns an error message when the value
 * changes a "fixed" bit; null when the editor can take it.
 */
export function rejectReason(def: RegisterDef, current: number, next: number): string | null {
  if (!Number.isInteger(next) || next < 0 || next > 0xff) return "Type a byte: 00 to FF";
  for (const f of def.fields) {
    if (f.lock !== "fixed") continue;
    if (field(current, f) !== field(next, f)) return `${f.name} is locked. ${f.why ?? ""}`.trim();
  }
  return null;
}
