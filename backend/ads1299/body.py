"""The person: eye movements, mains hum on the body, and the electrode voltages.

Brain Pong montage: IN1P and IN2P sit at the outer corners of the left and right eye,
and SRB1 is the shared reference. Looking right makes IN2P more positive and IN1P
more negative (the eye is a dipole, positive at the cornea).
"""

from __future__ import annotations

import numpy as np

from . import board
from .waves import Analog, Func


def _gaze_schedule(seed: int, duration: float) -> tuple[np.ndarray, np.ndarray]:
    """Fixations like a Pong game: look left, right, or center, then jump (saccade)."""
    rng = np.random.default_rng(seed)
    times, angles = [0.0], [0.0]
    t = 0.4
    while t < duration:
        last = angles[-1]
        target = rng.choice([a for a in (-25.0, 0.0, 25.0) if a != last]) + rng.normal(0, 3)
        times.append(t)
        angles.append(target)
        t += rng.uniform(0.6, 1.4)
    return np.array(times), np.array(angles)


class Body:
    def __init__(self, seed: int = 7, duration: float = 30.0):
        rng = np.random.default_rng(seed)
        self.gaze_t, self.gaze_deg = _gaze_schedule(seed, duration)
        self.blinks = np.sort(rng.uniform(1.0, duration, size=int(duration / 4)))
        # Common-mode voltage of the body, and the amplitude of mains hum on it.
        self.cm = Analog(0.0)
        self.hum = Analog(0.05)
        # Smooth electrode noise: sums of slow random sines (no time-step dependence).
        self._noise = {
            name: (rng.uniform(5, 45, 24), rng.uniform(0, 2 * np.pi, 24)) for name in board.ELECTRODE_OFFSET
        }
        self._drift = {name: rng.uniform(0, 2 * np.pi) for name in board.ELECTRODE_OFFSET}

    # Bias drive on: the body is pulled to mid-supply and most hum cancels.
    def bias_on(self, t: float, level: float) -> None:
        self.cm.go(t, level, board.BODY_TAU)
        self.hum.go(t, board.BODY_BIASED_HUM, board.BODY_TAU)

    def bias_off(self, t: float) -> None:
        self.cm.go(t, board.BODY_FLOAT_V, 0.2)
        self.hum.go(t, board.BODY_FLOAT_HUM, 0.05)

    def float_up(self, t: float) -> None:
        """Electrodes on, no bias yet: the body floats and picks up hum."""
        self.cm.go(t, board.BODY_FLOAT_V, 0.2)
        self.hum.go(t, board.BODY_FLOAT_HUM, 0.05)

    def gaze(self, t: np.ndarray) -> np.ndarray:
        """Gaze angle in degrees. Each saccade takes about 50 ms."""
        out = np.zeros_like(t)
        prev = self.gaze_deg[0]
        for t0, a in zip(self.gaze_t[1:], self.gaze_deg[1:]):
            out += (a - prev) / (1 + np.exp(np.clip(-(t - t0) / 0.008, -60, 60)))
            prev = a
        return out + self.gaze_deg[0]

    def eog_uv(self, t: np.ndarray, side: int) -> np.ndarray:
        """EOG at one eye-corner electrode, in uV; side = -1 for left (IN1P), +1 for right (IN2P)."""
        blink = sum(60.0 * np.exp(-(((t - b) / 0.09) ** 2)) for b in self.blinks)
        return side * board.EOG_UV_PER_DEG * self.gaze(t) + blink

    def _noise_uv(self, name: str, t: np.ndarray) -> np.ndarray:
        freqs, phases = self._noise[name]
        n = np.sin(2 * np.pi * freqs[None, :] * t[:, None] + phases[None, :]).sum(axis=1)
        drift = 25.0 * np.sin(2 * np.pi * 0.05 * t + self._drift[name])
        return board.ELECTRODE_NOISE_UV * n / np.sqrt(len(freqs) / 2) + drift

    def body_v(self, t: np.ndarray) -> np.ndarray:
        return self.cm.at(t) + self.hum.at(t) * np.sin(2 * np.pi * board.MAINS_HZ * t)

    def electrode_v(self, name: str, t: np.ndarray) -> np.ndarray:
        """Absolute voltage at one electrode pin."""
        t = np.asarray(t, dtype=float)
        uv = self._noise_uv(name, t)
        if name == "IN1P":
            uv = uv + self.eog_uv(t, -1)
        elif name == "IN2P":
            uv = uv + self.eog_uv(t, +1)
        # Unequal electrode impedances turn a small part of the common-mode hum into a
        # difference between electrodes.
        imbalance = {"IN1P": 1.0, "IN2P": -0.6, "SRB1": 0.0}[name] * board.HUM_IMBALANCE
        hum = self.hum.at(t) * np.sin(2 * np.pi * board.MAINS_HZ * t)
        return self.body_v(t) + board.ELECTRODE_OFFSET[name] + uv * 1e-6 + imbalance * hum

    def wave(self, name: str) -> Func:
        return Func(lambda t: self.electrode_v(name, t))
