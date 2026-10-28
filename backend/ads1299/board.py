"""The board around the chip: supplies, electrodes, and the person wearing them.

None of these numbers are in the ADS1299 datasheet. They describe a Cerelog X8-style
board (5 V analog, 3.3 V digital, internal reference) and a Brain Pong EOG montage.
Each one is a stated assumption, so it can be changed in one place.
"""

AVDD = 5.0  # unipolar supply, datasheet 11.2
DVDD = 3.3
SUPPLY_TAU = 0.4e-3  # regulator ramp at power-on
SUPPLY_OFF_TAU = 3e-3  # supply decay at power-off, with the board's load
HOST_BOOT = 0.30  # ESP32 boot time before setup() runs

# VCAP1 final value: about AVSS + 1.2 V (TI E2E forum answers; not in the datasheet).
VCAP1_FINAL = 1.2
# Discharge paths when powered down: VCAP1 through R1 + R2, VREFP through R2 + R3 (Figure 25).
VCAP1_OFF_TAU = (9.8e3 + 13.4e3) * 100e-6
VREFP_OFF_TAU = (13.4e3 + 36.85e3) * 10e-6
CLAMP_TAU = 4e-3  # capacitors on VCAP1 and VREFP discharging into a supply that is off

# Body potential. With the bias drive off, the body floats and picks up mains hum.
# The bias drive holds it at mid-supply and cancels most of the hum.
MAINS_HZ = 60.0
BODY_FLOAT_V = 0.9
BODY_FLOAT_HUM = 0.2  # V amplitude, common mode
BODY_BIASED_HUM = 0.4e-3
BODY_TAU = 5e-3  # how fast the bias loop pulls the body in
HUM_IMBALANCE = 1e-3  # fraction of common-mode hum that appears between electrodes

# Electrodes (Brain Pong: CH1 and CH2 at the outer corners of the eyes, SRB1 reference).
ELECTRODE_OFFSET = {"IN1P": 14.0e-3, "IN2P": -9.0e-3, "SRB1": 3.0e-3}  # half-cell potentials
EOG_UV_PER_DEG = 8.0  # each canthus electrode against the reference
ELECTRODE_NOISE_UV = 0.8

# Host SPI (pong-firmware: SPI_FREQ = 4 MHz, SPI_MODE1)
SCLK_HZ = 4e6
BYTE_GAP = 0.6e-6  # ESP32 time between transfer() calls
CS_DELAY = 1.0e-6  # delayMicroseconds(1) before and after each transfer
GPIO_WRITE = 0.15e-6  # digitalWrite() time
DRDY_LATENCY = 8e-6  # DRDY falling edge to the start of the read
