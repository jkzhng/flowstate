// Color encodings for the network view.
//   Line loading is a *state* (normal / high / near limit / at limit) -> status palette, always with labels.
//   Bus LMP and all deltas are *polarity* around a center -> blue<->red diverging with a gray midpoint.
// Values come from the reference data-viz palette (light and dark steps chosen separately).

export interface Theme {
  dark: boolean;
  surface: string;
  ink: string;
  inkSecondary: string;
  muted: string;
  lineNeutral: string;
  divNeg: string; // diverging blue pole
  divMid: string; // neutral midpoint
  divPos: string; // diverging red pole
  warning: string;
  serious: string;
  critical: string;
  ring: string;
  selection: string;
}

export const LIGHT: Theme = {
  dark: false,
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  muted: "#898781",
  lineNeutral: "#a9a79f",
  divNeg: "#2a78d6",
  divMid: "#f0efec",
  divPos: "#e34948",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  ring: "#52514e",
  selection: "#0b0b0b",
};

export const DARK: Theme = {
  dark: true,
  surface: "#1a1a19",
  ink: "#f0efec",
  inkSecondary: "#c3c2b7",
  muted: "#898781",
  lineNeutral: "#5f5e59",
  divNeg: "#3987e5",
  divMid: "#383835",
  divPos: "#e66767",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  ring: "#c3c2b7",
  selection: "#f0efec",
};

// ---------------------------------------------------------------- loading bands

export interface Band {
  key: "normal" | "high" | "near" | "limit";
  label: string;
  min: number;
}

export const LOADING_BANDS: Band[] = [
  { key: "limit", label: "At limit (≥ 99.9%)", min: 99.9 },
  { key: "near", label: "Near limit (90–99.9%)", min: 90 },
  { key: "high", label: "High (70–90%)", min: 70 },
  { key: "normal", label: "Normal (< 70%) or unlimited", min: -Infinity },
];

export function loadingBand(loading: number | null): Band {
  if (loading == null) return LOADING_BANDS[3];
  return LOADING_BANDS.find((b) => loading >= b.min)!;
}

export function bandColor(band: Band, t: Theme): string {
  return { limit: t.critical, near: t.serious, high: t.warning, normal: t.lineNeutral }[band.key];
}

// ---------------------------------------------------------------- diverging scale (OKLab interpolation)

type Lab = [number, number, number];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

function hexToOklab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([L, A, B]: Lab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(fromLinear);
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function mix(a: string, b: string, t: number): string {
  const la = hexToOklab(a);
  const lb = hexToOklab(b);
  return oklabToHex([0, 1, 2].map((i) => la[i] + (lb[i] - la[i]) * t) as Lab);
}

/** t in [-1, 1]: -1 = blue pole, 0 = gray midpoint, +1 = red pole. */
export function diverging(t: number, theme: Theme): string {
  const c = Math.max(-1, Math.min(1, t));
  return c < 0 ? mix(theme.divMid, theme.divNeg, -c) : mix(theme.divMid, theme.divPos, c);
}

/** Symmetric scale extent: the largest |value|, with a floor so tiny noise stays gray. */
export function symmetricExtent(values: (number | null | undefined)[], floor: number): number {
  let m = 0;
  for (const v of values) if (v != null && Number.isFinite(v)) m = Math.max(m, Math.abs(v));
  return Math.max(m, floor);
}

export function median(values: (number | null | undefined)[]): number {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
