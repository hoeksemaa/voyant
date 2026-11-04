import { STOCK } from "./puzzle/registers";
import { SETUPS } from "./puzzle/setups";
import type { Bank, MatchResult, RegisterDef, Setup, SetupId } from "./puzzle/types";
import { Board } from "./ui/board";
import { Book } from "./ui/book";
import { Cards } from "./ui/cards";
import type { Box, ChipStage } from "./ui/chip-stage";
import { DatasheetViewer, FirmwareEditor } from "./ui/dock-api";
import { CLIPS, PDF_URL, match, simulate, targetFor, usedChannels } from "./ui/sim-api";
import { load, save } from "./ui/state";
import "./style.css";

// The register puzzle. Three hardware setups; each starts from Cerelog stock V2 firmware.
// Edit the registers until the chip's output matches the target. A green check marks a solved setup.

const state = load();
const byId = (id: SetupId): Setup => SETUPS.find((s) => s.id === id)!;
let setup = byId(state.current);
const bank = (): Bank => state.setups[setup.id].bank;

const boardEl = document.getElementById("board")!;
const board = new Board(boardEl, {
  onFocus: focusReg,
  onHot: (ch) => {
    board.setHot(ch);
    chip?.setHot(ch);
  },
  onLayout: () => chip?.requestRender(),
});
const cards = new Cards(document.getElementById("cards")!, focusReg);
const editor = new FirmwareEditor(document.getElementById("firmware")!, {
  onChange: (b) => {
    state.setups[setup.id].bank = b.slice();
    save(state);
    schedule();
  },
  onSelect: (reg: RegisterDef) => datasheet.show(reg.name),
  onReset: () => {
    state.setups[setup.id].bank = STOCK.slice();
    save(state);
    editor.setBank(bank(), STOCK);
    run();
  },
});
const datasheet = new DatasheetViewer(document.getElementById("datasheet")!, CLIPS, PDF_URL);
// The datasheet stays closed behind the book icon. It follows the selected register, so it
// opens on the right clip.
new Book(
  document.querySelector<HTMLButtonElement>(".book-toggle")!,
  document.getElementById("book")!,
  document.getElementById("datasheet")!,
  PDF_URL,
);

// A flag or a row tag points at a register: select it in the editor and in the datasheet.
function focusReg(name: string): void {
  editor.focus(name);
  datasheet.show(name);
}

// Setup tabs.
const CHECK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 L8.6 13.4 L14.5 7.2"/></svg>`;
const tabs = SETUPS.map((s) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tab";
  b.setAttribute("role", "tab");
  b.dataset.id = s.id;
  b.innerHTML = `<span class="check">${CHECK}</span><span class="tab-text"><b>${s.name}</b><span>${s.detail}</span></span>`;
  b.addEventListener("click", () => open(s.id));
  document.querySelector(".tabs")!.append(b);
  return b;
});

function paintTabs(): void {
  for (const b of tabs) {
    const id = b.dataset.id as SetupId;
    const solved = state.setups[id].solved;
    b.setAttribute("aria-selected", String(id === setup.id));
    b.classList.toggle("solved", solved);
    b.title = solved ? `${byId(id).name}: solved` : byId(id).name;
  }
}

function open(id: SetupId): void {
  setup = byId(id);
  state.current = id;
  save(state);
  history.replaceState(null, "", `#${id}`);
  const target = targetFor(setup);
  board.setSetup(setup, target);
  cards.setSetup(setup, target);
  editor.setBank(bank(), STOCK);
  paintTabs();
  run();
  chip?.setLinks(board.links(), board.litPins());
}

// Simulate, compare, and draw. Edits come fast (a click per bit), so wait ~30 ms for the last one.
let timer = 0;
function schedule(): void {
  clearTimeout(timer);
  timer = window.setTimeout(run, 30);
}

function run(): void {
  clearTimeout(timer);
  const sim = simulate(setup, bank());
  const m = match(sim, targetFor(setup), usedChannels(setup));
  board.setResult(sim, m, bank());
  cards.setResult(sim, m, bank());
  paintMini(m);
  const s = state.setups[setup.id];
  if (m.pass && !s.solved) {
    s.solved = true;
    save(state);
    paintTabs();
    const tab = tabs.find((b) => b.dataset.id === setup.id)!;
    tab.classList.add("just-solved");
    setTimeout(() => tab.classList.remove("just-solved"), 900);
  }
}

// Phone: the output cards are far above the firmware. While they are out of view, a small
// pill at the bottom shows the match (one dot per channel). A tap on it scrolls up to the cards.
const cardsEl = document.getElementById("cards")!;
const mini = document.createElement("button");
mini.type = "button";
mini.className = "mini-score";
mini.hidden = true;
mini.setAttribute("aria-label", "Go to the output");
mini.addEventListener("click", () => cardsEl.scrollIntoView({ behavior: "smooth", block: "start" }));
document.body.append(mini);
let cardsInView = true;
// "In view": the cards reach into the band under the sticky tabs, down to 60% of the screen height.
new IntersectionObserver(
  ([e]) => {
    cardsInView = e.isIntersecting;
    mini.hidden = cardsInView;
  },
  { rootMargin: "-80px 0px -40% 0px" },
).observe(cardsEl);

function paintMini(m: MatchResult): void {
  const used = m.channels.filter((c) => m.used.includes(c.ch));
  const dots = used.map((c) => `<i class="${c.pass ? "ok" : ""}"></i>`).join("");
  const passed = used.filter((c) => c.pass).length;
  mini.classList.toggle("good", m.pass);
  mini.innerHTML = `<span class="mini-dots">${dots}</span><span>${m.pass ? "Solved" : `${passed} / ${used.length} match`}</span><span class="mini-up">↑</span>`;
  mini.hidden = cardsInView;
}

// The 3D chip: desktop only. Phones never load three.js or make a WebGL context.
const desk = matchMedia("(min-width: 1100px)");
let chip: ChipStage | null = null;
let loading = false;

function region(pins: boolean): Box {
  const b = boardEl.getBoundingClientRect();
  if (pins) return { left: b.left, top: b.top, width: b.width, height: b.height };
  const c = board.chipBox.getBoundingClientRect();
  return { left: c.left, top: b.top, width: c.width, height: b.height };
}

async function layout(): Promise<void> {
  document.body.classList.toggle("desk", desk.matches);
  if (!desk.matches) {
    if (chip?.pins) setPins(false);
    return;
  }
  if (chip || loading) return;
  loading = true;
  const { ChipStage } = await import("./ui/chip-stage");
  chip = new ChipStage(document.getElementById("stage")!, region);
  chip.setLinks(board.links(), board.litPins());
}
desk.addEventListener("change", () => void layout());
window.addEventListener("resize", () => chip?.resize());

// Pin view: the board fades, and the chip fills the space with every pin named.
const pinsButton = document.querySelector<HTMLButtonElement>(".pins-toggle")!;
function setPins(on: boolean): void {
  if (!chip) return;
  pinsButton.setAttribute("aria-pressed", String(on));
  chip.setPins(on);
}
pinsButton.addEventListener("click", () => setPins(!chip?.pins));
window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
  if (e.key === "p" || e.key === "P") setPins(!chip?.pins);
  else if (e.key === "Escape" && chip?.pins) setPins(false);
});

// A link to #eeg, #eog, or #emg opens that setup.
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (SETUPS.some((s) => s.id === id) && id !== setup.id) open(id as SetupId);
});

open(setup.id);
void layout();
