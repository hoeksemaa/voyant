"""Voltage-versus-time waveforms for pins and internal nodes.

Every waveform answers one question: over each time interval [a, b), what are the
lowest and highest voltages? That is a scope's peak-detect mode, so a 2 MHz clock
seen over a 1 ms interval shows as a solid band, not as a few random samples.
NaN means the pin is not driven (high impedance).
"""

from __future__ import annotations

import math
from typing import Callable

import numpy as np

SUBSAMPLES = 12  # points per interval for smooth (non-digital) waveforms


def _subsample(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    f = np.linspace(0.0, 1.0, SUBSAMPLES)
    return a[:, None] + (b - a)[:, None] * f[None, :]


def _minmax_of(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    with np.errstate(all="ignore"):
        lo = np.nanmin(np.where(np.isnan(values), np.inf, values), axis=1)
        hi = np.nanmax(np.where(np.isnan(values), -np.inf, values), axis=1)
    lo[np.isinf(lo)] = np.nan
    hi[np.isinf(hi)] = np.nan
    return lo, hi


class Wave:
    def at(self, t: np.ndarray) -> np.ndarray:
        raise NotImplementedError

    def minmax(self, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return _minmax_of(self.at(_subsample(a, b).ravel()).reshape(len(a), SUBSAMPLES))


class Analog(Wave):
    """A node that moves toward a target with a time constant, like a capacitor
    charging through a resistor. Each change starts a new segment from the present value."""

    def __init__(self, v0: float = 0.0):
        self.segs: list[tuple[float, float, float, float]] = [(-math.inf, v0, v0, math.inf)]

    def value(self, t: float) -> float:
        return float(self.at(np.array([t]))[0])

    def go(self, t: float, target: float, tau: float) -> None:
        """From time t, move toward `target` (NaN = stop driving) with time constant tau."""
        assert t >= self.segs[-1][0], "segments must be added in time order"
        v = self.value(t)
        if math.isnan(v):
            v = target
        self.segs.append((t, v, target, max(tau, 1e-12)))

    def at(self, t: np.ndarray) -> np.ndarray:
        t = np.asarray(t, dtype=float)
        starts = np.array([s[0] for s in self.segs])
        idx = np.searchsorted(starts, t, side="right") - 1
        out = np.empty_like(t)
        for i in np.unique(idx):
            m = idx == i
            t0, v0, target, tau = self.segs[i]
            if math.isnan(target):
                out[m] = np.nan
            elif math.isinf(t0):
                out[m] = v0
            else:
                out[m] = target + (v0 - target) * np.exp(-(t[m] - t0) / tau)
        return out


class Digital(Wave):
    """A logic line: 0, 1, or None (not driven). High is the voltage of `rail` at that time."""

    def __init__(self, rail: Wave | float, level: int | None = 0):
        self.rail = rail
        self.times: list[float] = [-math.inf]
        self.levels: list[float] = [math.nan if level is None else float(level)]
        self._t: np.ndarray | None = None

    def set(self, t: float, level: int | None) -> None:
        v = math.nan if level is None else float(level)
        last = self.levels[-1]
        if v == last or (math.isnan(v) and math.isnan(last)):
            return
        if t < self.times[-1]:
            raise ValueError(f"time went backward: {t} < {self.times[-1]}")
        self.times.append(t)
        self.levels.append(v)
        self._t = None

    def level(self, t: float) -> float:
        i = np.searchsorted(self._arrays()[0], t, side="right") - 1
        return self._arrays()[1][i]

    def _arrays(self) -> tuple[np.ndarray, np.ndarray]:
        if self._t is None:
            self._t = np.array(self.times)
            self._v = np.array(self.levels)
        return self._t, self._v

    def _rail(self, t: np.ndarray) -> np.ndarray:
        if isinstance(self.rail, Wave):
            return self.rail.at(t)
        return np.full_like(t, self.rail)

    def at(self, t: np.ndarray) -> np.ndarray:
        times, levels = self._arrays()
        idx = np.searchsorted(times, t, side="right") - 1
        return levels[idx] * self._rail(t)

    def minmax(self, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        times, levels = self._arrays()
        i0 = np.searchsorted(times, a, side="right") - 1
        i1 = np.searchsorted(times, b, side="left") - 1  # last change before b
        lo = levels[i0].copy()
        hi = levels[i0].copy()
        for k in np.nonzero(i1 > i0)[0]:
            seg = levels[i0[k] : i1[k] + 1]
            seg = seg[~np.isnan(seg)]
            if len(seg):
                lo[k], hi[k] = seg.min(), seg.max()
        rail = self._rail((a + b) / 2)
        return lo * rail, hi * rail


class Clock(Wave):
    """A square-wave clock output that runs only while enabled."""

    def __init__(self, rail: Wave, freq: float):
        self.rail = rail
        self.period = 1 / freq
        self.on: list[tuple[float, float]] = []

    def start(self, t: float) -> None:
        if not self.on or self.on[-1][1] < math.inf:
            self.on.append((t, math.inf))

    def stop(self, t: float) -> None:
        if self.on and self.on[-1][1] == math.inf:
            self.on[-1] = (self.on[-1][0], t)

    def running(self, t: float) -> bool:
        return any(s <= t < e for s, e in self.on)

    def at(self, t: np.ndarray) -> np.ndarray:
        high = np.zeros_like(t)
        for s, e in self.on:
            m = (t >= s) & (t < e)
            high[m] = ((t[m] - s) % self.period) < self.period / 2
        return high * self.rail.at(t)

    def minmax(self, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        lo, hi = super().minmax(a, b)
        rail = self.rail.at((a + b) / 2)
        for s, e in self.on:
            # Any enabled stretch longer than half a period holds both levels.
            overlap = np.minimum(b, e) - np.maximum(a, s)
            m = overlap >= self.period / 2
            lo[m], hi[m] = 0.0, rail[m]
        return lo, hi


class Points(Wave):
    """Straight lines through (time, value) points. NaN before the first point, and
    after the last one once `hold` seconds pass with no new point."""

    def __init__(self, hold: float = 8e-3) -> None:
        self.t: list[float] = []
        self.v: list[float] = []
        self.hold = hold

    def add(self, t: float, v: float) -> None:
        self.t.append(t)
        self.v.append(v)

    def at(self, t: np.ndarray) -> np.ndarray:
        if not self.t:
            return np.full_like(t, np.nan)
        out = np.interp(t, self.t, self.v)
        out[(t < self.t[0]) | (t > self.t[-1] + self.hold)] = np.nan
        return out


class Func(Wave):
    def __init__(self, f: Callable[[np.ndarray], np.ndarray]):
        self.f = f

    def at(self, t: np.ndarray) -> np.ndarray:
        return self.f(np.asarray(t, dtype=float))
