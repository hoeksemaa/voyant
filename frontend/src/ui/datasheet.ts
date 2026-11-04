import "./datasheet.css";
import type { Clip } from "../puzzle/types";
import { REGISTERS } from "../puzzle/registers";

// Datasheet viewer: image clips cut from the TI datasheet, one tab per clip. Arrow keys and
// the ‹ › buttons step through the clips; on a phone, a swipe does the same. Click a clip to
// zoom it. The caption links to the clip's page in the PDF.

const GROUPS = new Set(["CONFIG1", "CHnSET", "BIAS_SENS", "CONFIG3", "map", "extra"]);
const COMPACT_W = 440; // container width (px); below it, the viewer uses the phone layout
const SWIPE_PX = 40; // a horizontal move longer than this is a swipe

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The clip group of a register name, for example "CH3SET" → "CHnSET". */
function groupOfRegister(name: string): string | null {
  if (/^CH[1-8]SET$/.test(name)) return "CHnSET";
  if (name === "BIAS_SENSP" || name === "BIAS_SENSN") return "BIAS_SENS";
  if (name === "CONFIG1" || name === "CONFIG3") return name;
  return null;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class DatasheetViewer {
  private readonly el = make("div", "ds");
  private readonly tabs = make("div", "ds-tabs");
  private readonly view = make("div", "ds-view");
  private readonly frame = make("div", "ds-frame");
  private readonly img = make("img", "ds-img");
  private readonly missing = make("p", "ds-missing");
  private readonly capText = make("span", "ds-cap-text");
  private readonly pageLink = make("a", "ds-page");
  private readonly tabBtns: HTMLButtonElement[] = [];
  private idx = -1;
  private hover = false;
  private zoom: HTMLElement | null = null;
  private zoomImg: HTMLImageElement | null = null;
  private zoomCap: HTMLElement | null = null;
  private loadId = 0;

  constructor(
    root: HTMLElement,
    private readonly clips: Clip[],
    private readonly pdfUrl: string,
  ) {
    this.el.tabIndex = 0;
    this.el.setAttribute("aria-label", "Datasheet clips");

    const head = make("div", "ds-head");
    this.tabs.setAttribute("role", "tablist");
    clips.forEach((c, i) => {
      const b = make("button", "ds-tab", c.title);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.tabIndex = -1;
      b.addEventListener("click", () => this.go(i, Math.sign(i - this.idx)));
      this.tabBtns.push(b);
      this.tabs.append(b);
    });
    this.tabs.addEventListener("scroll", () => this.edgeFade(), { passive: true });
    const nav = make("div", "ds-nav");
    const prev = this.navButton("‹", "Previous clip", -1);
    const next = this.navButton("›", "Next clip", 1);
    nav.append(prev, next);
    head.append(make("span", "ds-title", "Datasheet"), this.tabs, nav);

    this.img.alt = "";
    this.img.decoding = "async";
    this.img.draggable = false;
    this.img.addEventListener("click", () => this.openZoom());
    this.missing.hidden = true;
    this.frame.append(this.img, this.missing);
    this.view.append(this.frame);

    const cap = make("div", "ds-cap");
    this.pageLink.target = "_blank";
    this.pageLink.rel = "noopener";
    cap.append(this.capText, this.pageLink);

    this.el.append(head, this.view, cap);
    root.append(this.el);

    if (!clips.length) {
      this.capText.textContent = "No clips";
      return;
    }

    this.el.addEventListener("pointerenter", () => (this.hover = true));
    this.el.addEventListener("pointerleave", () => (this.hover = false));
    window.addEventListener("keydown", (e) => this.onKey(e));
    this.swipe();
    new ResizeObserver(() => {
      this.el.classList.toggle("compact", root.clientWidth > 0 && root.clientWidth < COMPACT_W);
      this.revealTab(this.idx, false);
      this.edgeFade();
    }).observe(root);

    this.go(0, 0);
    // Load the other clips when the page is quiet, so a tab change shows its clip at once.
    window.setTimeout(() => {
      for (const c of clips) new Image().src = c.file;
    }, 1500);
  }

  /**
   * Show a clip. target: a group ("CONFIG1", "CHnSET", "BIAS_SENS", "CONFIG3"), "map", a clip id,
   * or a register name ("CH3SET", "BIAS_SENSN"). For a group, the current clip stays when it is
   * in that group. A locked register shows the register map. An unknown target does nothing.
   */
  show(target: string): void {
    if (!target || !this.clips.length) return;
    const i = this.find(target);
    if (i >= 0) this.go(i, 0);
  }

  private find(target: string): number {
    const byId = this.clips.findIndex((c) => c.id === target);
    if (byId >= 0) return byId;
    const t = norm(target);
    const isGroup = GROUPS.has(target);
    if (!isGroup) {
      const byName = this.clips.findIndex((c) => norm(c.id) === t || norm(c.title) === t);
      if (byName >= 0) return byName;
    }
    const isReg = REGISTERS.some((r) => r.name === target);
    const group = isGroup ? target : isReg ? (groupOfRegister(target) ?? "map") : null;
    if (!group) return -1;
    if (this.clips[this.idx]?.group === group) return this.idx;
    return this.clips.findIndex((c) => c.group === group);
  }

  private navButton(text: string, label: string, step: number): HTMLButtonElement {
    const b = make("button", "ds-navbtn", text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", () => this.step(step));
    return b;
  }

  private step(d: number): void {
    const n = this.clips.length;
    this.go((this.idx + d + n) % n, d);
  }

  /** Change to clip i. dir: -1 or 1 slides the new clip in from that side; 0 fades it in. */
  private go(i: number, dir: number): void {
    if (i === this.idx || i < 0 || i >= this.clips.length) return;
    this.idx = i;
    const c = this.clips[i];
    this.tabBtns.forEach((b, j) => {
      b.setAttribute("aria-selected", String(j === i));
      b.classList.toggle("on", j === i);
    });
    this.revealTab(i);
    this.capText.textContent = c.caption;
    this.pageLink.textContent = `p. ${c.page} ↗`;
    this.pageLink.href = `${this.pdfUrl}#page=${c.page}`;
    this.pageLink.title = `Open page ${c.page} of the datasheet PDF`;

    // Decode the next image first, so the old clip stays until the new one can show.
    const id = ++this.loadId;
    const next = new Image();
    next.src = c.file;
    const swap = (ok: boolean): void => {
      if (id !== this.loadId) return;
      this.img.hidden = !ok;
      this.missing.hidden = ok;
      if (ok) {
        this.img.src = c.file;
        this.img.width = c.width;
        this.img.height = c.height;
        this.img.alt = c.caption;
      } else this.missing.textContent = `The image for this clip is missing: ${c.file}`;
      this.view.scrollTop = 0;
      this.frame.style.setProperty("--dx", `${dir * 18}px`);
      this.frame.classList.remove("in");
      void this.frame.offsetWidth;
      this.frame.classList.add("in");
      if (this.zoom) this.fillZoom();
    };
    next
      .decode()
      .then(() => swap(true))
      .catch(() => swap(next.complete && next.naturalWidth > 0));
  }

  /** Scroll the tab strip so that tab i is fully in view, clear of the edge fades. */
  private revealTab(i: number, smooth = true): void {
    const t = this.tabBtns[i];
    if (!t) return;
    const s = this.tabs;
    const l = t.offsetLeft;
    const r = l + t.offsetWidth;
    const behavior = smooth ? "smooth" : "instant";
    if (l < s.scrollLeft + 32) s.scrollTo({ left: l - 32, behavior });
    else if (r > s.scrollLeft + s.clientWidth - 32) s.scrollTo({ left: r - s.clientWidth + 32, behavior });
  }

  /** Fade the tab strip at an edge where more tabs are hidden. */
  private edgeFade(): void {
    const s = this.tabs;
    this.tabs.classList.toggle("fade-l", s.scrollLeft > 2);
    this.tabs.classList.toggle("fade-r", s.scrollLeft + s.clientWidth < s.scrollWidth - 2);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const active = this.zoom !== null || this.hover || this.el.contains(document.activeElement);
    if (!active) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.step(e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "Escape" && this.zoom) {
      e.preventDefault();
      this.closeZoom();
    } else if (e.key === "Enter" && document.activeElement === this.el) {
      e.preventDefault();
      this.openZoom();
    }
  }

  private swipe(): void {
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    this.view.addEventListener(
      "touchstart",
      (e) => {
        x0 = e.touches[0].clientX;
        y0 = e.touches[0].clientY;
        t0 = performance.now();
      },
      { passive: true },
    );
    this.view.addEventListener(
      "touchend",
      (e) => {
        const dx = e.changedTouches[0].clientX - x0;
        const dy = e.changedTouches[0].clientY - y0;
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5 || performance.now() - t0 > 700) return;
        this.step(dx < 0 ? 1 : -1);
      },
      { passive: true },
    );
  }

  // ---- zoom ----

  private openZoom(): void {
    if (this.zoom || this.img.hidden) return;
    const z = make("div", "ds-zoom");
    z.setAttribute("role", "dialog");
    z.setAttribute("aria-modal", "true");
    z.tabIndex = -1;
    const fig = make("figure", "ds-zoom-fig");
    this.zoomImg = make("img", "ds-zoom-img");
    this.zoomCap = make("figcaption", "ds-zoom-cap");
    const close = make("button", "ds-zoom-x", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    fig.append(this.zoomImg, this.zoomCap);
    z.append(fig, close);
    // A click anywhere closes the zoom, except on the page link.
    z.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("a")) this.closeZoom();
    });
    document.body.append(z);
    this.zoom = z;
    this.fillZoom();
    requestAnimationFrame(() => z.classList.add("on"));
    z.focus({ preventScroll: true });
  }

  private fillZoom(): void {
    const c = this.clips[this.idx];
    if (!this.zoomImg || !this.zoomCap || !c) return;
    this.zoomImg.src = c.file;
    this.zoomImg.width = c.width;
    this.zoomImg.height = c.height;
    this.zoomImg.alt = c.caption;
    this.zoomCap.textContent = `${c.caption} · `;
    const a = make("a", "", `p. ${c.page} ↗`);
    a.href = `${this.pdfUrl}#page=${c.page}`;
    a.target = "_blank";
    a.rel = "noopener";
    this.zoomCap.append(a);
  }

  private closeZoom(): void {
    const z = this.zoom;
    if (!z) return;
    this.zoom = null;
    this.zoomImg = null;
    this.zoomCap = null;
    z.classList.remove("on");
    window.setTimeout(() => z.remove(), 200);
    this.el.focus({ preventScroll: true });
  }
}
