# ADS1299 register puzzle

A browser puzzle about the [ADS1299](https://www.ti.com/product/ADS1299), the TI chip that measures tiny voltages from the body.

Live: [voyant-sim.vercel.app](https://voyant-sim.vercel.app)

## How to play

1. Pick a hardware setup.
2. Compare the chip's output with the target output.
3. Edit the firmware registers until the two match. Use the datasheet clips for help.
4. A green check marks a solved setup.

Each setup starts from the real Cerelog stock V2 firmware. On a phone, the same puzzle shows as one column.

## The 3 setups

| Setup | Electrodes | What the body does |
|---|---|---|
| EEG | 8 on the scalp | Eyes open, eyes closed (alpha waves), eyes open |
| EOG | 2 beside the eyes | Looks center, left, center, right, center |
| EMG | 3 pads on the forearm | Rest, flex, rest, hard flex, rest |

You can edit CONFIG1, CH1SET–CH8SET, BIAS_SENSP, BIAS_SENSN, and CONFIG3. One of them is a red herring.

## Where the code is

- `frontend/src/puzzle/`: the body signals, the chip model, the match, and the register map.
- `frontend/src/ui/`: the page, the firmware editor, and the datasheet viewer.
- `frontend/public/datasheet/`: clips from the TI datasheet.
- `backend/`: an older Python model of the chip and the Brain Pong firmware.
- `reference/`: the datasheet and the board schematics.

## Run it

```
cd frontend
npm ci
npm run dev
npm test
```

## Author

[John Hoeksema](https://johnhoeksema.com)
