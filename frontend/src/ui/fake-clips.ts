import type { Clip } from "../puzzle/types";

// Placeholder datasheet clips, until the real ones (src/puzzle/clips.ts) arrive.

export const PDF_URL = "https://www.ti.com/lit/ds/symlink/ads1299.pdf";

function placeholder(title: string, caption: string, rows: number): string {
  const lines = Array.from({ length: rows }, (_, i) => {
    const y = 210 + i * 64;
    return `<rect x="80" y="${y}" width="1240" height="64" fill="${i % 2 ? "#f6f7f9" : "#fff"}" stroke="#d7dbe0"/>
      <rect x="110" y="${y + 24}" width="${180 + ((i * 97) % 260)}" height="16" rx="4" fill="#cfd4da"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
    <rect width="1400" height="900" fill="#fff"/>
    <text x="80" y="110" font-family="Arial, sans-serif" font-size="44" font-weight="700" fill="#16181c">${title}</text>
    <text x="80" y="160" font-family="Arial, sans-serif" font-size="28" fill="#5d636d">${caption} (placeholder)</text>
    ${lines}
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const clip = (id: string, title: string, group: Clip["group"], page: number, caption: string, rows: number): Clip => ({
  id,
  title,
  group,
  file: placeholder(title, caption, rows),
  width: 1400,
  height: 900,
  page,
  caption,
});

export const CLIPS: Clip[] = [
  clip("register-map", "Register map", "map", 46, "Table 11. Register Assignments", 10),
  clip("config1", "CONFIG1", "CONFIG1", 46, "Figure 37. CONFIG1", 5),
  clip("chnset", "CHnSET", "CHnSET", 50, "Figure 41. CHnSET", 6),
  clip("bias-sens", "BIAS_SENSP", "BIAS_SENS", 51, "Figure 42. BIAS_SENSP", 4),
  clip("config3", "CONFIG3", "CONFIG3", 48, "Figure 39. CONFIG3", 8),
];
