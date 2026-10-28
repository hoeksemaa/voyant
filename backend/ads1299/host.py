"""The microcontroller side: the Brain Pong firmware, ported line by line.

Source: pong-firmware/esp32_firmware/esp32_firmware.ino (setup(), ADS1299_SETUP(),
ADS1299_WREG(), read_ADS1299_data()). Each call here moves the clock forward by the
time the real code takes, and drives the pins the real code drives.
"""

from __future__ import annotations

from . import board
from . import datasheet as ds
from .body import Body
from .chip import Chip
from .log import WARN, Log
from .waves import Digital, Points

# pong-firmware ADS1299_REGISTER_LS, in the order the firmware writes it.
FIRMWARE_REGISTERS = [
    (0x01, 0b10110110),  # CONFIG1: 250 SPS, CLK_EN = 1
    (0x02, 0b11010000),  # CONFIG2: internal test signal source
    (0x03, 0b11101100),  # CONFIG3: reference buffer on, bias drive on, BIASREF internal
    (0x04, 0x00),  # LOFF
    (0x05, 0b01100000),  # CH1SET: on, gain 24, normal input
    (0x06, 0b01100000),  # CH2SET: on, gain 24, normal input
    *[(0x07 + n, 0b10000001) for n in range(6)],  # CH3SET-CH8SET: off, input shorted
    (0x0D, 0b00000011),  # BIAS_SENSP: CH1 and CH2
    (0x0E, 0x00),
    (0x0F, 0x00),
    (0x10, 0x00),
    (0x11, 0x00),
    (0x15, 0b00100000),  # MISC1: SRB1 to all negative inputs
    (0x16, 0x00),
    (0x17, 0x00),
]


class Host:
    def __init__(self, log: Log, chip: Chip):
        self.log = log
        self.chip = chip
        self.t = 0.0
        rail = chip.dvdd  # the ESP32 runs from the same 3.3 V supply
        # Before setup() runs, the ESP32 pins float; the datasheet asks for them low.
        self.lines = {name: Digital(rail, 0) for name in ("PWDN", "RESET", "START", "CS", "SCLK", "DIN")}
        self.uv = {1: Points(), 2: Points()}  # decoded channel data, as the host sees it

    def mark(self, name: str) -> None:
        self.log.mark(name, self.t)

    def wait(self, seconds: float) -> None:
        self.chip.advance(self.t + seconds)
        self.t += seconds

    def write(self, pin: str, level: int) -> None:
        """digitalWrite()"""
        self.lines[pin].set(self.t, level)
        self.chip.set_pin(pin, self.t, level)
        self.t += board.GPIO_WRITE

    def transfer(self, byte: int) -> int:
        """vspi->transfer(): one byte in SPI mode 1, MSB first."""
        half = 0.5 / board.SCLK_HZ
        received = 0
        for i in range(8):
            bit = (byte >> (7 - i)) & 1
            self.lines["SCLK"].set(self.t, 1)
            self.lines["DIN"].set(self.t, bit)
            received = (received << 1) | self.chip.sclk_rise(self.t)
            self.t += half
            self.lines["SCLK"].set(self.t, 0)
            self.chip.sclk_fall(self.t, bit)
            self.t += half
        self.lines["DIN"].set(self.t, 0)
        self.t += board.BYTE_GAP
        return received

    def _frame(self, data: list[int]) -> list[int]:
        """CS low, short delay, bytes, short delay, CS high (the firmware's pattern)."""
        self.write("CS", 0)
        self.t += board.CS_DELAY
        out = [self.transfer(b) for b in data]
        self.t += board.CS_DELAY
        self.write("CS", 1)
        return out

    def command(self, name: str) -> None:
        self._frame([ds.OPCODES[name]])

    def wreg(self, addr: int, value: int) -> None:
        self._frame([0x40 | addr, 0x00, value])

    def rreg(self, addr: int) -> int:
        return self._frame([0x20 | addr, 0x00, 0x00])[2]

    def read_frame(self) -> bytes:
        """read_ADS1299_data(): 27 bytes, then convert channels 1 and 2 to microvolts."""
        start = self.t
        raw = bytes(self._frame([0x00] * ds.FRAME_BYTES))
        if self.chip.converting:
            ok = self.t < self.chip.next_conv
            self.log.check(self.t, "read-before-next", ok, f"Read took {(self.t - start) * 1e6:.0f} µs of the 4 ms between results")
        status = int.from_bytes(raw[:3], "big")
        texts = [f"status {status:06X}h"]
        for ch in (1, 2):
            code = int.from_bytes(raw[3 * ch : 3 * ch + 3], "big", signed=True)
            gain = ds.GAINS[(self.chip.regs[0x04 + ch] >> 4) & 0x07]
            uv = code * ds.VREF / gain / (2**23 - 1) * 1e6  # the BrainFlow Cerelog driver's scale
            self.uv[ch].add(self.t, uv)
            texts.append(f"CH{ch} {uv:+.1f} µV")
        self.log.event(start, self.t, "read", "Read: " + ", ".join(texts))
        return raw


