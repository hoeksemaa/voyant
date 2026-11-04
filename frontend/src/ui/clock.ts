// One playback clock for a level. The playhead on the traces and the Animation sheet both
// follow it, so the body moves at the same time as the signal. It loops over the setup's
// duration and runs only while something listens.

type Fn = (t: number) => void;

export class Clock {
  t = 0;
  duration = 10;
  playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  private subs = new Set<Fn>();
  private raf = 0;
  private last = 0;

  on(fn: Fn): () => void {
    this.subs.add(fn);
    fn(this.t);
    this.kick();
    return () => this.subs.delete(fn);
  }

  seek(t: number): void {
    this.t = Math.min(this.duration, Math.max(0, t));
    for (const fn of this.subs) fn(this.t);
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.last = 0;
    this.kick();
  }

  private kick(): void {
    if (!this.raf && this.subs.size) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.subs.size) {
      this.last = 0;
      return;
    }
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (this.playing) {
      this.t = (this.t + dt) % this.duration;
      for (const fn of this.subs) fn(this.t);
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.last = 0;
    }
  };
}
