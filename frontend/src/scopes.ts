import { GROUPS, type PinGroup } from "./pins";
import { trace, type ProbeInfo, type Region, type RunIndex } from "./sim-data";

// Scope panels: inputs to the chip on the left, outputs on the right. Each lane plots one
// or more probes from the backend run in roll mode: new data enters at the right edge.

interface Lane {
  label: string;
  probes: string[];
  height: number;
  range?: [number, number];
  digital?: boolean;
  bytes?: "byte" | "out"; // label the bits with the decoded bytes
}

interface PanelSpec {
  title: string;
  side: "in" | "out";
  decode?: "command" | "read";
  lanes: Lane[];
}

// Trace colors (bright, for the dark scope screen) and the pin group that colors each curve.
export const PROBE_STYLE: Record<string, { color: string; group: PinGroup }> = {
  avdd: { color: "#ff6b6b", group: "supply" },
  dvdd: { color: "#ffa94d", group: "supply" },
  pwdn: { color: "#69db7c", group: "control" },
  reset: { color: "#69db7c", group: "control" },
  start: { color: "#69db7c", group: "control" },
  cs: { color: "#ffd43b", group: "serial" },
  sclk: { color: "#ffd43b", group: "serial" },
  din: { color: "#ffd43b", group: "serial" },
  in1: { color: "#4dabf7", group: "input" },
  in2: { color: "#3bc9db", group: "input" },
  vrefp: { color: "#38d9a9", group: "reference" },
  vcap1: { color: "#38d9a9", group: "reference" },
  biasout: { color: "#b197fc", group: "bias" },
  clk: { color: "#69db7c", group: "control" },
  drdy: { color: "#ffd43b", group: "serial" },
  dout: { color: "#ffd43b", group: "serial" },
  ch1: { color: "#4dabf7", group: "input" },
  ch2: { color: "#3bc9db", group: "input" },
};

const PANELS: PanelSpec[] = [
  { title: "Supplies", side: "in", lanes: [{ label: "AVDD · DVDD", probes: ["avdd", "dvdd"], height: 46, range: [0, 5.5] }] },
  {
    title: "Control pins",
    side: "in",
    lanes: [
      { label: "PWDN", probes: ["pwdn"], height: 24, digital: true },
      { label: "RESET", probes: ["reset"], height: 24, digital: true },
      { label: "START", probes: ["start"], height: 24, digital: true },
    ],
  },
  {
    title: "SPI in",
    side: "in",
    decode: "command",
    lanes: [
      { label: "CS", probes: ["cs"], height: 24, digital: true },
      { label: "SCLK", probes: ["sclk"], height: 24, digital: true },
      { label: "DIN", probes: ["din"], height: 30, digital: true, bytes: "byte" },
    ],
  },
  { title: "Electrodes", side: "in", lanes: [{ label: "IN1P − SRB1 · IN2P − SRB1", probes: ["in1", "in2"], height: 60 }] },
  {
    title: "Reference",
    side: "out",
    lanes: [
      { label: "VREFP", probes: ["vrefp"], height: 36 },
      { label: "VCAP1", probes: ["vcap1"], height: 36 },
    ],
  },
  {
    title: "Bias drive and clock",
    side: "out",
    lanes: [
      { label: "BIASOUT", probes: ["biasout"], height: 32 },
      { label: "CLK", probes: ["clk"], height: 24, digital: true },
    ],
  },
  {
    title: "SPI out",
    side: "out",
    decode: "read",
    lanes: [
      { label: "DRDY", probes: ["drdy"], height: 24, digital: true },
      { label: "DOUT", probes: ["dout"], height: 30, digital: true, bytes: "out" },
    ],
  },
  { title: "Channel data", side: "out", lanes: [{ label: "CH1 · CH2", probes: ["ch1", "ch2"], height: 60 }] },
];

// One curve from a lane to a pin.
export interface Link {
  el: HTMLElement; // the lane
  side: "in" | "out";
  probe: string;
  pin: number;
  color: string;
}

interface LaneView {
  spec: Lane;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  values: HTMLSpanElement[];
  probes: ProbeInfo[];
}

