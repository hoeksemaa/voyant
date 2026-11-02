import "./firmware.css";
import type { Bank, FieldDef, RegisterDef } from "../puzzle/types";
import { REGISTERS, STOCK, field, rejectReason } from "../puzzle/registers";

// Firmware editor: the register table of Cerelog stock V2, shown as the real C code.
// The user toggles bit digits, or types a byte into the field panel. Each accepted edit
// goes to onChange as a new bank. Locked registers show, but do not change.

export interface FirmwareOptions {
  onChange: (bank: Bank) => void;
  onSelect: (reg: RegisterDef) => void;
  onReset: () => void;
}

const MONO_CSS = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap";
const COMPACT_W = 520; // container width (px); below it (a phone), the field panel opens under the selected line
const TIP_DELAY = 500; // ms of hover before a tooltip opens
const UNDO_MS = 6000; // how long Reset stays as Undo
const CMT_COL = 23; // column where the right-hand comments start

// The table in the file's order (esp32s3_v2_firmware.ino, lines 395–401).
// -2: an entry that the write loop skips. zero: the file writes a plain 0, not a binary literal.
const TABLE: { addr: number; zero?: boolean }[] = [
  { addr: 0x01 },
  { addr: 0x02 },
  { addr: 0x03 },
  { addr: 0x04, zero: true },
  { addr: -2 },
  { addr: 0x05 },
  { addr: 0x06 },
  { addr: 0x07 },
  { addr: 0x08 },
  { addr: 0x09 },
  { addr: 0x0a },
  { addr: 0x0b },
  { addr: 0x0c },
  { addr: 0x0d },
  { addr: 0x0e },
  { addr: 0x0f, zero: true },
  { addr: 0x10, zero: true },
  { addr: 0x11, zero: true },
  { addr: -2 },
  { addr: 0x15 },
  { addr: 0x16, zero: true },
  { addr: 0x17, zero: true },
];

// The firmware's own comment on the MISC1 entry, word for word.
const MISC1_NOTE =
  "DO NOT EDIT 0x15 (MISC1) - use the montage switch on the PCB to select between SRB1 and differential mode. Modifying this value will stop the device from working.";

// Short meanings for the locked registers at their stock values.
const LOCKED_MEANING: Record<string, string> = {
  CONFIG2: "test signal: internal",
  LOFF: "lead-off: not used",
  LOFF_SENSP: "lead-off: no inputs",
  LOFF_SENSN: "lead-off: no inputs",
  LOFF_FLIP: "no flip",
  MISC1: "SRB1 open · PCB switch",
  MISC2: "reserved",
  CONFIG4: "continuous mode",
};

const DEF = new Map<number, RegisterDef>(REGISTERS.map((r) => [r.addr, r]));

const hex2 = (v: number): string => v.toString(16).toUpperCase().padStart(2, "0");
const bin8 = (v: number): string => v.toString(2).padStart(8, "0");
const bitOf = (v: number, b: number): number => (v >> b) & 1;
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const fieldAt = (def: RegisterDef, b: number): FieldDef | undefined =>
  def.fields.find((f) => b <= f.hi && b >= f.lo);
const spanText = (f: FieldDef): string => (f.hi === f.lo ? `bit ${f.hi}` : `bits ${f.hi}:${f.lo}`);

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function loadMonoFont(): void {
  if (document.querySelector(`link[href="${MONO_CSS}"]`)) return;
  const link = make("link");
  link.rel = "stylesheet";
  link.href = MONO_CSS;
  document.head.append(link);
}

/** Bits of a mask register as inputs, for example 0x0F → "IN1P–IN4P". */
function inputs(v: number, sign: string): string {
  const on: number[] = [];
  for (let n = 1; n <= 8; n++) if (bitOf(v, n - 1)) on.push(n);
  if (!on.length) return "none";
  const runs: string[] = [];
  for (let i = 0; i < on.length; ) {
    let j = i;
    while (j + 1 < on.length && on[j + 1] === on[j] + 1) j++;
    if (j - i >= 2) runs.push(`IN${on[i]}${sign}–IN${on[j]}${sign}`);
    else for (let k = i; k <= j; k++) runs.push(`IN${on[k]}${sign}`);
    i = j + 1;
  }
  return runs.join(", ");
}

