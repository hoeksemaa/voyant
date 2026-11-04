import { bodyFor } from "./puzzle/body";
import { STOCK } from "./puzzle/registers";
import { SETUPS } from "./puzzle/setups";
import type { MatchResult, RegisterDef, Setup, SetupId, SimResult } from "./puzzle/types";
import { AnimView } from "./ui/anim";
import { Clock } from "./ui/clock";
import { DatasheetViewer, FirmwareEditor } from "./ui/dock-api";
import { Home } from "./ui/home";
import { LevelView } from "./ui/level";
import { Sheet, closeAll } from "./ui/sheet";
import { CLIPS, PDF_URL, match, simulate, targetFor, usedChannels } from "./ui/sim-api";
import { load, save } from "./ui/state";
import { Strip } from "./ui/strip";
import { showWin } from "./ui/win";
import "./style.css";

// The register puzzle as a phone game: a home screen with three levels (EMG, EOG, EEG), and one
// screen per level. Each level starts from Cerelog stock V2 firmware; edit the registers until
// the chip's output matches the target. Tools open as full-screen sheets; Pins grows the level's
// own chip to fill the screen.

const state = load();
const byId = (id: SetupId): Setup => SETUPS.find((s) => s.id === id)!;
let setup: Setup | null = null;
let lastSim: SimResult | null = null;
const bank = () => state.setups[setup!.id].bank;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const homeEl = $("#home");
const levelEl = $("#level");

// ---- home ----
const home = new Home(homeEl, $("#home-hero"), SETUPS, (id) => go(id));

// ---- level ----
const clock = new Clock();
const level = new LevelView(focusReg);
$("#flow-host").append(level.el);
let offPlayhead: (() => void) | null = null;

// ---- sheets ----
const strip = new Strip();
const fwHost = document.createElement("div");
fwHost.className = "fw-host";
const fwSheet = new Sheet({
  title: "Firmware",
  onOpen: () => {
    fwButton.classList.remove("nudge");
    sessionStorage.setItem("fw-seen", "1");
  },
});
fwSheet.root.classList.add("sheet-fw");
fwSheet.body.append(strip.el, fwHost);
const dsJump = document.createElement("button");
dsJump.type = "button";
dsJump.className = "sheet-link";
dsJump.textContent = "Datasheet";
dsJump.addEventListener("click", () => dsSheet.open());
fwSheet.tools.append(dsJump);

const editor = new FirmwareEditor(fwHost, {
  onChange: (b) => {
    state.setups[setup!.id].bank = b.slice();
    save(state);
    schedule();
  },
  onSelect: (reg: RegisterDef) => {
    datasheet.show(reg.name);
    dsJump.textContent = `${reg.name} in the datasheet`;
  },
  onReset: () => {
    state.setups[setup!.id].bank = STOCK.slice();
    save(state);
    editor.setBank(bank(), STOCK);
    run();
  },
});

const dsSheet = new Sheet({ title: "Datasheet", wide: true });
dsSheet.root.classList.add("sheet-ds");
const datasheet = new DatasheetViewer(dsSheet.body, CLIPS, PDF_URL);
const pdf = document.createElement("a");
pdf.className = "sheet-link";
pdf.href = PDF_URL;
pdf.target = "_blank";
pdf.rel = "noopener";
pdf.textContent = "Full PDF ↗";
dsSheet.tools.append(pdf);

const anim = new AnimView(clock);
let animStale = true;
const animSheet = new Sheet({
  title: "Animation",
  onOpen: () => {
    if (animStale && lastSim) anim.setAnalog(lastSim.analog);
    animStale = false;
    anim.start();
  },
  onClose: () => anim.stop(),
});
animSheet.root.classList.add("sheet-anim");
animSheet.body.append(anim.el);

// ---- toolbar ----
const fwButton = $<HTMLButtonElement>('.toolbar [data-act="firmware"]');
const pinsButton = $<HTMLButtonElement>('.toolbar [data-act="pins"]');
pinsButton.setAttribute("aria-pressed", "false");
function setPins(on: boolean, instant = false): void {
  level.setPins(on, instant);
  pinsButton.classList.toggle("on", level.pinsOn);
  pinsButton.setAttribute("aria-pressed", String(level.pinsOn));
}
const actions: Record<string, () => void> = {
  home: () => goHome(),
  pins: () => setPins(!level.pinsOn),
  datasheet: () => dsSheet.toggle(),
  firmware: () => fwSheet.toggle(),
  anim: () => animSheet.toggle(),
};
for (const b of document.querySelectorAll<HTMLButtonElement>(".toolbar [data-act]")) {
  b.addEventListener("click", () => actions[b.dataset.act!]());
}
window.addEventListener("keydown", (e) => {
  if (levelEl.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  // Esc puts the pins away, after any open sheet (the sheet takes the key first) or the win card.
  const sheetOpen = document.body.classList.contains("sheet-open");
  if (e.key === "Escape" && level.pinsOn && !e.defaultPrevented && !sheetOpen && !document.querySelector(".win")) {
    e.preventDefault();
    setPins(false);
    return;
  }
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable]")) return;
  const key = { h: "home", p: "pins", d: "datasheet", f: "firmware", a: "anim" }[e.key.toLowerCase()];
  if (key && !(key !== "home" && document.querySelector(".win"))) {
    e.preventDefault();
    actions[key]();
  }
});

