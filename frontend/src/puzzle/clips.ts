import type { Clip } from "./types";

// Image clips from the TI ADS1299 datasheet (SBAS499C, January 2017).
// Each PNG in public/datasheet/ is a crop of the PDF at about 220 DPI, with 24 px of white on each side.
// The printed page numbers in this datasheet are the same as the PDF page indexes.
// "page" is the page where the clip starts. Use it with PDF_URL + "#page=N".

export const PDF_URL = "https://www.ti.com/lit/ds/symlink/ads1299.pdf";

export const CLIPS: Clip[] = [
  // All 24 registers, their default values, and the bit names.
  {
    id: "register-map",
    title: "Register map",
    group: "map",
    file: "/datasheet/register-map.png",
    width: 1595,
    height: 1276,
    page: 44,
    caption: "Table 11. Register Assignments",
  },
  // Daisy-chain mode, clock output, and the data rate DR[2:0].
  {
    id: "config1",
    title: "CONFIG1",
    group: "CONFIG1",
    file: "/datasheet/config1.png",
    width: 1588,
    height: 1227,
    page: 46,
    caption:
      "Figure 51. CONFIG1: Configuration Register 1; Table 13. Configuration Register 1 Field Descriptions",
  },
  // Power-down, PGA gain, SRB2, and the input mux of one channel.
  {
    id: "chnset",
    title: "CHnSET",
    group: "CHnSET",
    file: "/datasheet/chnset.png",
    width: 1588,
    height: 1521,
    page: 50,
    caption:
      "Figure 55. CHnSET: Individual Channel Settings Register; Table 17. Individual Channel Settings (n = 1 to 8) Field Descriptions",
  },
  // The INxP inputs that go into the bias drive.
  {
    id: "bias-sensp",
    title: "BIAS_SENSP",
    group: "BIAS_SENS",
    file: "/datasheet/bias-sensp.png",
    width: 1588,
    height: 1560,
    page: 51,
    caption:
      "Figure 56. BIAS_SENSP: BIAS Positive Signal Derivation Register; Table 18. BIAS Positive Signal Derivation Field Descriptions",
  },
  // The INxN inputs that go into the bias drive.
  {
    id: "bias-sensn",
    title: "BIAS_SENSN",
    group: "BIAS_SENS",
    file: "/datasheet/bias-sensn.png",
    width: 1588,
    height: 1560,
    page: 52,
    caption:
      "Figure 57. BIAS_SENSN: BIAS Negative Signal Derivation Register; Table 19. BIAS Negative Signal Derivation Field Descriptions",
  },
  // Reference buffer, bias measurement, bias reference, and bias buffer power.
  {
    id: "config3",
    title: "CONFIG3",
    group: "CONFIG3",
    file: "/datasheet/config3.png",
    width: 1595,
    height: 1361,
    page: 48,
    caption:
      "Figure 53. CONFIG3: Configuration Register 3; Table 15. Configuration Register 3 Field Descriptions",
  },
];