const reservedWrong = (def: RegisterDef, v: number): boolean =>
  def.fields.some((f) => f.lock === "reserved" && field(v, f) !== f.required);

/**
 * The short meaning in the right-hand comment, as parts, most important first.
 * For example ["on", "×24", "electrode"]. A narrow panel drops parts from the end.
 */
function meaning(def: RegisterDef, v: number): string[] {
  const f = (prefix: string): FieldDef | undefined => def.fields.find((x) => x.name.startsWith(prefix));
  const n = (prefix: string): number => {
    const x = f(prefix);
    return x ? field(v, x) : 0;
  };
  const d = (prefix: string): string => {
    const x = f(prefix);
    return x ? x.decode(field(v, x)) : "";
  };
  let s: string[];
  switch (def.group) {
    case "CONFIG1":
      s = [n("DR") === 7 ? "DR 111: invalid" : d("DR")];
      break;
    case "CONFIG3":
      s = [
        n("PD_REFBUF") ? "ref on" : "ref off",
        n("BIASREF_INT") ? "BIASREF int" : "BIASREF ext",
        n("PD_BIAS") ? "bias on" : "bias off",
      ];
      break;
    case "CHnSET":
      s = [n("PD") ? "off" : "on", n("GAIN") === 7 ? "GAIN 111: invalid" : d("GAIN")];
      if (n("SRB2")) s.push("SRB2 closed");
      s.push(d("MUX"));
      break;
    case "BIAS_SENS":
      s = [`bias: ${inputs(v, def.name.endsWith("P") ? "P" : "N")}`];
      break;
    default:
      s = v === STOCK[def.addr] && LOCKED_MEANING[def.name] ? [LOCKED_MEANING[def.name]] : [];
  }
  if (reservedWrong(def, v)) s.unshift("reserved bits wrong");
  return s;
}

/** One line about a register, for the field panel. */
function about(def: RegisterDef): string {
  switch (def.group) {
    case "CONFIG1":
      return "Daisy mode, clock out, and data rate";
    case "CONFIG3":
      return "Reference buffer and bias drive";
    case "CHnSET":
      return `Channel ${def.name.charAt(2)}: power, gain, and input`;
    case "BIAS_SENS":
      return def.name.endsWith("P") ? "Positive inputs in the bias loop" : "Negative inputs in the bias loop";
    default:
      return def.note ?? "Locked in this puzzle";
  }
}

/** Why a bit does not toggle, or null when it can toggle. */
function lockReason(def: RegisterDef, b: number): string | null {
  if (def.group === null) return `${def.name} · ${def.note ?? "Locked in this puzzle"}`;
  const f = fieldAt(def, b);
  if (!f) return null;
  if (f.lock === "reserved") return `Reserved ${spanText(f)} · ${f.why ?? ""}`;
  if (f.lock === "fixed") return `${f.name} · ${f.why ?? "Locked"}`;
  return null;
}

/** The fields of a register, bit 7 first, plus unnamed runs for bits that no field covers. */
function segments(def: RegisterDef): FieldDef[] {
  const out: FieldDef[] = [];
  for (let b = 7; b >= 0; ) {
    const f = fieldAt(def, b);
    if (f) {
      out.push(f);
      b = f.lo - 1;
      continue;
    }
    let lo = b;
    while (lo - 1 >= 0 && !fieldAt(def, lo - 1)) lo--;
    out.push({ name: "", hi: b, lo, decode: () => "" });
    b = lo - 1;
  }
  return out;
}

interface Line {
  def: RegisterDef;
  row: HTMLElement;
  val: HTMLElement; // the value literal
  pad: Text; // spaces before the comment
  cmt: HTMLElement;
  digits: HTMLElement[]; // index = bit number; empty when the value shows as a plain 0
  zero: boolean;
  last: boolean;
  shown: number; // the value on screen; -1 before the first render
  full: string; // the full comment text; the line can show less when the panel is narrow
}

/** One tooltip for the editor: opens after a short hover, one layout for all items. */
class Tip {
  readonly el = make("div", "fw-tip");
  target: HTMLElement | null = null; // the item with the open tooltip
  pending: HTMLElement | null = null; // the item that waits for its tooltip
  private timer = 0;

  constructor() {
    this.el.setAttribute("role", "tooltip");
    document.body.append(this.el);
  }

