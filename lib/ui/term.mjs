import process from "node:process";

// Two-tone discipline: cool indigo for chrome, warm amber only for what has focus.
export const PALETTE = Object.freeze({
  edge: { rgb: [75, 79, 158], c16: 34 },
  core: { rgb: [165, 171, 255], c16: 94 },
  focus: { rgb: [255, 180, 84], c16: 93 },
  ok: { rgb: [110, 231, 168], c16: 92 },
  bad: { rgb: [255, 107, 107], c16: 91 },
  mute: { rgb: [122, 127, 148], c16: 90 },
  text: { rgb: [236, 238, 248], c16: 97 },
  soft: { rgb: [128, 134, 214], c16: 34 },
});

// Background tints: the selected row, and key caps in hints.
export const SURFACE = Object.freeze({
  selected: [47, 51, 74],
  keycap: [58, 62, 88],
});

export function caps(env = process.env, out = process.stdout) {
  const forced = { 1: 16, 2: 256, 3: 24 }[env.FORCE_COLOR];
  const tty = Boolean(out.isTTY);
  let color = 0;
  if (env.NO_COLOR) {
    color = 0;
  } else if (forced) {
    color = forced;
  } else if (tty && env.TERM !== "dumb") {
    if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) color = 24;
    else if (env.TERM_PROGRAM === "Apple_Terminal" || /256/.test(env.TERM ?? "")) color = 256;
    else color = 16;
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return {
    tty,
    color,
    unicode: env.TERM !== "dumb" && (locale === "" || /utf-?8/i.test(locale)),
    // One column short of the terminal, so a full-width line never wraps.
    width: Math.min(100, Math.max(20, (out.columns || 80) - 1)),
    motion: tty && color > 0 && !env.CI && !env.CN_NO_MOTION,
  };
}

function to256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const level = (value) => Math.round((value / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function sgr(rgb, c16, c) {
  if (c.color === 24) return `38;2;${rgb.join(";")}`;
  if (c.color === 256) return `38;5;${to256(rgb)}`;
  return String(c16);
}

// Styles close with their own reset codes (not a full reset), so a row's
// background survives the colored text inside it.
function styled(code, text, isBold) {
  return `\x1b[${isBold ? "1;" : ""}${code}m${text}\x1b[${isBold ? "22;" : ""}39m`;
}

export function paintRgb(rgb, text, { bold = false } = {}, c = caps()) {
  if (!c.color) return text;
  const bright = (rgb[0] + rgb[1] + rgb[2]) / 3 > 140;
  return styled(sgr(rgb, bright ? 94 : 34, c), text, bold);
}

export function paint(role, text, options = {}, c = caps()) {
  if (!c.color) return text;
  const { rgb, c16 } = PALETTE[role];
  return styled(sgr(rgb, c16, c), text, options.bold);
}

export function bold(text, c = caps()) {
  return c.color ? `\x1b[1m${text}\x1b[22m` : text;
}

// A background tint. Skipped on 16-color terminals, where it would be garish.
export function surface(rgb, text, c = caps()) {
  if (c.color === 24) return `\x1b[48;2;${rgb.join(";")}m${text}\x1b[49m`;
  if (c.color === 256) return `\x1b[48;5;${to256(rgb)}m${text}\x1b[49m`;
  return text;
}

export function mix(a, b, t) {
  return a.map((value, i) => Math.round(value + (b[i] - value) * t));
}

// eslint-disable-next-line no-control-regex
export const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
export const visibleWidth = (text) => [...strip(text)].length;

export function fit(text, max, ellipsis = "…") {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("") + ellipsis;
}

export const pad = (text, width) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

// Cut a line to `max` visible columns, keeping escape codes so colors still close.
export function clip(text, max) {
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const part of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const char of part) {
      if (used >= max) break;
      out += char;
      used += 1;
    }
  }
  return text.includes("\x1b[") ? `${out}\x1b[0m` : out;
}
