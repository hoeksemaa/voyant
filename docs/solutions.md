# Solutions (spoilers)

Every level starts from the Cerelog stock V2 firmware (STOCK). The check compares the output of each channel with an electrode on INnP. A channel passes at a score of 0.75 or more. The level passes when every checked channel passes.

STOCK: CONFIG1 `B6` (250 SPS), CONFIG3 `EC`, CH1–8SET `60` (×24, normal input), BIAS_SENSP `01`, BIAS_SENSN `01`.

## Quick answers

| Level | Fix (Hint 3) | Fewest bit flips | Other ways to solve it |
|---|---|---|---|
| EMG | CONFIG1 `B6` → `B3` | the same: 2 | `93`, `D3`, `F3` (DAISY_EN and CLK_EN do nothing) |
| EOG | CH1SET, CH2SET `60` → `50` | `60` → `40` or `20`: 1 per channel | any gain ×1–×12 on both channels |
| EEG | BIAS_SENSP `01` → `FF` | `01` → `1F`: 4 (thin margin) | BIAS_SENSN `01` → `FF`; any masks with 6+ bits in total |

CONFIG3 is the red herring. All 31 edits fail in all 3 levels, from STOCK, from the fix, and from the target. Each gives 0.000 on every checked channel.

## Level 1: EMG

- **Wiring:** muscle pad → IN1P, elbow → SRB1 (reference), wrist → BIASOUT. Only CH1 is checked.
- **Symptom:** the muscle bursts are small and smeared. CH1 scores 0.000.
- **Fix:** CONFIG1 = `B3` (DR `011`, 2,000 SPS). CH1 scores 1.000.
- **Why:** surface EMG has most of its power at 50–150 Hz. At 250 SPS, the sinc3 filter is −3 dB at about 65 Hz. It cuts most of the burst and folds the rest down (aliasing). At 2,000 SPS, the −3 dB point is about 524 Hz.

What passes, with `B3`:

| Register | Passing values | Notes |
|---|---|---|
| CONFIG1 | `93` `B3` `D3` `F3` | DR `011` only. Every other rate scores 0.000. DR `111` is invalid. |
| CH1SET | `00` `08` `10` … `60` `68` (14) | Any gain ×1–×24, SRB2 on or off. ×1 scores 0.988. |
| CH2–8SET | all 256 | No electrode, not checked. Greyed out. |
| BIAS_SENSP | `00` `01` | A bit on IN2P–IN8P puts a floating input in the bias loop. Best fail: `45` at 0.371. |
| BIAS_SENSN | all 256 | Each bit senses the SRB1 electrode. |

Near misses:
- `B4` (1 kSPS) and `B2` (4 kSPS) score 0.000. These rates keep the EMG band, but the check needs the target's rate.
- CH2–8 off (`81`) without `B3`: 0.000. It clears the warnings but not CH1.
- At `B6`, no CH1SET value passes (0 of 256).
- Empty bias masks (SENSP `00` + SENSN `00`) with `B3`: passes just barely, at 0.757.

## Level 2: EOG

- **Wiring:** left eye → IN1P, right eye → IN2P, left earlobe → SRB1 (reference), right earlobe → BIASOUT. CH1 and CH2 are checked.
- **Symptom:** both channels sit flat at the edge of their range. Both score 0.000.
- **Fix:** CH1SET = CH2SET = `50` (gain ×12). Both score 1.000.
- **Why:** the input range is ±4.5 V / gain: ±187.5 mV at ×24. The eye electrodes sit about +205 mV and −200 mV from the reference (electrode DC offset), so both clip. At ×12 the range is ±375 mV.

What passes, with the other channel at `50`:

| Register | Passing values | Notes |
|---|---|---|
| CH1SET, CH2SET | `00` `08` `10` … `50` `58` (12) | Gain ×1–×12, SRB2 on or off. All 36 gain pairs pass. Both channels must change: one alone gives mean 0.500. |
| CH3–8SET | all 256 | No electrode, not checked. Greyed out. |
| BIAS_SENSP | `00`–`03` | Bits 2–7 put floating CH3–8 inputs in the bias loop: 0.000. If CH3–8 are off (`81`), `FF` passes too. |
| BIAS_SENSN | all 256 | |
| CONFIG1 | `96` `B6` `D6` `F6` | DR must stay `110` (250 SPS). |