  later(target: HTMLElement, html: () => string | null): void {
    this.cancel();
    this.pending = target;
    this.timer = window.setTimeout(() => this.now(target, html()), TIP_DELAY);
  }

  now(target: HTMLElement, html: string | null): void {
    this.cancel();
    if (!html || !target.isConnected) return this.hide();
    this.target = target;
    this.el.innerHTML = html;
    this.el.classList.add("on");
    const r = target.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  cancel(): void {
    window.clearTimeout(this.timer);
    this.pending = null;
  }

  hide(): void {
    this.cancel();
    this.target = null;
    this.el.classList.remove("on");
  }
}

export class FirmwareEditor {
  private readonly el = make("div", "fw");
  private readonly count = make("span", "fw-count");
  private readonly resetBtn = make("button", "fw-reset");
  private readonly body = make("div", "fw-body");
  private readonly pane = make("div", "fw-pane");
  private readonly insp = make("aside", "fw-insp");
  private readonly empty = make("div", "fw-empty");
  private readonly iname = make("b", "fw-iname");
  private readonly iaddr = make("span", "fw-iaddr");
  private readonly hex = make("input", "fw-hexin");
  private readonly revert = make("button", "fw-revert");
  private readonly msg = make("p", "fw-imsg");
  private readonly grid = make("div", "fw-grid");
  private readonly tip = new Tip();
  private readonly lines = new Map<number, Line>();
  private readonly order: number[] = []; // register addresses in table order
  private bank: Bank = STOCK.slice();
  private start: Bank = STOCK.slice();
  private sel: number | null = null;
  private compact = false;
  private placed = false; // the field panel has its first place
  private cols = Infinity; // characters that fit in a right-hand comment
  private readonly probe = make("span", "fw-probe", "0".repeat(20));
  private first = true;
  private undoBank: Bank | null = null;
  private undoTimer = 0;
  private msgTimer = 0;
  private hl: HTMLElement[] = [];
  private gridBits: { b: number; btn: HTMLElement; d: HTMLElement }[] = [];
  private gridRows: { f: FieldDef; val: HTMLElement }[] = [];

  constructor(
    root: HTMLElement,
    private readonly opts: FirmwareOptions,
  ) {
    loadMonoFont();
    this.el.tabIndex = 0;
    this.el.setAttribute("aria-label", "Firmware register table");

    const head = make("div", "fw-head");
    head.append(make("span", "fw-title", "Firmware"), this.count, this.resetBtn);
    this.resetBtn.type = "button";
    this.resetBtn.addEventListener("click", () => this.onResetClick());

    this.buildPane();
    this.buildInspector();
    this.body.append(this.pane, this.insp);
    this.el.append(head, this.body);
    root.append(this.el);

    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("pointerover", (e) => this.onOver(e));
    this.el.addEventListener("pointerout", (e) => this.onOut(e));
    this.pane.addEventListener("scroll", () => this.tip.hide(), { passive: true });
    window.addEventListener("scroll", () => this.tip.hide(), { passive: true });

    new ResizeObserver(() => this.layout()).observe(root);
    // The code font loads late. When it is in, measure the comment width again.
    document.fonts?.addEventListener("loadingdone", () => this.layout());
    this.render();
    this.layout();
  }

  /** Show a bank. start: the bank the puzzle started with (for change marks and Reset). */
  setBank(bank: Bank, start: Bank): void {
    const same = (a: Bank, b: Bank): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same(bank, this.bank) || !same(start, this.start)) this.endUndo();
    this.bank = bank.slice();
    this.start = start.slice();
    this.render();
  }

  /** Select a register by name and scroll its line into view. This does not call onSelect. */
  focus(name: string): void {
    const def = REGISTERS.find((r) => r.name === name);
    if (!def || !this.lines.has(def.addr)) return;
    this.select(def.addr, false, true);
    this.flash(this.lines.get(def.addr)!.row);
    this.el.focus({ preventScroll: true });
  }

  // ---- build ----

