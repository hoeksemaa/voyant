// The datasheet book. Closed, it is a small book icon in the top bar. Open, the datasheet
// fills most of the page. It grows out of the icon and shrinks back into it.
// Keys: D opens or closes it; Esc closes it.

const MS = 220; // open and close time; the CSS uses the same value

const MINIMIZE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 10h6M14 10V4M14 10l7-7M10 14H4M10 14v6M10 14l-7 7"/></svg>`;

export class Book {
  private on = false;
  private timer = 0;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly root: HTMLElement, // the full-page layer
    private readonly panel: HTMLElement, // the panel that holds the datasheet viewer
    pdfUrl: string,
  ) {
    // The viewer's head row gets a link to the full PDF and a minimize button.
    const head = panel.querySelector(".ds-head") ?? panel;
    const pdf = document.createElement("a");
    pdf.className = "book-pdf";
    pdf.href = pdfUrl;
    pdf.target = "_blank";
    pdf.rel = "noopener";
    pdf.textContent = "Full PDF ↗";
    const min = document.createElement("button");
    min.type = "button";
    min.className = "book-min";
    min.title = "Minimize (Esc)";
    min.setAttribute("aria-label", "Minimize the datasheet");
    min.innerHTML = MINIMIZE;
    min.addEventListener("click", () => this.set(false));
    head.append(pdf, min);

    button.addEventListener("click", () => this.set(!this.on));
    root.addEventListener("click", (e) => {
      if (e.target === root) this.set(false); // a click on the dim edge closes the book
    });
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    clearTimeout(this.timer);
    this.button.setAttribute("aria-expanded", String(on));
    document.body.classList.toggle("book-open", on);
    if (on) {
      this.root.hidden = false;
      this.aim();
      void this.root.offsetWidth; // start the transition from the closed state
      this.root.classList.add("on");
      (this.panel.querySelector<HTMLElement>(".ds") ?? this.panel).focus({ preventScroll: true });
    } else {
      this.aim();
      this.root.classList.remove("on");
      this.timer = window.setTimeout(() => (this.root.hidden = true), MS);
      this.button.focus({ preventScroll: true });
    }
  }

  // Grow from (and shrink into) the book icon: put the transform origin on the icon.
  private aim(): void {
    const b = this.button.getBoundingClientRect();
    const p = this.panel.getBoundingClientRect();
    if (!b.width || !p.width) return;
    const x = b.left + b.width / 2 - p.left;
    const y = b.top + b.height / 2 - p.top;
    this.panel.style.transformOrigin = `${x}px ${y}px`;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === "Escape" && this.on && !document.querySelector(".ds-zoom")) {
      e.preventDefault();
      this.set(false);
    } else if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      this.set(!this.on);
    }
  }
}
