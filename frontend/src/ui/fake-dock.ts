import { REGISTERS } from "../puzzle/registers";
import type { Bank, Clip, RegisterDef } from "../puzzle/types";
import "./fake-dock.css";

// Stand-ins for the firmware editor and the datasheet viewer (firmware.ts, datasheet.ts).
// Same interfaces as the real ones, so the shell can lay out the dock. The integrator swaps them.

export interface FirmwareOptions {
  onChange: (bank: Bank) => void;
  onSelect: (reg: RegisterDef) => void;
  onReset: () => void;
}

const hex = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");

export class FirmwareEditor {
  private list = document.createElement("div");
  private bank: Bank = [];
  private start: Bank = [];

  constructor(
    root: HTMLElement,
    private opts: FirmwareOptions,
  ) {
    root.classList.add("fake-fw");
    const head = document.createElement("div");
    head.className = "fake-head";
    head.innerHTML = `<b>Firmware</b><span>esp32s3_v2_firmware.ino</span>`;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.addEventListener("click", () => opts.onReset());
    head.append(reset);
    this.list.className = "fake-code";
    root.append(head, this.list);
  }

  setBank(bank: Bank, start: Bank): void {
    this.bank = bank.slice();
    this.start = start;
    this.list.replaceChildren(...REGISTERS.map((r) => this.line(r)));
  }

  focus(name: string): void {
    const row = this.list.querySelector<HTMLElement>(`[data-reg="${name}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }

  private line(r: RegisterDef): HTMLElement {
    const v = this.bank[r.addr];
    const row = document.createElement("div");
    row.className = "fake-line";
    row.dataset.reg = r.name;
    if (!r.group) row.classList.add("locked");
    if (v !== this.start[r.addr]) row.classList.add("changed");
    const bin = v.toString(2).padStart(8, "0");
    row.innerHTML = `<code>{0x${hex(r.addr)}, 0b${bin}},</code><span class="fake-cmt">// ${r.name} ${hex(v)}</span>`;
    if (r.group) {
      const input = document.createElement("input");
      input.value = hex(v);
      input.maxLength = 2;
      input.spellcheck = false;
      input.setAttribute("aria-label", `${r.name} hex value`);
      input.addEventListener("change", () => {
        const next = parseInt(input.value, 16);
        if (!Number.isInteger(next) || next < 0 || next > 255) return;
        const b = this.bank.slice();
        b[r.addr] = next;
        this.opts.onChange(b);
        this.setBank(b, this.start);
      });
      row.append(input);
    }
    row.addEventListener("click", () => this.opts.onSelect(r));
    return row;
  }
}

export class DatasheetViewer {
  private tabs = document.createElement("div");
  private img = document.createElement("img");
  private link = document.createElement("a");

  constructor(
    root: HTMLElement,
    private clips: Clip[],
    private pdfUrl: string,
  ) {
    root.classList.add("fake-ds");
    this.tabs.className = "fake-tabs";
    for (const c of clips) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c.title;
      b.dataset.id = c.id;
      b.addEventListener("click", () => this.show(c.id));
      this.tabs.append(b);
    }
    this.link.target = "_blank";
    this.link.rel = "noopener";
    this.tabs.append(this.link);
    this.img.alt = "";
    root.append(this.tabs, this.img);
    this.show("map");
  }

  show(target: string): void {
    const c = this.clips.find((x) => x.id === target) ?? this.clips.find((x) => x.group === target);
    if (!c) return;
    this.img.src = c.file;
    this.img.alt = c.caption;
    this.link.href = `${this.pdfUrl}#page=${c.page}`;
    this.link.textContent = `p. ${c.page} ↗`;
    for (const b of this.tabs.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("on", b.dataset.id === c.id);
  }
}