  private buildPane(): void {
    const text = (html: string, hang = 0, lead = 0): HTMLElement => {
      const row = make("div", "fw-line fw-text");
      const src = make("span", "fw-src");
      src.innerHTML = html;
      if (hang) {
        src.classList.add("wrap");
        src.style.paddingLeft = `${hang}ch`;
        src.style.textIndent = `${lead - hang}ch`;
      }
      row.append(make("span", "fw-gut"), src);
      return row;
    };
    this.pane.append(
      text(`<span class="fw-c">// esp32s3_v2_firmware.ino · Cerelog stock V2</span>`, 3),
      text(
        `<span class="fw-k">static const</span> <span class="fw-t">regVal_pair</span> <span class="fw-v">ADS1299_REGISTER_LS</span><span class="fw-p">[</span><span class="fw-v">size_reg_ls</span><span class="fw-p">] = {</span>`,
        4,
      ),
    );
    TABLE.forEach((t, i) => {
      const last = i === TABLE.length - 1;
      if (t.addr === 0x15) this.pane.append(text(`<span class="fw-c">// ${esc(MISC1_NOTE)}</span>`, 5, 2));
      if (t.addr < 0) {
        const row = text(
          `  <span class="fw-p">{</span><span class="fw-n">-2</span><span class="fw-p">, </span><span class="fw-n">-2</span><span class="fw-p">},</span>${" ".repeat(CMT_COL - 11)}`,
        );
        row.classList.add("fw-skip");
        row.append(make("span", "fw-cmt fw-c", "// the loop skips -2"));
        this.pane.append(row);
      } else this.pane.append(this.regLine(t.addr, !!t.zero, last));
    });
    this.pane.append(text(`<span class="fw-p">};</span>`), this.probe);
  }

  private regLine(addr: number, zero: boolean, last: boolean): HTMLElement {
    const def = DEF.get(addr)!;
    const row = make("div", `fw-line fw-reg ${def.group ? "fw-ed" : "fw-lk"}`);
    row.dataset.addr = String(addr);
    if (!def.group) row.dataset.tip = "line";
    const gut = make("span", "fw-gut");
    gut.dataset.tip = "dot";
    gut.append(make("i", "fw-dot"));
    const src = make("span", "fw-src");
    src.innerHTML = `  <span class="fw-p">{</span><span class="fw-n">0x${hex2(addr)}</span><span class="fw-p">, </span>`;
    const val = make("span", "fw-val");
    const pad = document.createTextNode("");
    src.append(val, make("span", "fw-p", last ? "}" : "},"), pad);
    const cmt = make("span", "fw-cmt fw-c");
    cmt.dataset.tip = "cmt";
    row.append(gut, src, cmt);
    this.lines.set(addr, { def, row, val, pad, cmt, digits: [], zero, last, shown: -1, full: "" });
    this.order.push(addr);
    return row;
  }

  private buildInspector(): void {
    const head = make("div", "fw-ihead");
    const title = make("div", "fw-ititle");
    title.append(this.iname, this.iaddr);
    const hexWrap = make("label", "fw-hex");
    hexWrap.append(make("span", "", "0x"), this.hex);
    this.hex.maxLength = 2;
    this.hex.spellcheck = false;
    this.hex.autocomplete = "off";
    this.hex.setAttribute("autocapitalize", "characters");
    this.hex.setAttribute("enterkeyhint", "done");
    this.hex.setAttribute("aria-label", "Register value in hex");
    this.hex.addEventListener("keydown", (e) => this.onHexKey(e));
    this.hex.addEventListener("focus", () => this.hex.select());
    this.hex.addEventListener("blur", () => this.showHex());
    this.hex.addEventListener("input", () => {
      this.hex.value = this.hex.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    });
    this.revert.type = "button";
    this.revert.dataset.tip = "revert";
    this.revert.addEventListener("click", () => {
      if (this.sel !== null) this.commit(this.sel, this.start[this.sel]);
    });
    head.append(title, hexWrap, this.revert);
    // Before the first selection: how to use the editor.
    this.empty.innerHTML = `<p>Click a register line to see its fields.</p>
      <ul>
        <li><span class="fw-key ed">1</span>Orange bits toggle on click.</li>
        <li><span class="fw-key rsv">1</span>Grey bits are reserved or locked.</li>
        <li><span class="fw-key">↑</span><span class="fw-key">↓</span>Select a line.</li>
        <li><span class="fw-key">0</span>–<span class="fw-key">7</span>Toggle that bit.</li>
        <li><span class="fw-key">Enter</span>Type the byte in hex.</li>
      </ul>`;
    this.insp.append(this.empty, head, this.msg, this.grid);
  }

  // ---- render ----

