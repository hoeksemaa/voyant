"""What happened during a run: decoded SPI traffic, chip state changes, and datasheet checks."""

from __future__ import annotations

from dataclasses import dataclass, field

PASS, WARN, FAIL = "pass", "warn", "fail"


@dataclass
class Event:
    t0: float
    t1: float
    kind: str  # "command", "byte", or "read"
    text: str


@dataclass
class Note:
    t: float
    text: str


@dataclass
class Check:
    t: float
    rule: str  # short id, like "tSCCS"
    status: str
    detail: str


@dataclass
class Rule:
    rule: str
    title: str
    cite: str  # datasheet section
    quote: str  # the datasheet's words


# The rules the checker knows, with the datasheet text each one comes from.
RULES = {
    r.rule: r
    for r in [
        Rule(
            "reset-after-por",
            "Reset after power-on",
            "11.1 Power-Up Sequencing",
            "Issue the reset after tPOR or after the VCAP1 voltage is greater than 1.1 V, whichever time is longer.",
        ),
        Rule(
            "tSCCS",
            "CS high after the last SCLK",
            "7.6 Timing Requirements",
            "tSCCS: Delay time, final SCLK falling edge to CS high: 4 tCLK minimum.",
        ),
        Rule(
            "tCSH",
            "CS high time",
            "7.6 Timing Requirements",
            "tCSH: Pulse duration, CS high: 2 tCLK minimum.",
        ),
        Rule(
            "tSDECODE",
            "Gap between command bytes",
            "9.5.3.1 Sending Multi-Byte Commands",
            "When sending multi-byte commands (such as RREG or WREG), a 4 tCLK period must separate "
            "the end of one byte (or command) and the next.",
        ),
        Rule(
            "start-pin-low",
            "START command with the START pin low",
            "9.5.3.5 START: Start Conversions",
            "When the START command is sent to the device, keep the START pin low until the STOP command is issued.",
        ),
        Rule(
            "rdatac-only-sdatac",
            "Only SDATAC in RDATAC mode",
            "9.5.3.7 RDATAC: Read Data Continuous",
            "If the device is in RDATAC mode, a SDATAC command must be issued before any other commands "
            "can be sent to the device.",
        ),
        Rule(
            "rdatac-keepout",
            "RDATAC away from DRDY",
            "9.5.3.7 RDATAC: Read Data Continuous",
            "There is a keep out zone of 4 tCLK cycles around the DRDY pulse where this command cannot be issued in.",
        ),
        Rule(
            "ref-settled",
            "Reference settled before data",
            "7.5 Electrical Characteristics",
            "Internal reference start-up time: 150 ms (typical).",
        ),
        Rule(
            "read-before-next",
            "Read done before the next DRDY",
            "9.4.4.1 Data Ready (DRDY)",
            "DRDY is an output signal which transitions from high to low indicating new conversion data are ready.",
        ),
        Rule(
            "full-scale",
            "Input inside full scale",
            "7.3 Recommended Operating Conditions",
            "Full-scale differential input voltage: VINxP - VINxN = ±VREF / gain.",
        ),
    ]
}


@dataclass
class Log:
    events: list[Event] = field(default_factory=list)
    notes: list[Note] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)
    marks: dict[str, float] = field(default_factory=dict)

    def event(self, t0: float, t1: float, kind: str, text: str) -> None:
        self.events.append(Event(t0, t1, kind, text))

    def note(self, t: float, text: str) -> None:
        self.notes.append(Note(t, text))

    def check(self, t: float, rule: str, ok: bool | str, detail: str) -> None:
        assert rule in RULES, rule
        status = ok if isinstance(ok, str) else (PASS if ok else FAIL)
        self.checks.append(Check(t, rule, status, detail))

    def mark(self, name: str, t: float) -> None:
        self.marks[name] = t

    def summary(self) -> dict[str, dict]:
        """Worst result for each rule, with the first time it happened."""
        order = {PASS: 0, WARN: 1, FAIL: 2}
        out: dict[str, dict] = {}
        for c in self.checks:
            s = out.setdefault(c.rule, {"status": PASS, "count": 0, "failures": 0, "t": c.t, "detail": c.detail})
            s["count"] += 1
            if c.status != PASS:
                s["failures"] += 1
            if order[c.status] > order[s["status"]]:
                s.update(status=c.status, t=c.t, detail=c.detail)
        return out
