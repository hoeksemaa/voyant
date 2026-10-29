# Backend

A Python model of the ADS1299 and of the Brain Pong firmware that drives it.

The firmware side moves the pins the way the real ESP32 code does. The chip side reacts the way the datasheet says.
A checker compares each step with the datasheet's timing rules.

## Run it

```
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
.venv/bin/python -m ads1299.export   # writes frontend/public/sim/*.json
```

## What the checker finds in the Brain Pong firmware

| Rule | Result |
|---|---|
| Reset after power-on (11.1) | Fails: RESET goes high with PWDN, while VCAP1 is still 0 V |
| CS high after the last SCLK (tSCCS) | Fails: about 1.7 µs; the minimum is 1.95 µs |
| START command with the START pin low (9.5.3.5) | Warning: the pin is already high |
| Reference settled before data (150 ms) | Warning: capture starts after 41 ms |
| Gap between command bytes (tSDECODE) | Passes at 4 MHz SCLK |

## Files

- `ads1299/datasheet.py`: numbers and tables from the datasheet.
- `ads1299/board.py`: board and body numbers that are not in the datasheet (assumptions).
- `ads1299/chip.py`: the chip: power, reset, SPI, registers, reference, bias, conversions.
- `ads1299/host.py`: the Brain Pong firmware, ported step by step.
- `ads1299/body.py`: eye movements, mains hum, and electrode voltages.
- `ads1299/waves.py`: pin voltages over time.
- `ads1299/log.py`: decoded bus traffic, notes, and the datasheet rules.
- `ads1299/sequences.py` and `export.py`: the steps the website plays, at each of the three speeds.
