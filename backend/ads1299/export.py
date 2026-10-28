"""Run the simulation and write the traces the website plays back.

    python -m ads1299.export [output.json]

Each probe's samples are stored as int16 pairs (low, high) scaled to the probe's range,
then base64-encoded. -32768 means "not driven".
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np

from .host import Run
from .log import FAIL, PASS, RULES, WARN
from .sequences import SEQUENCES, add_frame_mark, probes, sample, window

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "sim" / "run.json"
SAMPLES_PER_VIEW_SECOND = 110
MAX_READ_EVENTS = 40
ORDER = {PASS: 0, WARN: 1, FAIL: 2}


def encode(lo: np.ndarray, hi: np.ndarray, vmin: float, vmax: float) -> str | float | None:
    both = np.stack([lo, hi], axis=1).ravel()
    finite = both[~np.isnan(both)]
    if len(finite) == 0:
        return None
    if finite.max() - finite.min() < 1e-9 * max(1.0, abs(vmax - vmin)) and len(finite) == len(both):
        return round(float(finite[0]), 6)  # constant over the step
    q = np.round((both - vmin) / (vmax - vmin) * 65000 - 32500)
    q = np.clip(q, -32767, 32767)
    q[np.isnan(both)] = -32768
    return base64.b64encode(q.astype("<i2").tobytes()).decode("ascii")


def build(run: Run) -> dict:
    add_frame_mark(run)
    marks = run.log.marks
    probe_list = probes(run)
    rng = np.random.default_rng(1)
    sequences = []
    for seq in SEQUENCES:
        steps = []
        for step in seq.steps:
            t0, t1 = window(step, marks)
            n = int(np.clip(step.view * SAMPLES_PER_VIEW_SECOND, 240, 1400))
            data = {p.id: encode(*sample(p, t0, t1, n, rng), p.lo, p.hi) for p in probe_list}

            def inside(t: float) -> bool:
                return t0 <= t < t1

            events = [e for e in run.log.events if e.t1 > t0 and e.t0 < t1]
            reads = [e for e in events if e.kind == "read"]
            keep = [
                e
                for e in events
                if e.kind == "command"
                or (e.kind in ("byte", "out") and step.bits)
                or (e.kind == "read" and len(reads) <= MAX_READ_EVENTS)
            ]
            checks: dict[str, dict] = {}
            for c in run.log.checks:
                if not inside(c.t):
                    continue
                s = checks.setdefault(c.rule, {"rule": c.rule, "status": c.status, "t": c.t, "detail": c.detail, "count": 0})
                s["count"] += 1
                if ORDER[c.status] > ORDER[s["status"]]:
                    s.update(status=c.status, t=c.t, detail=c.detail)
            steps.append(
                {
                    "title": step.title,
                    "text": step.text,
                    "quote": step.quote,
                    "cite": step.cite,
                    "t0": t0,
                    "t1": t1,
                    "view": step.view,
                    "n": n,
                    "data": data,
                    "events": [[e.t0, e.t1, e.kind, e.text] for e in keep],
                    "notes": [[x.t, x.text] for x in sorted(run.log.notes, key=lambda x: x.t) if inside(x.t)],
                    "checks": list(checks.values()),
                }
            )
        sequences.append({"id": seq.id, "title": seq.title, "summary": seq.summary, "steps": steps})

    return {
        "version": 1,
        "probes": [
            {"id": p.id, "label": p.label, "pins": p.pins, "unit": p.unit, "lo": p.lo, "hi": p.hi} for p in probe_list
        ],
        "rules": {k: {"title": r.title, "cite": r.cite, "quote": r.quote} for k, r in RULES.items()},
        "summary": run.log.summary(),
        "sequences": sequences,
    }


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    run = Run()
    doc = build(run)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e3:.0f} kB)")
    for rule, s in doc["summary"].items():
        print(f"  {s['status']:4}  {rule:20} {s['failures']}/{s['count']}  {s['detail']}")


if __name__ == "__main__":
    main()
