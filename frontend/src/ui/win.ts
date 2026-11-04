import { REGISTERS, STOCK } from "../puzzle/registers";
import type { Bank, Setup } from "../puzzle/types";

// The level-complete card: what changed in the firmware, why it worked (one line), and the
// way on (next level, or home).

const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, "0")}`;
const COLORS = ["#f56200", "#15803d", "#2563eb", "#d6336c", "#e6a700", "#7048e8"];

export interface WinOptions {
  setup: Setup;
  bank: Bank;
  next: Setup | null;
  allSolved: boolean;
  onNext: () => void;
  onHome: () => void;
}

export function showWin(o: WinOptions): void {
  document.querySelector(".win")?.remove();
  const root = document.createElement("div");
  root.className = "win";
  const changes = REGISTERS.filter((r) => r.group && o.bank[r.addr] !== STOCK[r.addr])
    .map((r) => `<li><code>${r.name}</code><span>${hex(STOCK[r.addr])} → <b>${hex(o.bank[r.addr])}</b></span></li>`)
    .join("");
  const bits = Array.from({ length: 26 }, (_, i) => {
    const a = (i / 26) * 2 * Math.PI;
    const d = 70 + (i % 5) * 18;
    return `<i style="--x:${(Math.cos(a) * d).toFixed(0)}px;--y:${(Math.sin(a) * d - 30).toFixed(0)}px;--r:${(i * 47) % 360}deg;--c:${COLORS[i % COLORS.length]};--d:${(i % 4) * 40}ms"></i>`;
  }).join("");
  root.innerHTML = `
    <div class="win-card" role="dialog" aria-label="Level complete">
      <div class="win-burst">${bits}<span class="win-check"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 L8.6 13.4 L14.5 7.2"/></svg></span></div>
      <p class="win-kicker">Level ${o.setup.level.n} · ${o.setup.name}</p>
      <h2>${o.allSolved ? "Chip cracked!" : "Level complete"}</h2>
      <p class="win-lesson">${o.setup.lesson}</p>
      ${changes ? `<div class="win-changes"><p>Your firmware change</p><ul>${changes}</ul></div>` : ""}
      <div class="win-actions">
        ${o.next ? `<button type="button" class="btn btn-primary" data-act="next">Next: ${o.next.name} <span>${o.next.level.difficulty}</span></button>` : ""}
        <button type="button" class="btn ${o.next ? "" : "btn-primary"}" data-act="home">Home</button>
        <button type="button" class="btn btn-quiet" data-act="stay">Keep looking</button>
      </div>
    </div>`;
  const close = () => {
    root.classList.remove("on");
    setTimeout(() => root.remove(), 220);
  };
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (t === root || act === "stay") close();
    else if (act === "next") {
      close();
      o.onNext();
    } else if (act === "home") {
      close();
      o.onHome();
    }
  });
  window.addEventListener(
    "keydown",
    function esc(e) {
      if (e.key === "Escape" && root.isConnected) {
        close();
        window.removeEventListener("keydown", esc);
      }
    },
  );
  document.body.append(root);
  void root.offsetWidth;
  root.classList.add("on");
  root.querySelector<HTMLButtonElement>(".btn-primary")?.focus({ preventScroll: true });
}
