"""The model against the datasheet, and the checker against the Brain Pong firmware."""

import math

import numpy as np
import pytest

from ads1299 import datasheet as ds
from ads1299.body import Body
from ads1299.chip import Chip
from ads1299.host import Host, Run
from ads1299.log import Log


def powered() -> Host:
    """A chip with supplies on, PWDN and RESET high, and time to settle."""
    log = Log()
    chip = Chip(log, Body())
    host = Host(log, chip)
    chip.supplies_on(0.0)
    host.wait(5e-3)
    host.write("CS", 1)
    host.write("PWDN", 1)
    host.write("RESET", 1)
    host.wait(0.2)
    return host


def falls(wave) -> list[float]:
    """Times where a digital line goes from high to low."""
    return [t for t, a, b in zip(wave.times[1:], wave.levels, wave.levels[1:]) if a == 1 and b == 0]


@pytest.fixture(scope="module")
def run() -> Run:
    return Run(stream_seconds=1.0)


def test_timing_constants_match_the_datasheet():
    assert ds.T_POR == pytest.approx(128e-3, rel=1e-3)  # 2^18 tCLK
    assert ds.conversion_period(0b110) == pytest.approx(4e-3)  # 250 SPS
    assert ds.SETTLE_TCLK[0b110] * ds.T_CLK == pytest.approx(16.0e-3, rel=1e-2)
    assert ds.T_SDECODE == pytest.approx(1.95e-6, rel=1e-2)  # "tSDECODE (4 tCLK) is 1.96 us"


def test_rreg_is_ignored_in_rdatac_mode():
    host = powered()
    host.rreg(0x00)
    assert any(c.rule == "rdatac-only-sdatac" for c in host.log.checks)


def test_registers_read_their_defaults():
    host = powered()
    host.command("SDATAC")
    for addr, (_, default) in ds.REGISTERS.items():
        assert host.rreg(addr) == default, f"register {addr:02X}h"


def test_wreg_then_rreg():
    host = powered()
    host.command("SDATAC")
    host.wreg(0x05, 0x60)
    host.wreg(0x15, 0x20)
    assert host.rreg(0x05) == 0x60
    assert host.rreg(0x15) == 0x20
    assert host.rreg(0x00) == 0x3E  # ID is read-only


def test_drdy_starts_after_settling_then_runs_at_250_sps():
    host = powered()
    t_start = host.t
    host.write("START", 1)
    host.wait(50e-3)
    edges = falls(host.chip.drdy)
    assert edges[0] - t_start == pytest.approx(ds.SETTLE_TCLK[6] * ds.T_CLK, abs=1e-6)
    assert np.diff(edges) == pytest.approx(4e-3, abs=1e-9)


def test_test_signal_reads_its_datasheet_amplitude():
    """CONFIG2 = D0h and CHnSET = 65h: a 1.875 mV square wave (1 mV x VREF / 2.4) at gain 24."""
    host = powered()
    host.command("SDATAC")
    host.wreg(0x03, 0xE0)  # internal reference on
    host.wreg(0x02, 0xD0)
    host.wreg(0x05, 0x65)
    host.wait(1.0)  # let VREFP settle
    host.write("START", 1)
    host.wait(0.6)
    codes = np.array([c[1][0] for c in host.chip.codes])
    expected = 1e-3 * ds.VREF / 2.4 * 24 / ds.VREF * 2**23
    flat = codes[np.abs(np.abs(codes) - expected) < 0.05 * expected]  # skip samples on an edge
    assert len(flat) > 0.8 * len(codes)
    assert np.median(np.abs(flat)) == pytest.approx(expected, rel=2e-3)


def test_dout_on_the_pins_decodes_to_the_frame(run):
    """Read DOUT at each SCLK falling edge, like a logic analyzer, and compare with the chip's data."""
    chip, host = run.chip, run.host
    read = next(e for e in run.log.events if e.kind == "read")
    sclk = host.lines["SCLK"]
    times = np.array(sclk.times[1:])
    levels = np.array(sclk.levels[1:])
    edges = times[(levels == 0) & (times > read.t0) & (times <= read.t1)]
    bits = (chip.dout.at(edges - 1e-9) > 1.5).astype(int)
    assert len(bits) == 8 * ds.FRAME_BYTES
    frame = bytes(int("".join(map(str, bits[i : i + 8])), 2) for i in range(0, len(bits), 8))
    assert frame[:3] == bytes([0xC0, 0x00, 0x00])  # status word: 1100 + lead-off + GPIO
    tc, codes = max((c for c in chip.codes if c[0] < read.t0), key=lambda c: c[0])
    decoded = [int.from_bytes(frame[3 * k + 3 : 3 * k + 6], "big", signed=True) for k in range(8)]
    assert decoded == codes


def test_channel_data_follows_the_input(run):
    """Away from the reference start-up, the host's CH1 data matches the electrode input."""
    host, body = run.host, run.body
    t = np.array(host.uv[1].t)
    late = t[t > t[0] + 0.6]
    from ads1299 import board

    off = (board.ELECTRODE_OFFSET["IN1P"] - board.ELECTRODE_OFFSET["SRB1"]) * 1e6
    data = host.uv[1].at(late) - off
    vin = (body.electrode_v("IN1P", late) - body.electrode_v("SRB1", late)) * 1e6 - off
    assert np.abs(data - vin).max() < 25  # uV; the digital filter adds a few ms of delay


def test_checker_findings_on_the_brain_pong_firmware(run):
    s = run.log.summary()
    assert s["reset-after-por"]["status"] == "fail"  # RESET released with PWDN; VCAP1 still 0 V
    assert s["tSCCS"]["status"] == "fail"  # delayMicroseconds(1) before CS high is under 4 tCLK
    assert s["start-pin-low"]["status"] == "warn"  # START command with the START pin high
    assert s["ref-settled"]["status"] == "warn"  # data capture 41 ms after the reference turns on
    assert s["tSDECODE"]["status"] == "pass"  # 4 MHz SCLK gives enough time between bytes
    assert s["read-before-next"]["status"] == "pass"
    assert s["rdatac-keepout"]["status"] == "pass"


def test_vcap1_charges_with_the_figure_25_time_constant():
    host = powered()
    t0 = host.chip.powered_at
    tau = ds.VCAP1_R1 * ds.VCAP1_C
    v = host.chip.vcap1.value(t0 + tau)
    assert v == pytest.approx(1.2 * (1 - math.exp(-1)), rel=1e-6)


def test_logged_dout_bytes_match_the_frame(run):
    read = next(e for e in run.log.events if e.kind == "read")
    out = [e.text for e in run.log.events if e.kind == "out" and read.t0 <= e.t0 < read.t1]
    assert out[:3] == ["C0", "00", "00"]
    assert len(out) == 27