  private layout(): void {
    const w = this.el.parentElement?.clientWidth ?? this.el.clientWidth;
    const compact = w > 0 && w < COMPACT_W;
    if (compact !== this.compact || !this.placed) {
      this.compact = compact;
      this.placed = true;
      this.el.classList.toggle("compact", compact);
      this.placeInspector();
    }
    // The code is monospace, so one width gives the number of characters in a comment.
    const cw = this.probe.getBoundingClientRect().width / 20;
    const line = this.lines.get(this.order[0]);
    const cmtW = line?.cmt.clientWidth ?? 0;
    const cols = cw > 0 && cmtW > 0 ? Math.floor(cmtW / cw) : Infinity;
    if (cols === this.cols) return;
    this.cols = cols;
    for (const l of this.lines.values()) this.fitComment(l);
  }

  /** Put the comment on a line: the name and hex always, then the meaning parts that fit. */
  private fitComment(line: Line): void {
    const v = this.bank[line.def.addr];
    const head = `// ${line.def.name} · ${hex2(v)}`;
    let tail = "";
    let full = head;
    let room = true;
    for (const part of meaning(line.def, v)) {
      full += ` · ${part}`;
      if (room && head.length + tail.length + part.length + 3 <= this.cols) tail += ` · ${part}`;
      else room = false;
    }
    line.full = full;
    line.cmt.innerHTML = `// <b>${esc(line.def.name)}</b> · ${hex2(v)}${esc(tail)}`;
    line.cmt.classList.toggle("cut", tail.length < full.length - head.length);
  }

  private placeInspector(): void {
    if (this.compact && this.sel !== null) this.lines.get(this.sel)!.row.after(this.insp);
    else if (this.insp.parentElement !== this.body || this.insp.previousElementSibling !== this.pane)
      this.body.append(this.insp);
    this.insp.hidden = this.compact && this.sel === null;
  }

  private render(): void {
    for (const line of this.lines.values()) this.renderLine(line);
    const n = this.order.filter((a) => this.bank[a] !== this.start[a]).length;
    this.count.textContent = n ? `${n} changed` : "";
    this.resetBtn.textContent = this.undoBank ? "Undo" : "Reset";
    this.resetBtn.disabled = !this.undoBank && n === 0;
    this.resetBtn.classList.toggle("undo", !!this.undoBank);
    this.renderInspector();
    this.first = false;
  }

  private renderLine(line: Line): void {
    const { def } = line;
    const v = this.bank[def.addr];
    const s = this.start[def.addr];
    const plain = line.zero && v === 0;
    if (plain !== (line.digits.length === 0) || line.shown < 0) this.buildVal(line, plain);
    line.digits.forEach((d, b) => {
      const bit = bitOf(v, b);
      d.textContent = String(bit);
      d.classList.toggle("chg", bit !== bitOf(s, b));
      const f = fieldAt(def, b);
      d.classList.toggle("bad", f?.lock === "reserved" && field(v, f) !== f.required);
      if (!this.first && line.shown >= 0 && bit !== bitOf(line.shown, b)) this.flash(d);
    });
    const len = 2 + 1 + 4 + 2 + (plain ? 1 : 10) + (line.last ? 1 : 2);
    line.pad.data = " ".repeat(Math.max(1, CMT_COL - len));
    this.fitComment(line);
    line.row.classList.toggle("chg", v !== s);
    line.shown = v;
  }

  private buildVal(line: Line, plain: boolean): void {
    line.val.textContent = "";
    line.digits = [];
    if (plain) {
      line.val.append(make("span", "fw-n", "0"));
      return;
    }
    line.val.append(make("span", "fw-bp", "0b"));
    const ds: HTMLElement[] = [];
    for (let b = 7; b >= 0; b--) {
      const d = make("span", "fw-b");
      d.dataset.bit = String(b);
      if (line.def.group) {
        d.dataset.tip = "bit";
        d.classList.add(lockReason(line.def, b) ? "rsv" : "ed");
      }
      ds[b] = d;
      line.val.append(d);
    }
    line.digits = ds;
  }

