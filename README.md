# ADS1299 register puzzle

A browser puzzle about the [ADS1299](https://www.ti.com/product/ADS1299), the TI chip that measures tiny voltages from the body.

Live: [voyant-sim.vercel.app](https://voyant-sim.vercel.app)

## How to play

1. Pick a level: EMG (easy), EOG (medium), or EEG (hard).
2. Compare the chip's output with the target output.
3. Tap Firmware and edit the registers until the two match.
4. A green check on the home screen marks a solved level.

Each level starts from the real Cerelog stock V2 firmware. Pins, Datasheet, and Animation open as full-screen sheets.

## The 3 levels

| Level | Electrodes | What the body does |
|---|---|---|
| 1 EMG | 3 pads on the forearm | Rest, flex, rest, hard flex, rest |
| 2 EOG | 2 beside the eyes | Looks center, left, center, right, center |
| 3 EEG | 8 on the scalp | Eyes open, eyes closed (alpha waves), eyes open |

You can edit CONFIG1, CH1SET–CH8SET, BIAS_SENSP, BIAS_SENSN, and CONFIG3. One of them is a red herring.

## Where the code is

- `frontend/src/puzzle/`: the body signals, the chip model, the match, and the register map.
- `frontend/src/ui/`: the home screen, the level screen, the sheets, and the firmware editor.
- `frontend/public/datasheet/`: clips from the TI datasheet.
- `backend/`: an older Python model of the chip and the Brain Pong firmware.
- `reference/`: the datasheet and the board schematics.
- `docs/solutions.md`: the answers for each level, with every passing value (spoilers).

## Run it

```
cd frontend
npm ci
npm run dev
npm test
```

## Author

[John Hoeksema](https://johnhoeksema.com)
