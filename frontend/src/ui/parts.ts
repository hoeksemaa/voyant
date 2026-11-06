import type { Flag, Setup, SimResult } from "../puzzle/types";

// Small parts that the desktop board and the phone cards share.

/** "Eyes open | Eyes closed | Eyes open" over the 0–10 s time axis. */
export function phaseStrip(setup: Setup): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "phases";
  for (const p of setup.phases) {
    const seg = document.createElement("span");
    seg.style.flexGrow = String(p.t1 - p.t0);
    seg.title = `${p.label} · ${p.t0}–${p.t1} s`;
    seg.dataset.label = p.label;
    seg.textContent = p.label;
    strip.append(seg);
  }
  return strip;
}

/** Shorten phase labels that do not fit: "Eyes closed" → "closed" → "C"; "Hard flex" → "Hard" → "H". */
export function fitPhases(root: ParentNode): void {
  for (const seg of root.querySelectorAll<HTMLElement>(".phases span")) {
    const full = seg.dataset.label!;
    const key = keyWord(seg);
    const tries = [full, key, key[0].toUpperCase()];
    for (const t of tries) {
      seg.textContent = t;
      if (seg.scrollWidth <= seg.clientWidth + 1) break;
    }
    if (seg.scrollWidth > seg.clientWidth + 1) seg.textContent = "";
  }
}

/** The word of a phase label that the fewest labels in its strip share: "Hard flex" → "Hard", "Eyes open" → "open". */
function keyWord(seg: HTMLElement): string {
  const labels = [...new Set([...seg.parentElement!.children].map((e) => (e as HTMLElement).dataset.label!.toLowerCase()))];
  const words = seg.dataset.label!.split(" ");
  let best = words[words.length - 1];
  let bestN = Infinity;
  for (const w of [...words].reverse()) {
    const n = labels.filter((l) => l.split(" ").includes(w.toLowerCase())).length;
    if (n < bestN) {
      best = w;
      bestN = n;
    }
  }
  return best;
}

export function timeAxis(duration: number): HTMLElement {
  const axis = document.createElement("div");
  axis.className = "ticks";
  const half = duration / 2;
  axis.innerHTML = `<span>0</span><span>${half} s</span><span>${duration} s</span>`;
  return axis;
}

/** Full scale as the datasheet gives it: 4.5 V / gain → "±187.5 mV", "±2.25 V". */
export function railText(uv: number): string {
  return uv >= 1e6 ? `±${+(uv / 1e6).toFixed(3)} V` : `±${+(uv / 1000).toFixed(2)} mV`;
}

const rateText = (r: number) => `${r.toLocaleString("en-US")} SPS`;

/**
 * The output's data rate and full scale, in the target's form ("250 SPS · ±187.5 mV"). Only the
 * channels that are on in the target count. A part that differs from the target is marked.
 */
export function outSpec(el: HTMLElement, sim: SimResult, target: SimResult): void {
  const on = target.out.filter((o) => o.status === "on").map((o) => o.ch - 1);
  const rails = (r: SimResult) => [...new Set(on.filter((k) => r.out[k].status === "on").map((k) => r.out[k].rail))].sort((a, b) => b - a);
  const rate = sim.out[on[0] ?? 0].rate;
  const mine = rails(sim);
  const want = rails(target);
  const rateEl = document.createElement("span");
  rateEl.textContent = rateText(rate);
  rateEl.classList.toggle("diff", rate !== target.out[on[0] ?? 0].rate);
  const railEl = document.createElement("span");
  const invalid = on.some((k) => sim.out[k].status === "invalid");
  railEl.textContent = mine.length ? mine.map(railText).join(" / ") : invalid ? "invalid" : "off";
  railEl.classList.toggle("diff", mine.join() !== want.join());
  el.replaceChildren(rateEl, " · ", railEl);
}

/**
 * The banner over the output: global flags (no channel), or "Solved".
 * A click on a flag shows its register in the firmware editor.
 */
export function renderBanner(el: HTMLElement, flags: Flag[], solved: boolean, onFocus: (reg: string) => void): void {
  const global = flags.filter((f) => f.ch === undefined);
  el.replaceChildren();
  el.classList.remove("solved");
  if (solved && !global.some((f) => f.level === "act")) {
    el.classList.add("solved");
    el.innerHTML = `<span class="solved-mark"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 L8.6 13.4 L14.5 7.2"/></svg></span><b>Solved</b>`;
    return;
  }
  if (!global.length) return;
  const shown = global.slice(0, 2);
  for (const f of shown) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `flag flag-${f.level}`;
    b.title = f.text;
    b.innerHTML = `<i></i>${f.reg ? `<b>${f.reg}</b>` : ""}<span><span class="lead"></span><span class="rest"></span></span>`;
    // The register name is in bold, so drop it from the start of the text.
    const text = f.reg ? f.text.replace(new RegExp(`^${f.reg}:?\\s+`), "") : f.text;
    // The first sentence is the fault. The rest explains it (full text on the phone and in the tooltip).
    const cut = text.search(/\.\s/);
    b.querySelector(".lead")!.textContent = cut > 0 ? text.slice(0, cut + 1) : text;
    b.querySelector(".rest")!.textContent = cut > 0 ? text.slice(cut + 1) : "";
    if (f.reg) b.addEventListener("click", () => onFocus(f.reg!));
    else b.disabled = true;
    el.append(b);
  }
  if (global.length > shown.length) {
    const more = document.createElement("span");
    more.className = "flag-more";
    more.textContent = `+${global.length - shown.length}`;
    more.title = global.slice(shown.length).map((f) => f.text).join("\n");
    el.append(more);
  }
}
