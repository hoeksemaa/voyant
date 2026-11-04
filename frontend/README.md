# Frontend

The ADS1299 register puzzle in the browser. Edit the firmware registers until the chip's output matches the target.

The 3D chip uses [Three.js](https://threejs.org). Pins (button or `P` key) labels every pin. Phones get a one-column page with no 3D chip.

## Run it

```
npm ci
npm run dev
npm test
```

## Files

- `src/puzzle/`: the setups, the register map, the body signals, the chip model, the match, and the datasheet clip list.
- `src/ui/`: the board, the phone cards, the firmware editor, the datasheet viewer, and the saved state.
- `src/main.ts`: connects the parts.
- `src/chip.ts`, `src/pins.ts`, `src/pin-view.ts`: the 3D chip and its 64 pins, from the datasheet.
- `public/datasheet/`: clips from the TI datasheet (SBAS499C).