interface PanelView {
  spec: PanelSpec;
  el: HTMLElement;
  decodeEl: HTMLSpanElement;
  lanes: LaneView[];
}

function format(v: number, unit: string, digital: boolean, band: boolean): string {
  if (Number.isNaN(v)) return unit === "µV" ? "no data" : "Hi-Z";
  if (digital) return band ? "toggling" : v > 1.2 ? "high" : "low";
  if (unit === "µV") return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)} µV`;
  return `${Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2)} V`;
}

export class Scopes {
  readonly links: Link[] = [];
  private panels: PanelView[] = [];
  readonly columns: Record<"in" | "out", HTMLElement>;
  private axis: Record<"in" | "out", HTMLElement>;
  private probes: Map<string, ProbeInfo>;
  private screen: number;
  private sps: number;

  constructor(run: RunIndex) {
    this.probes = new Map(run.probes.map((p) => [p.id, p]));
    this.screen = run.screen;
    this.sps = run.sps;
    this.columns = { in: this.column("in", "Into the chip"), out: this.column("out", "Out of the chip") };
    this.axis = {
      in: this.columns.in.querySelector(".scope-axis")!,
      out: this.columns.out.querySelector(".scope-axis")!,
    };
    for (const spec of PANELS) this.panels.push(this.panel(spec));
  }

  private column(side: "in" | "out", title: string): HTMLElement {
    const col = document.createElement("div");
    col.className = `scopes scopes-${side}`;
    col.innerHTML = `<p class="scopes-title">${title}</p><p class="scope-axis"></p>`;
    document.body.append(col);
    return col;
  }

  private panel(spec: PanelSpec): PanelView {
    const el = document.createElement("section");
    el.className = "scope";
    el.innerHTML = `<header><span>${spec.title}</span><span class="scope-decode"></span></header>`;
    const lanes: LaneView[] = [];
    for (const lane of spec.lanes) {
      const row = document.createElement("div");
      row.className = "lane";
      row.style.height = `${lane.height}px`;
      const screen = document.createElement("div");
      screen.className = "lane-screen";
      const canvas = document.createElement("canvas");
      screen.append(canvas);
      const label = document.createElement("div");
      label.className = "lane-label";
      const probes = lane.probes.map((id) => this.probes.get(id)!);
      const values: HTMLSpanElement[] = [];
      for (const p of probes) {
        const item = document.createElement("span");
        item.innerHTML = `<i style="background:${PROBE_STYLE[p.id].color}"></i>${p.label.replace(" − ", "−")}`;
        const v = document.createElement("b");
        item.append(v);
        values.push(v);
        label.append(item);
        for (const pin of p.pins) {
          this.links.push({ el: row, side: spec.side, probe: p.id, pin, color: GROUPS[PROBE_STYLE[p.id].group].color });
        }
      }
      row.append(label, screen);
      el.append(row);
      lanes.push({ spec: lane, el: row, canvas, values, probes });
    }
    this.columns[spec.side].insertBefore(el, this.axis[spec.side] ?? null);
    return { spec, el, decodeEl: el.querySelector(".scope-decode")!, lanes };
  }

  setVisible(on: boolean): void {
    document.body.classList.toggle("sim-on", on);
  }

  setAxis(text: string): void {
    this.axis.in.textContent = this.axis.out.textContent = text;
  }

  // Sample range on screen at playback time `p` (seconds into the region).
  private window(region: Region, p: number): [number, number] {
    const k1 = Math.min(region.n, Math.floor(p * this.sps));
    return [Math.max(0, Math.floor((p - this.screen) * this.sps)), k1];
  }

  // Probes that change by more than noise on screen right now.
  moving(region: Region, p: number): Set<string> {
    const [k0, k1] = this.window(region, p);
    const out = new Set<string>();
    for (const probe of this.probes.values()) {
      const tr = trace(region, probe);
      if (tr.constant) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = k0; k < k1; k++) {
        if (tr.lo[k] < lo) lo = tr.lo[k];
        if (tr.hi[k] > hi) hi = tr.hi[k];
      }
      if (hi - lo > 0.04 * (probe.hi - probe.lo)) out.add(probe.id);
    }
    return out;
  }

  // Draw every lane at playback time `p` of `region`, played at `rate`.
  draw(region: Region, p: number, rate: number): void {
    const tNow = region.t0 + p * rate;
    for (const panel of this.panels) {
      for (const lane of panel.lanes) this.drawLane(region, lane, p, rate, tNow);
      if (panel.spec.decode) {
        const kinds = panel.spec.decode === "command" ? ["command"] : ["read"];
        let text = "";
        for (const [t0, , kind, label] of region.events) {
          if (t0 > tNow) break;
          if (kinds.includes(kind) || (panel.spec.decode === "read" && label.startsWith("RREG"))) text = label;
        }
        if (panel.spec.decode === "command" && text.startsWith("RREG")) text = text.split(" → ")[0];
        if (panel.spec.decode === "read") text = text.replace(/^Read: status [0-9A-F]+h, /, "").replace(/^RREG /, "");
        panel.decodeEl.textContent = text;
      }
    }
  }

  private drawLane(region: Region, lane: LaneView, p: number, rate: number, tNow: number): void {
    const { canvas, spec } = lane;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Grid: ten time divisions and a center line.
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let d = 1; d < 10; d++) ctx.fillRect(Math.round((d / 10) * w), 0, 1, h);
    ctx.fillRect(0, Math.round(h / 2), w, 1);

    const { screen, sps } = this;
    const [k0, k1] = this.window(region, p);
    const left = p - screen; // playback time at the left edge
    const xOf = (k: number) => ((k / sps - left) / screen) * w;
    const col = w / (screen * sps);
    const pad = spec.digital ? 5 : 4;
    const top = spec.bytes ? 10 : pad; // room for byte labels

    lane.probes.forEach((probe, j) => {
      const tr = trace(region, probe);
      const [lo, hi] = spec.range ?? [probe.lo, probe.hi];
      const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad - top);
      const color = PROBE_STYLE[probe.id].color;
      for (const [width, alpha] of [
        [3.2, 0.22],
        [1.4, 1],
      ] as const) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        let prev = NaN;
        for (let k = k0; k < k1; k++) {
          const a = tr.lo[k];
          const b = tr.hi[k];
          const x = xOf(k);
          if (Number.isNaN(a)) {
            // Not driven: a dotted line at mid-height.
            if (width < 2 && k % 4 === 0) {
              ctx.globalAlpha = 0.35;
              ctx.fillRect(x, h / 2, Math.max(1, col), 1);
              ctx.globalAlpha = alpha;
            }
            prev = NaN;
            continue;
          }
          let y0 = Math.max(0, Math.min(h, y(b)));
          let y1 = Math.max(0, Math.min(h, y(a)));
          if (!Number.isNaN(prev)) {
            y0 = Math.min(y0, prev);
            y1 = Math.max(y1, prev);
          }
          ctx.fillRect(x - width / 2, y0 - width / 2, Math.max(col, width), y1 - y0 + width);
          prev = Math.max(0, Math.min(h, (y(a) + y(b)) / 2));
        }
      }
      ctx.globalAlpha = 1;

      // Live value at the right edge.
      const k = Math.max(0, k1 - 1);
      const a = tr.lo[k];
      const b = tr.hi[k];
      const band = b - a > 0.25 * (hi - lo);
      lane.values[j].textContent = format((a + b) / 2, probe.unit, !!spec.digital, band);
    });

    // Decoded bytes over the bits.
    if (spec.bytes) {
      ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const [t0, t1, kind, text] of region.events) {
        if (kind !== spec.bytes || t0 > tNow) continue;
        const x0 = (((t0 - region.t0) / rate - left) / screen) * w;
        const x1 = (((t1 - region.t0) / rate - left) / screen) * w;
        if (x1 < 0 || x1 - x0 < 14) continue;
        ctx.fillStyle = "rgba(255, 212, 59, 0.18)";
        ctx.fillRect(x0, 0, x1 - x0 - 1, 9);
        ctx.fillStyle = "#ffe066";
        ctx.fillText(text, (x0 + x1) / 2, 0);
      }
    }
  }
}
