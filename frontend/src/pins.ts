// The 64 pins of the ADS1299, from the datasheet "Pin Configuration and Functions" section
// (reference/ads1299-datasheet.pdf, SBAS499C, pages 5–7).
// Names, types, and descriptions are word for word from the Pin Functions table.
// Footnote marks and the notes about the 4- and 6-channel versions are left out.

export type PinGroup =
  | "input"
  | "bias"
  | "reference"
  | "supply"
  | "ground"
  | "serial"
  | "control"
  | "gpio"
  | "unused";

export interface Pin {
  no: number;
  name: string;
  type: string;
  description: string;
  group: PinGroup;
}

// Color groups are my own; the datasheet groups pins only by type.
export const GROUPS: Record<PinGroup, { label: string; color: string }> = {
  input: { label: "Analog inputs", color: "#3b82f6" },
  bias: { label: "Bias drive and SRB", color: "#8b5cf6" },
  reference: { label: "Reference and bypass", color: "#14a39a" },
  supply: { label: "Power", color: "#e5484d" },
  ground: { label: "Ground", color: "#7c8593" },
  serial: { label: "Serial interface", color: "#d99a00" },
  control: { label: "Control and clock", color: "#2fa84f" },
  gpio: { label: "GPIO", color: "#d946a8" },
  unused: { label: "Not connected", color: "#a1a8b3" },
};

// Pin names in pin order, from the Top View drawing (pin 1 first).
const ORDER = [
  "IN8N", "IN8P", "IN7N", "IN7P", "IN6N", "IN6P", "IN5N", "IN5P",
  "IN4N", "IN4P", "IN3N", "IN3P", "IN2N", "IN2P", "IN1N", "IN1P",
  "SRB1", "SRB2", "AVDD", "AVSS", "AVDD", "AVDD", "AVSS", "VREFP",
  "VREFN", "VCAP4", "NC", "VCAP1", "NC", "VCAP2", "RESV1", "AVSS",
  "DGND", "DIN", "PWDN", "RESET", "CLK", "START", "CS", "SCLK",
  "DAISY_IN", "GPIO1", "DOUT", "GPIO2", "GPIO3", "GPIO4", "DRDY", "DVDD",
  "DGND", "DVDD", "DGND", "CLKSEL", "AVSS1", "AVDD1", "VCAP3", "AVDD",
  "AVSS", "AVSS", "AVDD", "BIASREF", "BIASINV", "BIASIN", "BIASOUT", "RESERVED",
];

type Row = [type: string, description: string, group: PinGroup];

const gpio = (n: number): Row => [
  "Digital input/output",
  `General-purpose input/output pin ${n}. Connect to DGND with a ≥10-kΩ resistor if unused.`,
  "gpio",
];
const input = (sign: "positive" | "negative", n: number): Row => [
  "Analog input",
  `Differential analog ${sign} input ${n}`,
  "input",
];

const ROWS: Record<string, Row> = {
  AVDD: ["Supply", "Analog supply. Connect a 1-μF capacitor to AVSS.", "supply"],
  AVDD1: ["Supply", "Analog supply. Connect a 1-μF capacitor to AVSS1.", "supply"],
  AVSS: ["Supply", "Analog ground", "ground"],
  AVSS1: ["Supply", "Analog ground", "ground"],
  BIASIN: ["Analog input", "Bias drive input to MUX", "bias"],
  BIASINV: ["Analog input/output", "Bias drive inverting input", "bias"],
  BIASOUT: ["Analog output", "Bias drive output", "bias"],
  BIASREF: ["Analog input", "Bias drive noninverting input", "bias"],
  CS: ["Digital input", "Chip select, active low", "serial"],
  CLK: ["Digital input", "Master clock input", "control"],
  CLKSEL: ["Digital input", "Master clock select", "control"],
  DAISY_IN: ["Digital input", "Daisy-chain input", "serial"],
  DGND: ["Supply", "Digital ground", "ground"],
  DIN: ["Digital input", "Serial data input", "serial"],
  DOUT: ["Digital output", "Serial data output", "serial"],
  DRDY: ["Digital output", "Data ready, active low", "serial"],
  DVDD: ["Supply", "Digital power supply. Connect a 1-μF capacitor to DGND.", "supply"],
  GPIO1: gpio(1),
  GPIO2: gpio(2),
  GPIO3: gpio(3),
  GPIO4: gpio(4),
  NC: ["—", "No connection, leave as open circuit", "unused"],
  RESERVED: ["Analog output", "Reserved for future use, leave as open circuit", "unused"],
  RESET: ["Digital input", "System reset, active low", "control"],
  RESV1: ["Digital input", "Reserved for future use, connect directly to DGND", "unused"],
  SCLK: ["Digital input", "Serial clock input", "serial"],
  SRB1: ["Analog input/output", "Patient stimulus, reference, and bias signal 1", "bias"],
  SRB2: ["Analog input/output", "Patient stimulus, reference, and bias signal 2", "bias"],
  START: ["Digital input", "Synchronization signal to start or restart a conversion", "control"],
  PWDN: ["Digital input", "Power-down, active low", "control"],
  VCAP1: ["Analog output", "Analog bypass capacitor pin. Connect a 100-μF capacitor to AVSS.", "reference"],
  VCAP2: ["Analog output", "Analog bypass capacitor pin. Connect a 1-μF capacitor to AVSS.", "reference"],
  VCAP3: [
    "Analog output",
    "Analog bypass capacitor pin. Connect a parallel combination of 1-μF and 0.1-μF capacitors to AVSS.",
    "reference",
  ],
  VCAP4: ["Analog output", "Analog bypass capacitor pin. Connect a 1-μF capacitor to AVSS.", "reference"],
  VREFN: ["Analog input", "Negative analog reference voltage.", "reference"],
  VREFP: [
    "Analog input/output",
    "Positive analog reference voltage. Connect a minimum 10-μF capacitor to VREFN.",
    "reference",
  ],
};
for (let n = 1; n <= 8; n++) {
  ROWS[`IN${n}P`] = input("positive", n);
  ROWS[`IN${n}N`] = input("negative", n);
}

// Pins 58 and 59 are the charge-pump pair; the table gives them their own rows.
const BY_NUMBER: Record<number, Row> = {
  58: ["Supply", "Analog ground for charge pump", "ground"],
  59: ["Supply", "Charge pump analog supply. Connect a 1-μF capacitor to AVSS, pin 58.", "supply"],
};

export const PINS: Pin[] = ORDER.map((name, i) => {
  const no = i + 1;
  const [type, description, group] = BY_NUMBER[no] ?? ROWS[name];
  return { no, name, type, description, group };
});