Near misses:
- ×24 (`60`) clips. Gain `111` (`70`) is invalid.
- SRB2 on both channels (`58`/`58`): 0.000. The two INnP pins short together, so both channels read the average of the two eyes.
- Empty bias masks (SENSP `00` + SENSN `00`): fails at 0.760/0.699.
- CH3–8 off (`81`) without a gain fix: 0.000.

## Level 3: EEG

- **Wiring:** 8 scalp electrodes → IN1P–IN8P, left earlobe → SRB1 (reference), right earlobe → BIASOUT. All 8 channels are checked.
- **Symptom:** 60 Hz hum on every channel. STOCK scores: CH1 0.435, CH2 0.070, CH3–6 0.000, CH7 0.157, CH8 0.000.
- **Fix:** BIAS_SENSP = `FF`. All 8 score 1.000.
- **Why:** the bias drive senses the inputs in the BIAS_SENSP/N masks. It drives the body to cancel their common signal, mostly the room's 60 Hz. Loop gain G = 7 × N, where N is the number of mask bits on inputs with an electrode. STOCK: N = 2 (IN1P, plus SRB1 through IN1N), G = 14. `FF`: N = 9, G = 63. Residual hum = 50 mV / (1 + G): 3.3 mV → 0.78 mV, about 4.3× lower.

**Rule:** the level passes when popcount(BIAS_SENSP) + popcount(BIAS_SENSN) ≥ 6. This holds for all 65,536 mask pairs (58,651 pass). The score depends only on the total:

| Bits in total | 1 | 2 (STOCK) | 3 | 4 | 5 | **6** | 7 | 8 | 9 (target) | 10 | 12 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Mean | 0.000 | 0.083 | 0.328 | 0.575 | 0.726 | **0.828** | 0.901 | 0.957 | 1.000 | 0.965 | 0.913 | 0.847 |
| Worst channel | 0.000 | 0.000 | 0.091 | 0.425 | 0.630 | **0.767** | 0.867 | 0.942 | 1.000 | 0.953 | 0.882 | 0.794 |

Other ways to solve it:
- BIAS_SENSN `01` → `FF`, with BIAS_SENSP at `01`: N = 9, all 8 at 1.000. With SRB1 on, all 8 INnN pins are the same electrode. The model counts that electrode once for each SENSN bit. A warning says it is sensed 8 times.
- More than 9 bits (for example both masks `FF`) still passes, but the score falls. The hum is lower, but the output differs more from the target. The check measures "same as the target", not "less hum".
- With the fix, any gain ×1–×24 on all 8 channels passes (×1: 0.948/0.928). CONFIG1 DR must stay `110`.

Near misses:
- BIAS_SENSP `03` or `0F` (3 or 5 bits in total): fail.
- No gain change fixes STOCK. Each scores about 0.08.
- `FF` with CH8 off (`E0`): CH8 scores 0.000, so the level fails.
- `FF` with SRB2 on all channels (`68`): all 8 INnP pins short together, 0.000.

## Notes on the check

- A different data rate always scores 0.000, because the check compares samples on the target's grid. Thus the live output strip gives no partial credit while you search DR in EMG.
- The greyed-out CHnSET rows are safe to grey out: every value passes once the level is fixed. But the BIAS_SENSP bits of unused channels are not safe in EMG and EOG (floating inputs).
- SRB2 on one checked channel plus one floating channel does nothing. The model joins only pins with an electrode.

## How I checked this (2026-11-05)

- About 140,000 runs of `simulate()` + `match()`: every value of each editable register, the full EOG gain grid, the full EEG mask grid, and all 31 CONFIG3 values from 3 starting points.
- A second, independent run of 42 claims matched to 3 decimals. It found one error (`B6` → `B3` is 2 flips, not 3), fixed here.
- `frontend/src/puzzle/puzzle.test.ts` keeps the main facts as tests.
