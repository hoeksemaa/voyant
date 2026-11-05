// A full-screen sheet: it slides up over the level, and a tap outside it (or Done, or Esc) puts
// it away. Sheets can stack: the datasheet can open over the firmware.

const stack: Sheet[] = [];

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length) return;
  if (document.querySelector(".ds-zoom")) return; // the datasheet's zoom closes first
  e.preventDefault();
  stack[stack.length - 1].close();
});

export interface SheetOptions {
  title: string;
  wide?: boolean; // desktop: wider than the phone column (datasheet)
  onOpen?: () => void;
  onClose?: () => void;
}

export class Sheet {
  readonly root = document.createElement("div");
  readonly panel = document.createElement("div");
  readonly head = document.createElement("header");
  readonly tools = document.createElement("div"); // buttons in the head, left of Done
  readonly body = document.createElement("div");
  private timer = 0;
  private on = false;

  constructor(private opts: SheetOptions) {
    this.root.className = `sheet${opts.wide ? " sheet-wide" : ""}`;
    this.root.hidden = true;
    this.panel.className = "sheet-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", opts.title);
    this.panel.tabIndex = -1;
    this.head.className = "sheet-head";
    const h = document.createElement("h2");
    h.textContent = opts.title;
    this.tools.className = "sheet-tools";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "sheet-done";
    done.textContent = "Done";
    done.addEventListener("click", () => this.close());
    this.head.append(h, this.tools, done);
    this.body.className = "sheet-body";
    this.panel.append(this.head, this.body);
    this.root.append(this.panel);
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.close(); // a tap on the dim edge
    });
    document.body.append(this.root);
  }

  get isOpen(): boolean {
    return this.on;
  }

  open(): void {
    if (this.on) {
      // Open under another sheet: bring it to the top.
      if (stack[stack.length - 1] === this) return;
      stack.splice(stack.indexOf(this), 1);
      stack.push(this);
      restack();
      this.panel.focus({ preventScroll: true });
      return;
    }
    this.on = true;
    clearTimeout(this.timer);
    stack.push(this);
    restack();
    this.root.hidden = false;
    document.body.classList.add("sheet-open");
    void this.root.offsetWidth; // start the slide from the closed state
    this.root.classList.add("on");
    this.panel.focus({ preventScroll: true });
    this.opts.onOpen?.();
  }

  close(): void {
    if (!this.on) return;
    this.on = false;
    const i = stack.indexOf(this);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length) document.body.classList.remove("sheet-open");
    this.root.classList.remove("on");
    this.timer = window.setTimeout(() => (this.root.hidden = true), 260);
    this.opts.onClose?.();
  }

  toggle(): void {
    if (this.on) this.close();
    else this.open();
  }
}

function restack(): void {
  stack.forEach((s, i) => (s.root.style.zIndex = String(41 + i)));
}

/** Close every open sheet (going home). */
export function closeAll(): void {
  for (const s of [...stack].reverse()) s.close();
}
