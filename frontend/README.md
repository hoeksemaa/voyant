# Frontend

A 3D model of the ADS1299 chip in the browser. You can drag to rotate it.
Pin view (button or `P` key) labels every pin; click a pin for its datasheet description.

Built with [Three.js](https://threejs.org). The chip's size and pin layout come from the package drawing in the [datasheet](../reference/ads1299-datasheet.pdf).

## Run it

```
npm install
npm run dev
```

## Files

- `src/package-dims.ts`: the chip's measurements, from the datasheet.
- `src/chip.ts`: builds the body and the 64 pins.
- `src/textures.ts`: draws the marking and surface texture in code, so the site loads no images.
- `src/pins.ts`: the 64 pins, from the datasheet's pin table.
- `src/pin-layout.ts`: where each pin sits on the package.
- `src/pin-view.ts`: the pin view (dots, labels, colors, click for details).
- `src/main.ts`: lights, camera, and drag-to-rotate.
