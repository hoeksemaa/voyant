"""Run the simulation and write the traces the website plays back.

    python -m ads1299.export [output-folder]

Writes run.json (probes, rules, speeds) and one file per sequence and speed, such as
bring-up.ms.json. Each probe's samples are int16 pairs (low, high) scaled to the probe's
range, then base64-encoded. -32768 means "not driven".
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np

from .host import Run
from .log import RULES, worse
from .sequences import LEAD, SCREEN, SEQUENCES, SPEEDS, Sequence, Speed, add_marks, plan, probes, sample

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "sim"
SPS = 60  # samples per second of playback
READ_GAP = 0.25  # at most one decoded frame per this many playback seconds
BYTES_BELOW = 1e-5  # label each byte on the bus at speeds slower than this rate


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


def clip(run: Run, seq: Sequence, speed: Speed, probe_list, rng: np.random.Generator) -> dict:
    """One sequence at one speed: the regions that play, and the steps."""
    r = speed.rate
    p = plan(seq, speed, run.log.marks)
    regions = []
    for reg in p.regions:
        n = int(round((reg.t1 - reg.t0) / r * SPS))
        data = {pr.id: encode(*sample(pr, reg.t0, reg.t1, n, rng), pr.lo, pr.hi) for pr in probe_list}
        events, last_read = [], -np.inf
        for e in run.log.events:
            if e.t1 <= reg.t0 or e.t0 >= reg.t1:
                continue
            if e.kind == "read":
                if e.t0 - last_read < READ_GAP * r:
                    continue
                last_read = e.t0
            elif e.kind in ("byte", "out") and r > BYTES_BELOW:
                continue
            events.append([e.t0, e.t1, e.kind, e.text])
        regions.append({"t0": reg.t0, "tp": reg.tp, "t1": reg.t1, "n": n, "data": data, "events": events})

    steps = []
    notes = sorted(run.log.notes, key=lambda x: x.t)
    for i, (step, a) in enumerate(zip(p.steps, p.anchors)):
        b = p.anchors[i + 1] if i + 1 < len(p.anchors) else p.regions[-1].t1

        def inside(t: float) -> bool:
            return a <= t < b

        checks: dict[str, dict] = {}
        for c in run.log.checks:
            if not inside(c.t):
                continue
            s = checks.setdefault(c.rule, {"rule": c.rule, "status": c.status, "t": c.t, "detail": c.detail, "count": 0, "margin": c.margin})
            s["count"] += 1
            if worse(c, s):
                s.update(status=c.status, detail=c.detail, margin=c.margin)
        for s in checks.values():
            del s["margin"]
        k, t = p.starts[i]
        steps.append(
            {
                "id": step.id,
                "title": step.title,
                "text": step.text,
                "quote": step.quote,
                "cite": step.cite,
                "anchor": a,
                "region": k,
                "p0": (t - p.regions[k].t0) / r,
                "notes": [[x.t, x.text] for x in notes if inside(x.t)],
                "checks": list(checks.values()),
            }
        )
    return {"regions": regions, "steps": steps}


def build(run: Run) -> tuple[dict, dict[str, dict]]:
    """The index (run.json) and one clip per sequence and speed."""
    add_marks(run)
    probe_list = probes(run)
    rng = np.random.default_rng(1)
    clips = {f"{seq.id}.{sp.id}": clip(run, seq, sp, probe_list, rng) for seq in SEQUENCES for sp in SPEEDS}
    index = {
        "version": 2,
        "screen": SCREEN,
        "lead": LEAD,
        "sps": SPS,
        "speeds": [{"id": sp.id, "label": sp.label, "rate": sp.rate} for sp in SPEEDS],
        "probes": [
            {"id": p.id, "label": p.label, "pins": p.pins, "unit": p.unit, "lo": p.lo, "hi": p.hi} for p in probe_list
        ],
        "rules": {k: {"title": r.title, "cite": r.cite, "quote": r.quote} for k, r in RULES.items()},
        "summary": {rule: {k: v for k, v in s.items() if k != "margin"} for rule, s in run.log.summary().items()},
        "sequences": [{"id": seq.id, "title": seq.title, "summary": seq.summary} for seq in SEQUENCES],
    }
    return index, clips


def write(path: Path, doc: dict) -> None:
    path.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False))
    print(f"wrote {path.name} ({path.stat().st_size / 1e3:.0f} kB)")


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)
    index, clips = build(Run())
    write(out / "run.json", index)
    for name, doc in clips.items():
        write(out / f"{name}.json", doc)
    for rule, s in index["summary"].items():
        print(f"  {s['status']:4}  {rule:20} {s['failures']}/{s['count']}  {s['detail']}")


if __name__ == "__main__":
    main()