// A flag or a row tag points at a register: open the firmware there.
function focusReg(name: string): void {
  fwSheet.open();
  editor.focus(name);
  datasheet.show(name);
}

// ---- screens ----
function go(id: SetupId): void {
  if (location.hash !== `#${id}`) location.hash = id;
  else route();
}

function goHome(): void {
  history.pushState(null, "", location.pathname + location.search);
  route();
}

function route(): void {
  const id = location.hash.slice(1);
  if (SETUPS.some((s) => s.id === id)) openLevel(id as SetupId);
  else openHome();
}
window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);

function openHome(): void {
  closeAll();
  setPins(false, true);
  document.querySelector(".win")?.remove();
  offPlayhead?.();
  offPlayhead = null;
  levelEl.hidden = true;
  document.body.dataset.screen = "home";
  document.title = "Can you crack the ADS1299?";
  for (const s of SETUPS) home.setSolved(s.id, state.setups[s.id].solved);
  home.show();
}

function openLevel(id: SetupId): void {
  closeAll();
  setPins(false, true);
  home.hide();
  setup = byId(id);
  state.current = id;
  save(state);
  levelEl.hidden = false;
  document.body.dataset.screen = "level";
  document.title = `${setup.name} · Can you crack the ADS1299?`;
  window.scrollTo(0, 0);

  $(".lv-num").textContent = String(setup.level.n);
  $(".lv-name").textContent = setup.name;
  const diff = $(".lv-head .diff");
  diff.textContent = setup.level.difficulty;
  diff.className = `diff diff-${setup.level.difficulty.toLowerCase()}`;
  $(".lv-detail").textContent = `${setup.level.what} · ${setup.detail}`;
  fwButton.classList.toggle("nudge", !sessionStorage.getItem("fw-seen"));

  const target = targetFor(setup);
  level.setSetup(setup, target);
  void level.mountChip();
  strip.setSetup(setup, target);
  clock.duration = setup.duration;
  clock.seek(0);
  anim.setSetup(setup, bodyFor(setup).marks, target.analog);
  animStale = true;
  editor.setBank(bank(), STOCK);
  run();
  offPlayhead?.();
  offPlayhead = clock.on((t) => level.setTime(t));
}

// ---- simulate, compare, draw ----
let timer = 0;
function schedule(): void {
  clearTimeout(timer);
  timer = window.setTimeout(run, 30);
}

function run(): void {
  clearTimeout(timer);
  if (!setup) return;
  const s = setup;
  const sim = simulate(s, bank());
  lastSim = sim;
  const m = match(sim, targetFor(s), usedChannels(s));
  level.setResult(sim, m, bank());
  strip.setResult(sim, m);
  if (animSheet.isOpen) anim.setAnalog(sim.analog);
  else animStale = true;
  paintScore(m);
  const st = state.setups[s.id];
  if (m.pass !== st.solved && m.pass) {
    st.solved = true;
    save(state);
    const i = SETUPS.indexOf(s);
    const next = SETUPS.slice(i + 1).find((x) => !state.setups[x.id].solved) ?? SETUPS.find((x) => !state.setups[x.id].solved) ?? null;
    window.setTimeout(() => {
      if (setup !== s) return;
      showWin({
        setup: s,
        bank: bank(),
        next,
        allSolved: SETUPS.every((x) => state.setups[x.id].solved),
        onNext: () => {
          closeAll();
          if (next) go(next.id);
        },
        onHome: () => goHome(),
      });
    }, 650);
  }
}

function paintScore(m: MatchResult): void {
  const used = m.channels.filter((c) => m.used.includes(c.ch));
  const passed = used.filter((c) => c.pass).length;
  $(".lv-score .dots").innerHTML = used.map((c) => `<i class="${c.pass ? "ok" : ""}"></i>`).join("");
  $(".lv-count").textContent = m.pass ? "Solved" : `${passed} / ${used.length} match`;
  $(".lv-score").classList.toggle("good", m.pass);
}

route();
