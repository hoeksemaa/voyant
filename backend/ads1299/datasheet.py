"""Numbers and tables from the ADS1299 datasheet (reference/ads1299-datasheet.pdf, SBAS499C).

Each value names the datasheet section it comes from. Values that are not in the
datasheet live in board.py, marked as assumptions.
"""

# Clock (7.5 Electrical Characteristics, CLOCK)
F_CLK = 2.048e6  # internal oscillator, Hz
T_CLK = 1 / F_CLK
OSC_STARTUP = 20e-6  # internal oscillator start-up time

# Power-up (11.1 Power-Up Sequencing, Table 30)
T_POR = 2**18 * T_CLK  # wait after power up until reset (128 ms)
T_RST = 2 * T_CLK  # minimum reset low duration
VCAP1_RESET_MIN = 1.1  # "Issue the reset ... after the VCAP1 voltage is greater than 1.1 V"
T_RESET_INIT = 18 * T_CLK  # 9.4.2: 18 tCLK after a reset to finish initialization

# Serial interface timing (7.6 Timing Requirements, 2.7 V <= DVDD <= 3.6 V)
T_CSSC = 6e-9  # CS low to first SCLK
T_SCLK_MIN = 50e-9  # SCLK period
T_CSH = 2 * T_CLK  # CS high pulse
T_SCCS = 4 * T_CLK  # final SCLK falling edge to CS high
T_SDECODE = 4 * T_CLK  # command decode time; also the gap between bytes of a multi-byte command

# Internal reference (7.5, INTERNAL REFERENCE; 9.3.1.3.4 Reference, Figure 25)
VREF = 4.5
REF_STARTUP = 150e-3  # typical start-up time
VCAP1_R1 = 9.8e3  # Figure 25 note: R1 = 9.8 kOhm
VCAP1_C = 100e-6  # pin table: "Connect a 100-uF capacitor to AVSS"
VREFP_C = 10e-6  # pin table: "Connect a minimum 10-uF capacitor to VREFN"

# Bias amplifier (7.5, PATIENT BIAS AMPLIFIER)
BIAS_SLEW = 0.07e6  # V/s (0.07 V/us)

# Noise (7.5, input-referred noise, 0.01 Hz to 70 Hz, 250 SPS, gain 24): 1 uVpp typical
NOISE_UVPP = 1.0

# Data rate: DR[2:0] in CONFIG1. fMOD = fCLK / 2, data rate = fMOD / (64 * 2**DR).
def conversion_period(dr: int) -> float:
    return 128 * 2**dr * T_CLK


# Table 7. Settling Time for Different Data Rates (tCLK cycles from START to first DRDY)
SETTLE_TCLK = {0: 521, 1: 1033, 2: 2057, 3: 4105, 4: 8201, 5: 16393, 6: 32777}

# Table 17, GAINn[2:0]
GAINS = {0: 1, 1: 2, 2: 4, 3: 6, 4: 8, 5: 12, 6: 24}

# Table 10. Command Definitions (first byte)
COMMANDS = {
    0x02: "WAKEUP",
    0x04: "STANDBY",
    0x06: "RESET",
    0x08: "START",
    0x0A: "STOP",
    0x10: "RDATAC",
    0x11: "SDATAC",
    0x12: "RDATA",
}
OPCODES = {name: code for code, name in COMMANDS.items()}

# Table 11. Register Assignments: address -> (name, default).
# ID reads 3Eh on an 8-channel ADS1299: bit 4 = 1, DEV_ID = 11, NU_CH = 10 (REV_ID = 0 here).
REGISTERS = {
    0x00: ("ID", 0x3E),
    0x01: ("CONFIG1", 0x96),
    0x02: ("CONFIG2", 0xC0),
    0x03: ("CONFIG3", 0x60),
    0x04: ("LOFF", 0x00),
    **{0x05 + n: (f"CH{n + 1}SET", 0x61) for n in range(8)},
    0x0D: ("BIAS_SENSP", 0x00),
    0x0E: ("BIAS_SENSN", 0x00),
    0x0F: ("LOFF_SENSP", 0x00),
    0x10: ("LOFF_SENSN", 0x00),
    0x11: ("LOFF_FLIP", 0x00),
    0x12: ("LOFF_STATP", 0x00),
    0x13: ("LOFF_STATN", 0x00),
    0x14: ("GPIO", 0x0F),
    0x15: ("MISC1", 0x00),
    0x16: ("MISC2", 0x00),
    0x17: ("CONFIG4", 0x00),
}
READ_ONLY = {0x00, 0x12, 0x13}
ADDRESS = {name: addr for addr, (name, _) in REGISTERS.items()}

# 9.4.4.2: 24 status bits + 24 bits x 8 channels = 216 bits per read
FRAME_BYTES = 27