  private renderInspector(): void {
    const has = this.sel !== null;
    this.insp.classList.toggle("none", !has);
    this.empty.hidden = has;
    if (!has) {
      this.grid.textContent = "";
      delete this.grid.dataset.addr;
      return;
    }
    const addr = this.sel!;
    const def = DEF.get(addr)!;
    const v = this.bank[addr];
    const s = this.start[addr];
    this.insp.dataset.addr = String(addr);
    this.insp.classList.toggle("locked", !def.group);
    this.iname.textContent = def.name;
    this.iaddr.textContent = `${hex2(addr)}h`;
    this.hex.disabled = !def.group;
    if (document.activeElement !== this.hex) this.showHex();
    this.revert.hidden = v === s || !def.group;
    this.revert.textContent = `↺ ${hex2(s)}`;
    if (!this.msg.classList.contains("say")) this.msg.textContent = about(def);

    if (this.grid.dataset.addr !== String(addr)) this.buildGrid(def);
    this.updateGrid(v, s);
  }

  /**
   * The byte strip (8 keys, bit 7 on the left, grouped by field, as in the datasheet figure)
   * and the field list (bits, name, meaning).
   */
  private buildGrid(def: RegisterDef): void {
    const g = this.grid;
    g.textContent = "";
    g.dataset.addr = String(def.addr);
    this.gridBits = [];
    this.gridRows = [];
    const byte = make("div", "fw-byte");
    const list = make("div", "fw-flist");
    for (const f of segments(def)) {
      const grp = make("div", "fw-fgroup");
      grp.style.flexGrow = String(f.hi - f.lo + 1);
      grp.dataset.hi = String(f.hi);
      for (let b = f.hi; b >= f.lo; b--) {
        const btn = make("button", `fw-bit ${lockReason(def, b) || !f.name ? "rsv" : "ed"}`);
        btn.type = "button";
        btn.tabIndex = -1;
        btn.dataset.bit = String(b);
        if (f.name) btn.dataset.tip = "bit";
        btn.setAttribute("aria-label", `Bit ${b}`);
        const d = make("span", "fw-d");
        btn.append(make("i", "", String(b)), d);
        grp.append(btn);
        this.gridBits.push({ b, btn, d });
      }
      byte.append(grp);
      if (!f.name) continue;
      const row = make("div", `fw-frow${f.lock ? ` ${f.lock}` : ""}`);
      row.dataset.hi = String(f.hi);
      const val = make("span", "fw-fval");
      row.append(make("span", "fw-fspan", f.hi === f.lo ? `${f.hi}` : `${f.hi}:${f.lo}`), make("span", "fw-fname", f.name), val);
      list.append(row);
      this.gridRows.push({ f, val });
    }
    g.append(byte, list);
  }

  private updateGrid(v: number, s: number): void {
    const def = this.sel === null ? undefined : DEF.get(this.sel);
    for (const { b, btn, d } of this.gridBits) {
      const bit = String(bitOf(v, b));
      if (d.textContent !== bit) {
        if (d.textContent) this.flash(btn);
        d.textContent = bit;
      }
      btn.classList.toggle("chg", bitOf(v, b) !== bitOf(s, b));
      const f = def && fieldAt(def, b);
      btn.classList.toggle("bad", f?.lock === "reserved" && field(v, f) !== f.required);
    }
    for (const { f, val } of this.gridRows) {
      const fv = field(v, f);
      if (f.lock === "reserved") {
        const want = (f.required ?? 0).toString(2).padStart(f.hi - f.lo + 1, "0");
        val.textContent = fv === f.required ? `must be ${want}` : `wrong value: must be ${want}`;
      } else val.textContent = f.decode(fv);
      val.classList.toggle("bad", f.lock === "reserved" && fv !== f.required);
    }
  }

  private showHex(): void {
    if (this.sel !== null) this.hex.value = hex2(this.bank[this.sel]);
  }

  private flash(e: HTMLElement): void {
    e.classList.remove("flip");
    void e.offsetWidth;
    e.classList.add("flip");
  }

  /** A short message in the field panel; it goes back to the register line after a few seconds. */
  private say(text: string, kind: "err" | "info"): void {
    window.clearTimeout(this.msgTimer);
    this.msg.textContent = text;
    this.msg.className = `fw-imsg say ${kind}`;
    this.msgTimer = window.setTimeout(() => this.unsay(), 5000);
  }

  private unsay(): void {
    window.clearTimeout(this.msgTimer);
    this.msg.className = "fw-imsg";
    if (this.sel !== null) this.msg.textContent = about(DEF.get(this.sel)!);
  }

  // ---- edits ----