def bring_up(host: Host) -> None:
    """Power on, then setup() from the Brain Pong firmware."""
    chip = host.chip
    host.mark("power")
    chip.supplies_on(host.t)
    chip.body.float_up(host.t)
    host.wait(board.HOST_BOOT)

    host.mark("setup")
    for pin in ("PWDN", "RESET", "START"):
        host.write(pin, 0)  # pinMode(OUTPUT) drives low
    host.write("CS", 1)
    host.wait(2.0)  # delay(2000)
    host.wait(0.5)  # SPI begin, delay(500)

    # ADS1299_SETUP()
    host.mark("hold")
    host.write("PWDN", 0)
    host.write("RESET", 0)
    host.wait(0.1)
    host.mark("release")
    host.write("PWDN", 1)
    host.write("RESET", 1)
    host.wait(1.0)
    host.mark("sdatac")
    host.command("SDATAC")
    host.t += 10e-6
    host.mark("config3")
    host.wreg(0x03, 0b11101100)
    host.mark("ref-wait")
    host.wait(10e-3)
    host.mark("registers")
    for addr, value in FIRMWARE_REGISTERS:
        host.wreg(addr, value)
        host.t += 10e-6  # delayMicroseconds(10)

    # print_all_ADS1299_registers_from_setup(): its loop skips the entry after each
    # placeholder, so CH1SET and MISC1 are never read back.
    host.mark("readback")
    skip = {0x05, 0x15}
    for addr, _ in FIRMWARE_REGISTERS:
        if addr in skip:
            continue
        host.rreg(addr)
        host.t += 2e-6
    host.t += 20e-6  # waitForTimestamp(), attachInterrupt()

    host.mark("start-pin")
    host.write("START", 1)
    host.wait(10e-3)  # delay(10)
    host.mark("start-cmd")
    host.command("START")
    host.mark("filter-wait")
    host.wait(20e-3)  # delay(20)
    host.mark("rdatac")
    host.command("RDATAC")
    host.mark("streaming")
    ref_age = host.t - chip.ref_on_at
    host.log.check(
        host.t,
        "ref-settled",
        ref_age >= ds.REF_STARTUP or WARN,
        f"Data capture starts {ref_age * 1e3:.0f} ms after the reference was turned on (start-up is 150 ms typical)",
    )


def stream(host: Host, until: float) -> None:
    """loop(): wait for DRDY to fall, then read one frame."""
    chip = host.chip
    while True:
        next_drdy = chip.next_conv
        if next_drdy + board.DRDY_LATENCY > until:
            host.wait(max(0.0, until - host.t))
            return
        host.wait(next_drdy + board.DRDY_LATENCY - host.t)
        host.read_frame()


def shut_down(host: Host) -> None:
    """A clean shutdown with the datasheet's commands. The Brain Pong firmware has none;
    it loses power when the USB cable comes out."""
    host.wait(20e-6)
    host.mark("sdatac-2")
    host.command("SDATAC")  # in RDATAC mode, the chip accepts no other command first
    host.wait(10e-6)
    host.mark("stop")
    host.command("STOP")
    host.mark("last-conversion")
    host.wait(6e-3)  # the conversion in progress finishes; nobody reads it
    host.mark("standby")
    host.command("STANDBY")
    host.mark("bias-off")
    host.wait(60e-3)
    host.mark("pwdn")
    host.write("PWDN", 0)
    host.wait(1.0)
    host.mark("supplies-off")
    host.chip.supplies_off(host.t)
    host.wait(25e-3)
    host.mark("end")


class Run:
    """One full run: bring-up, steady streaming, and shutdown, on one timeline."""

    def __init__(self, stream_seconds: float = 9.5, seed: int = 7):
        self.log = Log()
        self.body = Body(seed=seed, duration=60.0)
        self.chip = Chip(self.log, self.body)
        self.host = Host(self.log, self.chip)
        bring_up(self.host)
        self.host.mark("steady")
        stream(self.host, self.host.t + stream_seconds)
        shut_down(self.host)
