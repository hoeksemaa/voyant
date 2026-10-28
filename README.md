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

Just started. Nothing runs yet.

## Author

[John Hoeksema](https://johnhoeksema.com)
