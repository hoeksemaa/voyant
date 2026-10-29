# ADS1299 simulator

A software copy of the ADS1299, a chip that measures tiny voltages from the body, and of the firmware that runs it.

The goal: test firmware and host software with no hardware, and get the same results as on a real board.

## The chip

The [ADS1299](https://www.ti.com/product/ADS1299) from Texas Instruments reads 8 channels of very small signals: EEG (brain), EOG (eyes), or ECG (heart).
It amplifies each signal, turns it into numbers, and sends them to a microcontroller.

I used it in [Brain Pong](https://johnhoeksema.com/2026/07/14/brain-pong.html), where eye movements move a Pong paddle.

## How the parts connect

```
body signal  →  ADS1299 chip  →  firmware (ESP32)  →  USB  →  host software
```

This project simulates the first three parts. The host software runs unchanged.

## What it will simulate

- **Analog input:** body signals, electrode noise, and power-line hum.
- **The chip:** start-up, shut-down, normal streaming, and fault conditions.
- **Firmware:** the microcontroller code that sets up the chip and streams its data.

## Status

A 3D model of the chip, built from its datasheet, that you can rotate in the browser.
Pin view shows what each of the 64 pins does, in the datasheet's words.

A Python model of the chip and the Brain Pong firmware runs bring-up, streaming, and shutdown.
It checks each step against the datasheet's rules.

The website plays these three sequences at three speeds: real time, 1 ms per second, and 1 µs per second.
Scopes show each signal into and out of the chip, with a curve to each pin it uses.

## Layout

- `frontend/`: the 3D view and the sequence player (Three.js).
- `backend/`: the chip and firmware model (Python).
- `reference/`: the chip's datasheet and the board schematics.

## Author

[John Hoeksema](https://johnhoeksema.com)
