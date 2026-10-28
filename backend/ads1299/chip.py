"""The ADS1299, modeled from its pins inward.

The host (host.py) drives the input pins and clocks the serial bus. The chip reacts the
way the datasheet describes: power states, the reset, SPI command decode, the register
map, the internal reference and bias drive, and conversions that end in DRDY going low.
"""

from __future__ import annotations

import math

import numpy as np

from . import board
from . import datasheet as ds
from .body import Body
from .log import WARN, Log, fmt
from .waves import Analog, Clock, Digital

SUB = 32  # input samples per conversion period, for the digital filter model


def _sinc3(n: int) -> np.ndarray:
    """Weights of a sinc^3 filter that decimates by n: three box filters in a row."""
    box = np.ones(n)
    w = np.convolve(np.convolve(box, box), box)
    return w / w.sum()


class Chip:
    def __init__(self, log: Log, body: Body):
        self.log = log
        self.body = body
        self.avdd = Analog(0.0)
        self.dvdd = Analog(0.0)
        # Pins the chip drives
        self.vcap1 = Analog(0.0)
        self.vrefp = Analog(0.0)
        self.biasout = Analog(math.nan)
        self.clk = Clock(self.dvdd, ds.F_CLK)
        self.drdy = Digital(self.dvdd, 1)  # the host's pull-up holds DRDY high when not driven
        self.dout = Digital(self.dvdd, None)

        self.supplied = False
        self.pwdn = False  # PWDN pin level (False = low = powered down)
        self.reset_pin = False
        self.start_pin = False
        self.powered_at = math.inf
        self.regs = {a: v for a, (_, v) in ds.REGISTERS.items()}
        self.mode = "RDATAC"
        self.standby = False
        self.ref_on_at = math.inf
        self.bias_on = False

        # Conversions
        self.converting = False
        self.next_conv = math.inf
        self.stop_after: float | None = None
        self.started_at = math.inf
        self.first_data = True
        self.unread = False
        self.frame = bytes(ds.FRAME_BYTES)
        self.codes: list[tuple[float, list[int]]] = []

        # Serial interface
        self.cs_low = False
        self.cs_changed = -math.inf
        self.last_fall = -math.inf
        self.bits = 0
        self.nbits = 0
        self.byte_start = 0.0
        self.last_byte_end = -math.inf
        self.rx = "idle"
        self.rx_addr = 0
        self.rx_count = 0
        self.cmd_start = 0.0
        self.out_bits: list[int] = []
        self.out_pos = 0
        self.out_byte = 0  # the byte shifted out on DOUT so far

    # ---- power ----------------------------------------------------------------------------

    @property
    def powered(self) -> bool:
        return self.supplied and self.pwdn

    def supplies_on(self, t: float) -> None:
        self.avdd.go(t, board.AVDD, board.SUPPLY_TAU)
        self.dvdd.go(t, board.DVDD, board.SUPPLY_TAU)
        self.supplied = True
        self.log.note(t, "Supplies on: AVDD 5 V, DVDD 3.3 V")
        if self.pwdn:
            self._power_up(t)

    def supplies_off(self, t: float) -> None:
        if self.powered:
            self._power_down(t)
        # With AVDD gone, the pins' protection diodes clamp the charged capacitors on
        # VCAP1 and VREFP to the falling supply.
        self.vcap1.go(t, 0.0, board.CLAMP_TAU)
        self.vrefp.go(t, 0.0, board.CLAMP_TAU)
        self.avdd.go(t, 0.0, board.SUPPLY_OFF_TAU)
        self.dvdd.go(t, 0.0, board.SUPPLY_OFF_TAU)
        self.supplied = False
        self.log.note(t, "Supplies off")

    def _power_up(self, t: float) -> None:
        self.powered_at = t
        self.regs = {a: v for a, (_, v) in ds.REGISTERS.items()}
        self.mode = "RDATAC"
        self.standby = False
        self.vcap1.go(t, board.VCAP1_FINAL, ds.VCAP1_R1 * ds.VCAP1_C)
        self.drdy.set(t, 1)
        cross = t + ds.VCAP1_R1 * ds.VCAP1_C * math.log(board.VCAP1_FINAL / (board.VCAP1_FINAL - ds.VCAP1_RESET_MIN))
        self.log.note(t, "Chip powers up: oscillator, bandgap, and VCAP1 start")
        self.log.note(t + ds.OSC_STARTUP, "Oscillator running (2.048 MHz)")
        self.log.note(cross, "VCAP1 reaches 1.1 V")
        if self.start_pin:
            self._start(t + ds.OSC_STARTUP)

    def _power_down(self, t: float) -> None:
        self.powered_at = math.inf
        self._stop(t)
        self.clk.stop(t)
        self.vcap1.go(t, 0.0, board.VCAP1_OFF_TAU)
        if self.ref_on_at < math.inf:
            self.vrefp.go(t, 0.0, board.VREFP_OFF_TAU)
            self.ref_on_at = math.inf
        self._bias(t, False)
        self.dout.set(t, None)
        self.log.note(t, "Chip powered down: all circuits off; VCAP1 and VREFP discharge")

    # ---- pins -----------------------------------------------------------------------------

    def set_pin(self, name: str, t: float, level: int) -> None:
        self.advance(t)
        if name == "PWDN":
            was = self.powered
            self.pwdn = bool(level)
            if self.powered and not was:
                self._power_up(t)
            elif was and not self.powered:
                self._power_down(t)
        elif name == "RESET":
            if level and not self.reset_pin and self.powered:
                self._reset(t, "RESET pin released")
            self.reset_pin = bool(level)
        elif name == "START":
            self.start_pin = bool(level)
            if not self.powered or self.standby:
                return
            if level:
                self._start(t)
            else:
                self._stop(t)
        elif name == "CS":
            self._cs(t, bool(level))

    def _reset(self, t: float, how: str) -> None:
        since = t - self.powered_at
        vcap1 = self.vcap1.value(t)
        ok = since >= ds.T_POR and vcap1 >= ds.VCAP1_RESET_MIN
        self.log.check(
            t,
            "reset-after-por",
            ok,
            f"{how} {fmt(since)} after power-up (needs ≥ {fmt(ds.T_POR)}); "
            f"VCAP1 = {vcap1:.2f} V (needs ≥ 1.1 V)",
        )
        self.regs = {a: v for a, (_, v) in ds.REGISTERS.items()}
        self.mode = "RDATAC"
        self._stop(t)
        self._apply_config(t)
        self.log.note(t + ds.T_RESET_INIT, "Reset done: registers at defaults, RDATAC mode")
        if self.start_pin:
            self._start(t + ds.T_RESET_INIT)

    # ---- conversions ----------------------------------------------------------------------

    @property
    def dr(self) -> int:
        return self.regs[0x01] & 0x07

    def _start(self, t: float) -> None:
        settle = ds.SETTLE_TCLK[self.dr] * ds.T_CLK
        self.converting = True
        self.stop_after = None
        self.started_at = t
        self.first_data = True
        self.next_conv = t + settle
        self.log.note(t, f"Conversions start; first data after tSETTLE = {settle * 1e3:.1f} ms")

    def _stop(self, t: float) -> None:
        self.converting = False
        self.next_conv = math.inf

    def advance(self, t: float) -> None:
        """Run every conversion that finishes at or before time t."""
        while self.converting and self.next_conv <= t:
            tc = self.next_conv
            self._convert(tc)
            if self.stop_after is not None and tc >= self.stop_after:
                self._stop(tc)
                self.log.note(tc, "Last conversion done; conversions stopped")
            else:
                self.next_conv = tc + ds.conversion_period(self.dr)

    def _channel_input(self, ch: int, t: np.ndarray, setting: int) -> np.ndarray:
        """Differential voltage the channel's PGA sees, for an array of times."""
        mux = setting & 0x07
        if mux == 0b000:  # normal electrode input
            pos = f"IN{ch}P"
            if pos not in board.ELECTRODE_OFFSET:
                return np.zeros_like(t)  # unused inputs tied to AVDD on the board
            vp = self.body.electrode_v(pos, t)
            if self.regs[0x15] & 0x20:  # MISC1.SRB1: SRB1 to all negative inputs
                vn = self.body.electrode_v("SRB1", t)
            else:
                vn = self.body.body_v(t)
            return vp - vn
        if mux == 0b101:  # internal test signal (CONFIG2)
            c2 = self.regs[0x02]
            amp = (2 if c2 & 0x04 else 1) * 1e-3 * self.vrefp.value(float(t[-1])) / 2.4
            div = 2**20 if (c2 & 0x03) == 0b01 else 2**21
            return np.where(((t * ds.F_CLK / div) % 1.0) < 0.5, amp, -amp)
        return np.zeros_like(t)  # input shorted, or a mode this model does not cover

    def _convert(self, tc: float) -> None:
        period = ds.conversion_period(self.dr)
        w = _sinc3(SUB)
        ts = tc - period / SUB * np.arange(len(w))[::-1]
        vref = self.vrefp.value(tc)
        rng = np.random.default_rng(int(tc * 1e7) & 0xFFFFFFFF)
        noise_rms = ds.NOISE_UVPP / 6.6 * 1e-6
        codes = []
        for ch in range(1, 9):
            setting = self.regs[0x04 + ch]
            gain = ds.GAINS.get((setting >> 4) & 0x07, 1)
            if setting & 0x80:  # channel powered down
                codes.append(0)
                continue
            vin = float(w @ self._channel_input(ch, ts, setting)) + rng.normal(0, noise_rms)
            if abs(vin) > ds.VREF / gain:
                self.log.check(tc, "full-scale", WARN, f"CH{ch}: {vin * 1e3:.1f} mV is past ±{ds.VREF / gain * 1e3:.1f} mV")
            code = round(vin * gain / max(vref, 1e-3) * 2**23)
            codes.append(max(-(2**23), min(2**23 - 1, code)))
        status = 0xC00000 | (self.regs[0x12] << 12) | (self.regs[0x13] << 4) | ((self.regs[0x14] >> 4) & 0x0F)
        raw = status.to_bytes(3, "big") + b"".join((c & 0xFFFFFF).to_bytes(3, "big") for c in codes)
        self.frame = raw
        self.codes.append((tc, codes))

        # DRDY: if the last result was never read, DRDY pulses high 4 tCLK before the new one.
        if self.unread:
            self.drdy.set(tc - 4 * ds.T_CLK, 1)
        self.drdy.set(tc, 0)
        self.unread = True
        if self.mode == "RDATAC":
            self._load_output(raw)
        if self.first_data:
            self.first_data = False
            self.log.note(tc, f"First data ready ({(tc - self.started_at) * 1e3:.1f} ms after START)")

    # ---- serial interface -----------------------------------------------------------------

    def _load_output(self, data: bytes) -> None:
        self.out_bits = [(byte >> (7 - i)) & 1 for byte in data for i in range(8)]
        self.out_pos = 0

    def _cs(self, t: float, high: bool) -> None:
        if high and self.cs_low:
            if self.last_fall > self.cs_changed:
                gap = t - self.last_fall
                self.log.check(t, "tSCCS", gap >= ds.T_SCCS, f"{fmt(gap)} from the last SCLK falling edge to CS high (needs ≥ {fmt(ds.T_SCCS)})", gap - ds.T_SCCS)
            self.cs_low = False
            self.dout.set(t, None)
            self.nbits = 0
            self.rx = "idle"
        elif not high and not self.cs_low:
            if self.cs_changed > -math.inf:
                gap = t - self.cs_changed
                self.log.check(t, "tCSH", gap >= ds.T_CSH, f"CS high for {fmt(gap)} (needs ≥ {fmt(ds.T_CSH)})", gap - ds.T_CSH)
            self.cs_low = True
            self.dout.set(t, 0 if self.powered else None)
        self.cs_changed = t

    def sclk_rise(self, t: float) -> int:
        """SCLK rising edge: the chip puts its next output bit on DOUT (SPI mode 1)."""
        self.advance(t)
        if not self.cs_low or not self.powered:
            return 0
        if self.nbits == 0:
            self.byte_start = t
        bit = 0
        if self.out_pos < len(self.out_bits):
            bit = self.out_bits[self.out_pos]
            self.out_pos += 1
            if self.mode == "RDATAC" and self.out_pos == len(self.out_bits):
                self.out_pos = 0  # in RDATAC, more SCLKs repeat the data from the start
        self.dout.set(t + 10e-9, bit)
        self.out_byte = ((self.out_byte << 1) | bit) & 0xFF
        return bit

    def sclk_fall(self, t: float, din: int) -> None:
        """SCLK falling edge: the chip samples DIN; the eighth edge completes a byte."""
        self.advance(t)
        if not self.cs_low or not self.powered:
            return
        self.last_fall = t
        if self.drdy.level(t) == 0:
            self.drdy.set(t, 1)  # DRDY returns high on the first SCLK falling edge
            self.unread = False
        self.bits = ((self.bits << 1) | din) & 0xFF
        self.nbits += 1
        if self.nbits == 8:
            self.nbits = 0
            self._byte(self.bits, self.byte_start, t)

    def _name(self, addr: int) -> str:
        return ds.REGISTERS.get(addr, (f"{addr:02X}h", 0))[0]

    def _byte(self, b: int, t0: float, t: float) -> None:
        self.log.event(t0, t, "byte", f"{b:02X}")
        self.log.event(t0, t, "out", f"{self.out_byte:02X}")
        if self.rx in ("wreg-n", "rreg-n", "wreg-data"):
            spacing = t - self.last_byte_end
            self.log.check(t, "tSDECODE", spacing >= ds.T_SDECODE, f"{fmt(spacing)} between byte ends (needs ≥ {fmt(ds.T_SDECODE)})", spacing - ds.T_SDECODE)
        self.last_byte_end = t

        if self.rx == "idle":
            self.cmd_start = t0
            if self.mode == "RDATAC" and b not in (0x00, ds.OPCODES["SDATAC"]):
                self.log.check(t, "rdatac-only-sdatac", WARN, f"{ds.COMMANDS.get(b, f'{b:02X}h')} sent in RDATAC mode was ignored")
                return
            if b & 0xE0 == 0x20:
                self.rx, self.rx_addr = "rreg-n", b & 0x1F
            elif b & 0xE0 == 0x40:
                self.rx, self.rx_addr = "wreg-n", b & 0x1F
            elif b in ds.COMMANDS:
                self._command(ds.COMMANDS[b], t0, t)
        elif self.rx == "rreg-n":
            n = (b & 0x1F) + 1
            data = bytes(self.regs.get(self.rx_addr + i, 0) for i in range(n))
            self._load_output(data)
            names = ", ".join(f"{self._name(self.rx_addr + i)} → {d:02X}h" for i, d in enumerate(data))
            self.log.event(self.cmd_start, t + 8 * n / board.SCLK_HZ, "command", f"RREG {names}")
            self.rx, self.rx_count = "rreg-data", n
        elif self.rx == "rreg-data":
            self.rx_count -= 1
            if self.rx_count == 0:
                self.rx = "idle"
        elif self.rx == "wreg-n":
            self.rx, self.rx_count = "wreg-data", (b & 0x1F) + 1
        elif self.rx == "wreg-data":
            addr = self.rx_addr
            self.log.event(self.cmd_start, t, "command", f"WREG {self._name(addr)} ← {b:02X}h")
            if addr not in ds.READ_ONLY:
                self._write(addr, b, t)
            self.rx_addr += 1
            self.rx_count -= 1
            self.cmd_start = t
            if self.rx_count == 0:
                self.rx = "idle"

    def _command(self, name: str, t0: float, t: float) -> None:
        self.log.event(t0, t, "command", name)
        if name == "SDATAC":
            self.mode = "SDATAC"
            self.out_bits = []
        elif name == "RDATAC":
            near = min(abs(t - tc) for tc in [self.next_conv, *(c[0] for c in self.codes[-1:])]) if self.converting else math.inf
            self.log.check(t, "rdatac-keepout", near >= 4 * ds.T_CLK, f"{fmt(near)} from the nearest DRDY (needs ≥ 4 tCLK)" if near < math.inf else "No conversions running", near)
            self.mode = "RDATAC"
        elif name == "START":
            if self.start_pin:
                self.log.check(t, "start-pin-low", WARN, "START command sent while the START pin is high; conversions were already running, so it had no effect")
            elif not self.converting:
                self._start(t)
        elif name == "STOP":
            if self.converting:
                self.stop_after = self.next_conv  # the conversion in progress completes
        elif name == "RESET":
            self._reset(t, "RESET command sent")
        elif name == "STANDBY":
            self.standby = True
            self._stop(t)
            self.clk.stop(t)
            self._bias(t, False)
            self.log.note(t, "Standby: all circuits off except the reference")
        elif name == "WAKEUP":
            self.standby = False
            self._apply_config(t + 31.25e-6)
            self.log.note(t, "Wake-up from standby (31.25 µs)")
        elif name == "RDATA":
            self._load_output(self.frame)

    def _write(self, addr: int, value: int, t: float) -> None:
        self.regs[addr] = value
        if addr in (0x01, 0x03):
            self._apply_config(t)
        if addr == 0x01 and self.converting:
            self._start(t)  # writing CONFIG1 resets the digital filter (9.4.2)

    def _apply_config(self, t: float) -> None:
        """Turn the clock output, reference buffer, and bias drive on or off to match the registers."""
        if self.standby or not self.powered:
            return
        c1, c3 = self.regs[0x01], self.regs[0x03]
        if c1 & 0x20:
            if not self.clk.running(t):
                self.clk.start(t)
                self.log.note(t, "CLK pin outputs the oscillator (CONFIG1.CLK_EN = 1)")
        else:
            self.clk.stop(t)
        ref = bool(c3 & 0x80)
        if ref and self.ref_on_at == math.inf:
            self.ref_on_at = t
            self.vrefp.go(t, ds.VREF, ds.REF_STARTUP / 5)
            self.log.note(t, "Reference buffer on: VREFP charges toward 4.5 V")
        elif not ref and self.ref_on_at < math.inf:
            self.ref_on_at = math.inf
            self.vrefp.go(t, 0.0, board.VREFP_OFF_TAU)
        self._bias(t, bool(c3 & 0x04))

    def _bias(self, t: float, on: bool) -> None:
        if on == self.bias_on:
            return
        self.bias_on = on
        if on:
            # BIASREF_INT = 1 sets the bias reference to (AVDD + AVSS) / 2. With BIASREF_INT = 0
            # the board feeds BIASREF; this model assumes the board also uses mid-supply.
            mid = self.avdd.value(t) / 2
            self.biasout.go(t, mid, mid / ds.BIAS_SLEW / 3)
            self.body.bias_on(t, mid)
            self.log.note(t, f"Bias drive on: BIASOUT drives the body to mid-supply ({mid:.2f} V)")
        else:
            self.biasout.go(t, math.nan, 0)
            self.body.bias_off(t)
            self.log.note(t, "Bias drive off: the body floats again")