  private select(addr: number | null, notify: boolean, center = false): void {
    if (this.sel !== null) this.lines.get(this.sel)?.row.classList.remove("sel");
    const moved = addr !== this.sel;
    this.sel = addr;
    if (addr !== null) this.lines.get(addr)!.row.classList.add("sel");
    if (moved) this.unsay();
    this.renderInspector();
    this.placeInspector();
    if (addr !== null) this.reveal(addr, center);
    if (notify && addr !== null) this.opts.onSelect(DEF.get(addr)!);
  }

  private reveal(addr: number, center: boolean): void {
    const row = this.lines.get(addr)!.row;
    if (this.compact) {
      // The page scrolls on a phone: keep the line and its field panel on screen.
      const target = center ? row : this.insp;
      requestAnimationFrame(() =>
        target.scrollIntoView({ block: center ? "center" : "nearest", behavior: "smooth" }),
      );
      return;
    }
    const r = row.getBoundingClientRect();
    const p = this.pane.getBoundingClientRect();
    if (r.top < p.top + 4) this.pane.scrollTop -= p.top + 4 - r.top;
    else if (r.bottom > p.bottom - 4) this.pane.scrollTop += r.bottom - p.bottom + 4;
  }

  private toggle(addr: number, b: number): void {
    const def = DEF.get(addr)!;
    const why = lockReason(def, b);
    if (why) {
      this.say(why, "info");
      return;
    }
    this.commit(addr, this.bank[addr] ^ (1 << b));
  }

  private commit(addr: number, v: number): void {
    if (this.bank[addr] === v) return;
    this.endUndo();
    const next = this.bank.slice();
    next[addr] = v;
    this.bank = next;
    this.unsay();
    this.render();
    this.refreshTip();
    this.opts.onChange(next.slice());
  }

  private applyHex(): void {
    if (this.sel === null) return;
    const def = DEF.get(this.sel)!;
    const raw = this.hex.value.trim();
    const v = /^[0-9a-f]{1,2}$/i.test(raw) ? parseInt(raw, 16) : NaN;
    const why = def.group ? rejectReason(def, this.bank[this.sel], v) : (def.note ?? "Locked");
    if (why) {
      this.say(why, "err");
      this.hex.select();
      return;
    }
    this.commit(this.sel, v);
    this.showHex();
    this.hex.select();
  }

  private onResetClick(): void {
    if (this.undoBank) {
      const b = this.undoBank;
      this.endUndo();
      this.bank = b.slice();
      this.render();
      this.opts.onChange(b.slice());
      return;
    }
    if (this.order.every((a) => this.bank[a] === this.start[a])) return;
    this.undoBank = this.bank.slice();
    this.bank = this.start.slice();
    this.unsay();
    this.render();
    this.opts.onReset();
    this.undoTimer = window.setTimeout(() => {
      this.undoBank = null;
      this.render();
    }, UNDO_MS);
  }

  private endUndo(): void {
    window.clearTimeout(this.undoTimer);
    if (!this.undoBank) return;
    this.undoBank = null;
    this.resetBtn.textContent = "Reset";
    this.resetBtn.classList.remove("undo");
  }

