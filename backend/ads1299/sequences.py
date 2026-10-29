"""What the website shows: the probes (scope channels), the playback speeds, and the steps.

Playback runs at one of three fixed speeds: real time, 1 ms per second, or 1 µs per second.
Each step is a moment on the run's timeline. At the slow speeds the player skips the quiet
time between moments, so a 1-second wait does not take 11 days to watch.
Quotes are the datasheet's words (SBAS499C).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import board
from .host import Run
from .waves import Func, Wave


@dataclass
class Probe:
    id: str
    label: str
    pins: list[int]
    unit: str
    lo: float
    hi: float
    wave: Wave
    noise: float = 0.0  # scope noise, in the probe's unit


def probes(run: Run) -> list[Probe]:
    chip, host, body = run.chip, run.host, run.body
    v = 3e-3  # a few millivolts of scope noise on voltage probes
    # The electrode probes subtract the electrodes' DC offset (like a scope's AC coupling),
    # so the microvolt-sized eye signals stay on screen.
    off1 = (board.ELECTRODE_OFFSET["IN1P"] - board.ELECTRODE_OFFSET["SRB1"]) * 1e6
    off2 = (board.ELECTRODE_OFFSET["IN2P"] - board.ELECTRODE_OFFSET["SRB1"]) * 1e6

    def diff(pos: str, off: float) -> Func:
        return Func(lambda t: (body.electrode_v(pos, t) - body.electrode_v("SRB1", t)) * 1e6 - off)

    def data(ch: int, off: float) -> Func:
        return Func(lambda t: host.uv[ch].at(t) - off)

    lines = host.lines
    return [
        Probe("avdd", "AVDD", [19, 21, 22, 56, 59], "V", 0, 5.5, chip.avdd, v),
        Probe("dvdd", "DVDD", [48, 50], "V", 0, 3.6, chip.dvdd, v),
        Probe("pwdn", "PWDN", [35], "V", 0, 3.6, lines["PWDN"], v),
        Probe("reset", "RESET", [36], "V", 0, 3.6, lines["RESET"], v),
        Probe("start", "START", [38], "V", 0, 3.6, lines["START"], v),
        Probe("cs", "CS", [39], "V", 0, 3.6, lines["CS"], v),
        Probe("sclk", "SCLK", [40], "V", 0, 3.6, lines["SCLK"], v),
        Probe("din", "DIN", [34], "V", 0, 3.6, lines["DIN"], v),
        Probe("in1", "IN1P − SRB1", [16, 17], "µV", -600, 600, diff("IN1P", off1)),
        Probe("in2", "IN2P − SRB1", [14, 17], "µV", -600, 600, diff("IN2P", off2)),
        Probe("vcap1", "VCAP1", [28], "V", 0, 1.5, chip.vcap1, 1e-3),
        Probe("vrefp", "VREFP", [24], "V", 0, 5, chip.vrefp, v),
        Probe("biasout", "BIASOUT", [63], "V", 0, 5, chip.biasout, v),
        Probe("clk", "CLK", [37], "V", 0, 3.6, chip.clk, v),
        Probe("drdy", "DRDY", [47], "V", 0, 3.6, chip.drdy, v),
        Probe("dout", "DOUT", [43], "V", 0, 3.6, chip.dout, v),
        Probe("ch1", "CH1 data", [43], "µV", -600, 600, data(1, off1)),
        Probe("ch2", "CH2 data", [43], "µV", -600, 600, data(2, off2)),
    ]


@dataclass
class Speed:
    id: str
    label: str
    rate: float  # real seconds per second of playback


SPEEDS = [
    Speed("real", "Real time", 1.0),
    Speed("ms", "1 ms per second", 1e-3),
    Speed("us", "1 µs per second", 1e-6),
]

SCREEN = 5.0  # playback seconds across one scope screen
LEAD = 1.0  # playback seconds shown before each moment
CAP = 10.0  # playback seconds shown after each moment, before a skip to the next one


@dataclass
class Step:
    id: str
    title: str
    text: str  # what happens, in plain words
    start: str  # mark name: the moment the step begins
    quote: str = ""
    cite: str = ""
    offset: float = 0.0  # move the moment later by this much
    moments: list[str] = field(default_factory=list)  # more marks to show at the slow speeds
    speeds: tuple[str, ...] = ()  # only at these speeds; empty = all
    cap: float = CAP


@dataclass
class Sequence:
    id: str
    title: str
    summary: str
    steps: list[Step] = field(default_factory=list)
    end: str = "end"  # mark name: the run stops here at real time
    end_offset: float = 0.0


FW = "pong-firmware, setup()"

SEQUENCES = [
    Sequence(
        "bring-up",
        "Bring-up",
        "Power on, then the Brain Pong firmware's setup(), step by step.",
        [
            Step(
                "power",
                "Power on",
                "The regulators bring up AVDD (5 V) and DVDD (3.3 V). PWDN and RESET stay low, so the chip stays off.",
                "power",
                quote="Before device power up, all digital and analog inputs must be low. At the time of power up, "
                "keep all of these signals low until the power supplies have stabilized.",
                cite="11.1 Power-Up Sequencing",
            ),
            Step(
                "boot",
                "Firmware boots",
                "The ESP32 sets its pins as outputs with CS high, then waits 2.5 s. The chip is still powered down.",
                "setup",
                cite=FW,
            ),
            Step(
                "hold",
                "Hold PWDN and RESET low",
                "ADS1299_SETUP() holds both pins low for 100 ms.",
                "hold",
                quote="When PWDN is pulled low, all on-chip circuitry is powered down.",
                cite="9.4.3 Power-Down (PWDN)",
            ),
            Step(
                "release",
                "Release PWDN and RESET",
                "Both pins go high together. The chip powers up, and VCAP1 starts to charge through its 100 µF capacitor. "
                "The firmware waits 1 s.",
                "release",
                quote="Wait for time tPOR, then transmit a reset pulse using either the RESET pin or RESET command to "
                "initialize the digital portion of the chip. Issue the reset after tPOR or after the VCAP1 voltage is "
                "greater than 1.1 V, whichever time is longer.",
                cite="11.1 Power-Up Sequencing",
            ),
            Step(
                "sdatac",
                "SDATAC (11h)",
                "One byte on the bus takes the chip out of continuous-read mode, so registers can be written.",
                "sdatac",
                quote="Device Wakes Up in RDATAC Mode, so Send SDATAC Command so Registers can be Written",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
            Step(
                "config3",
                "WREG CONFIG3 ← ECh",
                "Three bytes: write register 03h. ECh turns on the internal reference buffer and the bias drive.",
                "config3",
                quote="If Using Internal Reference, Send This Command: WREG CONFIG3 E0h",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
            Step(
                "ref",
                "Reference and bias drive start",
                "VREFP starts to charge toward 4.5 V. BIASOUT drives the body to 2.5 V, and most of the mains hum on "
                "the electrodes goes away. The firmware waits 10 ms.",
                "ref-wait",
                quote="Internal reference start-up time: 150 ms (typical).",
                cite="7.5 Electrical Characteristics",
            ),
            Step(
                "registers",
                "Write 21 registers",
                "One WREG per register: 250 SPS, gain 24 on CH1 and CH2, CH3–CH8 off, SRB1 as the reference. "
                "CONFIG1 turns on the CLK output.",
                "registers",
                quote="Write Certain Registers, Including Input Short",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
            Step(
                "readback",
                "Read the registers back",
                "RREG reads each register on DOUT. The firmware's loop skips CH1SET and MISC1.",
                "readback",
                quote="RREG: Read n nnnn registers starting at address r rrrr",
                cite="Table 10. Command Definitions",
            ),
            Step(
                "start-pin",
                "START pin high",
                "Conversions start. The digital filter needs 32,777 clock cycles (16 ms) before the first result.",
                "start-pin",
                quote="Activate Conversion. Set START = 1. After This Point DRDY Toggles at fCLK / 8192",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
            Step(
                "start-cmd",
                "START command (08h)",
                "The firmware also sends the START command. The START pin is already high, so it does nothing.",
                "start-cmd",
                quote="Tie the START pin low to control conversions by command. If conversions are in progress, "
                "this command has no effect.",
                cite="9.5.3.5 START: Start Conversions",
            ),
            Step(
                "first-data",
                "First data ready",
                "The firmware waits 20 ms. DRDY falls when each result is ready, every 4 ms. Nobody reads them yet.",
                "filter-wait",
                moments=["first-drdy"],
                quote="DRDY is an output signal which transitions from high to low indicating new conversion data are ready.",
                cite="9.4.4.1 Data Ready (DRDY)",
            ),
            Step(
                "rdatac",
                "RDATAC (10h)",
                "Back to continuous-read mode: from now on, each DRDY means a new frame is ready to shift out.",
                "rdatac",
                quote="Put the Device Back in RDATAC Mode",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
            Step(
                "streams",
                "Data streams",
                "At each DRDY, the ESP32 reads 27 bytes. VREFP is still settling, so the first results read too large.",
                "streaming",
                moments=["first-read"],
                quote="Look for DRDY and Issue 24 + n x 24 SCLKs",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
        ],
        end="streaming",
        end_offset=0.6,
    ),
    Sequence(
        "steady",
        "Steady state",
        "Streaming at 250 samples per second while the player looks left and right.",
        [
            Step(
                "eyes",
                "Eye movements",
                "Looking left and right moves CH1 and CH2 in opposite directions. Brain Pong turns this into paddle position.",
                "steady",
                offset=2.0,
                speeds=("real",),
                cap=7.5,
                quote="The device provides 24 bits of data in binary twos complement format.",
                cite="9.5.1 Data Format",
            ),
            Step(
                "frames",
                "Every 4 ms",
                "DRDY falls, the ESP32 pulls CS low and clocks out one frame, then waits for the next DRDY.",
                "steady",
                offset=3.0,
                speeds=("ms",),
                cap=13.0,
                quote="After This Point DRDY Toggles at fCLK / 8192",
                cite="Figure 67. Initial Flow at Power-Up",
            ),
            Step(
                "bits",
                "One frame, bit by bit",
                "The first 72 of the frame's 216 bits: 24 status bits, then CH1 and CH2, MSB first. CH3 to CH8 follow the same way.",
                "frame",
                speeds=("us",),
                cap=25.0,
                quote="For the 8-channel ADS1299, the number of data outputs is [(24 status bits + 24 bits × 8 channels) = 216 bits]. "
                "The format of the 24 status bits is: (1100 + LOFF_STATP + LOFF_STATN + bits[4:7] of the GPIO register).",
                cite="9.4.4.2 Reading Back Data",
            ),
        ],
        end="sdatac-2",
    ),
    Sequence(
        "shut-down",
        "Shutdown",
        "A clean shutdown with the datasheet's commands. The Brain Pong firmware has none: it loses power when unplugged.",
        [
            Step(
                "sdatac",
                "SDATAC (11h)",
                "Leave continuous-read mode first. In RDATAC mode the chip ignores every other command.",
                "sdatac-2",
                quote="If the device is in RDATAC mode, a SDATAC command must be issued before any other commands can be sent to the device.",
                cite="9.5.3.7 RDATAC: Read Data Continuous",
            ),
            Step(
                "stop",
                "STOP (0Ah)",
                "Stop conversions. The one in progress still finishes.",
                "stop",
                quote="When the STOP command is sent, the conversion in progress completes and further conversions are stopped.",
                cite="9.5.3.6 STOP: Stop Conversions",
            ),
            Step(
                "last",
                "Last result",
                "DRDY falls one more time. Nobody reads it, and no new result follows.",
                "last-conversion",
                moments=["last-drdy"],
                quote="When the STOP command is sent, the conversion in progress completes and further conversions are stopped.",
                cite="9.5.3.6 STOP: Stop Conversions",
            ),
            Step(
                "standby",
                "STANDBY (04h)",
                "Low-power standby: everything off except the reference.",
                "standby",
                quote="The STANDBY command enters low-power standby mode. All parts of the circuit are shut down except for the reference section.",
                cite="9.5.3.3 STANDBY: Enter STANDBY Mode",
            ),
            Step(
                "bias-off",
                "Bias drive off",
                "BIASOUT stops driving, the body floats, and mains hum comes back on the electrodes. VREFP holds.",
                "bias-off",
                quote="All parts of the circuit are shut down except for the reference section.",
                cite="9.5.3.3 STANDBY: Enter STANDBY Mode",
            ),
            Step(
                "pwdn",
                "PWDN low",
                "Full power-down. VREFP and VCAP1 discharge through the chip's resistor network.",
                "pwdn",
                quote="When PWDN is pulled low, all on-chip circuitry is powered down.",
                cite="9.4.3 Power-Down (PWDN)",
            ),
            Step(
                "supplies-off",
                "Supplies off",
                "AVDD and DVDD fall. The ESP32 loses power too, so every line goes low.",
                "supplies-off",
                quote="Before device power up, all digital and analog inputs must be low.",
                cite="11.1 Power-Up Sequencing",
            ),
        ],
        end="end",
        end_offset=0.3,
    ),
]


@dataclass
class Region:
    """A stretch of real time that plays without a skip."""

    tp: float  # playback starts here
    t1: float  # and stops here
    t0: float = 0.0  # data starts one screen earlier, so the scopes open full


@dataclass
class Plan:
    steps: list[Step]
    anchors: list[float]  # real time of each step's moment
    regions: list[Region]
    starts: list[tuple[int, float]]  # for each step: region index, real time where playback starts


def plan(seq: Sequence, speed: Speed, marks: dict[str, float]) -> Plan:
    """Which stretches of real time play at this speed. Each moment plays from LEAD before it
    to CAP after it; overlapping stretches join, and the player skips the gaps between them."""
    r = speed.rate
    steps = [s for s in seq.steps if not s.speeds or speed.id in s.speeds]
    anchors = [marks[s.start] + s.offset for s in steps]
    end = marks[seq.end] + seq.end_offset
    spans = []
    for step, a in zip(steps, anchors):
        for m in [a] + [marks[x] for x in step.moments]:
            spans.append((m - LEAD * r, min(m + step.cap * r, end)))
    spans.sort()
    regions: list[Region] = []
    for a, b in spans:
        if regions and a <= regions[-1].t1:
            regions[-1].t1 = max(regions[-1].t1, b)
        else:
            regions.append(Region(a, b))
    for reg in regions:
        reg.t0 = reg.tp - SCREEN * r
    starts = []
    for a in anchors:
        t = a - LEAD * r
        k = next(i for i, reg in enumerate(regions) if reg.tp <= t + 1e-12 <= reg.t1 + 1e-12)
        starts.append((k, t))
    return Plan(steps, anchors, regions, starts)


def add_marks(run: Run) -> None:
    """Marks the website needs that the run does not set itself."""
    marks = run.log.marks
    reads = [e for e in run.log.events if e.kind == "read"]
    marks["frame"] = next(e.t0 for e in reads if e.t0 > marks["steady"] + 3.0) - board.CS_DELAY
    marks["first-read"] = next(e.t0 for e in reads if e.t0 > marks["streaming"]) - board.CS_DELAY
    d = run.chip.drdy
    falls = [t for t, a, b in zip(d.times[1:], d.levels, d.levels[1:]) if a == 1 and b == 0]
    marks["first-drdy"] = next(t for t in falls if t > marks["start-pin"])
    marks["last-drdy"] = max(t for t in falls if t < marks["standby"])


def sample(probe: Probe, t0: float, t1: float, n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    edges = np.linspace(t0, t1, n + 1)
    lo, hi = probe.wave.minmax(edges[:-1], edges[1:])
    if probe.noise:
        lo = lo - np.abs(rng.normal(0, probe.noise, n))
        hi = hi + np.abs(rng.normal(0, probe.noise, n))
    return lo, hi