  // ---- events ----

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const ibit = t.closest<HTMLElement>(".fw-bit");
    if (ibit && this.sel !== null) {
      this.toggle(this.sel, Number(ibit.dataset.bit));
      if (ibit.classList.contains("rsv")) this.tip.now(ibit, this.tipHtml(ibit));
      return;
    }
    const row = t.closest<HTMLElement>(".fw-reg");
    if (!row) return;
    const addr = Number(row.dataset.addr);
    this.el.focus({ preventScroll: true });
    const digit = this.compact ? null : t.closest<HTMLElement>(".fw-b");
    if (digit && DEF.get(addr)!.group) {
      if (addr !== this.sel) this.select(addr, true);
      this.toggle(addr, Number(digit.dataset.bit));
      if (digit.classList.contains("rsv")) this.tip.now(digit, this.tipHtml(digit));
      return;
    }
    // On a phone, a tap on the open line closes its field panel.
    if (this.compact && addr === this.sel) this.select(null, false);
    else this.select(addr, true);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target === this.hex || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = this.sel === null ? -1 : this.order.indexOf(this.sel);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const j = i < 0 ? (step > 0 ? 0 : this.order.length - 1) : Math.min(this.order.length - 1, Math.max(0, i + step));
      if (j !== i) this.select(this.order[j], true);
      return;
    }
    if (/^[0-7]$/.test(e.key) && this.sel !== null) {
      e.preventDefault();
      this.toggle(this.sel, Number(e.key));
      return;
    }
    if (e.key === "Enter" && this.sel !== null && !this.hex.disabled) {
      e.preventDefault();
      this.hex.focus();
    }
  }

  private onHexKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      this.applyHex();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.unsay();
      this.showHex();
      this.el.focus({ preventScroll: true });
    }
  }

  private onOver(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    this.highlight(t.closest<HTMLElement>("[data-bit], .fw-frow[data-hi], .fw-fgroup"));
    if (e.pointerType === "touch") return;
    const tipEl = t.closest<HTMLElement>("[data-tip]");
    if (!tipEl || tipEl === this.tip.target || tipEl === this.tip.pending) return;
    if (this.tip.target) this.tip.hide();
    this.tip.later(tipEl, () => this.tipHtml(tipEl));
  }

  private onOut(e: PointerEvent): void {
    const to = e.relatedTarget as HTMLElement | null;
    const from = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (from && to && from.contains(to)) return;
    if (!to?.closest("[data-bit], .fw-frow[data-hi]")) this.highlight(null);
    this.tip.hide();
  }

  /** Mark one field in all places: the code digits, the byte strip, and the field list. */
  private highlight(t: HTMLElement | null): void {
    for (const e of this.hl) e.classList.remove("hl");
    this.hl = [];
    const host = t?.closest<HTMLElement>("[data-addr]");
    if (!t || !host) return;
    const addr = Number(host.dataset.addr);
    const def = DEF.get(addr);
    const b = t.dataset.bit !== undefined ? Number(t.dataset.bit) : Number(t.dataset.hi);
    const f = def && fieldAt(def, b);
    if (!def || !def.group || !f) return;
    const line = this.lines.get(addr);
    for (let i = f.lo; i <= f.hi; i++) if (line?.digits[i]) this.hl.push(line.digits[i]);
    if (addr === this.sel) {
      this.hl.push(...this.grid.querySelectorAll<HTMLElement>(`[data-hi="${f.hi}"]`));
    }
    for (const e of this.hl) e.classList.add("hl");
  }

  private refreshTip(): void {
    const t = this.tip.target;
    if (t) this.tip.now(t, this.tipHtml(t));
  }

  private lockedTip(def: RegisterDef): string {
    return `<b>${esc(def.name)}</b> · locked<span class="m">${esc(def.note ?? "")}</span>`;
  }

  private tipHtml(t: HTMLElement): string | null {
    const host = t.closest<HTMLElement>("[data-addr]");
    const addr = Number(host?.dataset.addr ?? this.sel);
    const def = DEF.get(addr);
    if (!def) return null;
    const v = this.bank[addr];
    const s = this.start[addr];
    switch (t.dataset.tip) {
      case "bit": {
        const b = Number(t.dataset.bit);
        const f = fieldAt(def, b);
        if (!f) return null;
        const why = lockReason(def, b);
        const lead = f.lock === "reserved" ? `Reserved · ${spanText(f)}` : `<b>${esc(f.name)}</b> · ${spanText(f)}`;
        const dec = f.lock === "reserved" ? "" : `<br>${esc(f.decode(field(v, f)))}`;
        const tail = why ? `<span class="m">${esc(why.slice(why.indexOf("·") + 2))}</span>` : "";
        return `${lead}${dec}${tail}`;
      }
      case "line":
        return this.lockedTip(def);
      case "dot":
        return v === s ? null : `Changed. Start value: <code>0b${bin8(s)}</code> (${hex2(s)}h)`;
      case "revert":
        return `Set ${esc(def.name)} back to its start value, ${hex2(s)}h`;
      case "cmt": {
        // A cut comment shows in full. On a locked line, the lock reason comes first.
        const line = this.lines.get(addr);
        const cut = t.classList.contains("cut") || t.scrollWidth > t.clientWidth + 1;
        const full = cut && line ? `<code>${esc(line.full)}</code>` : "";
        if (!def.group) return `${this.lockedTip(def)}${full ? `<span class="m">${full}</span>` : ""}`;
        return full || null;
      }
    }
    return null;
  }
}
