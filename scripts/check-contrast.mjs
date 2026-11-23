// Verifies the design tokens against WCAG 2.2 AA (read-only; no network, no files written).
//   node scripts/check-contrast.mjs        (npm run check:contrast)
// 1) every documented token pair in src/app/tokens.css meets its required ratio;
// 2) no literal `color: #hex` in the stylesheets is under 4.5:1 on the light surfaces, except text that sits on navy
//    surfaces or decorative icon colours (allow-listed by selector below).
import { readFileSync } from "node:fs";

const root = new URL("../src/app/", import.meta.url);
const read = (f) => readFileSync(new URL(f, root), "utf8").replace(/\r/g, "");
const tokens = {};
const tokenSource = read("tokens.css");
for (const m of tokenSource.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)) tokens[m[1]] = m[2];
// aliases such as `--nav-active-bg: var(--green)`
for (const m of tokenSource.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)) if (tokens[m[2]]) tokens[m[1]] = tokens[m[2]];

const channel = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token, minimum ratio, what it is]
const PAIRS = [
  ["ink", "surface", 4.5, "body text on white"],
  ["ink", "bg", 4.5, "body text on page background"],
  ["text-muted", "surface", 4.5, "secondary text on white"],
  ["text-muted", "bg", 4.5, "secondary text on page background"],
  ["link", "surface", 4.5, "links"],
  ["text-on-green", "green", 4.5, "primary button text"],
  ["text-on-green", "green-dark", 4.5, "primary button hover text"],
  ["green", "mint", 4.5, "green text on mint"],
  ["success", "success-bg", 4.5, "success status text"],
  ["warning", "warning-bg", 4.5, "warning status text"],
  ["error", "error-bg", 4.5, "error status text"],
  ["info", "info-bg", 4.5, "info status text"],
  ["success", "surface", 4.5, "success text on white"],
  ["warning", "surface", 4.5, "warning text on white"],
  ["error", "surface", 4.5, "error text on white"],
  ["info", "surface", 4.5, "info text on white"],
  ["nav-text", "navy", 4.5, "sidebar text"],
  ["nav-text-muted", "navy", 4.5, "sidebar secondary text"],
  ["nav-text-muted", "navy-deep", 4.5, "sidebar secondary text (deep)"],
  ["nav-active-text", "nav-active-bg", 4.5, "sidebar active item"],
  ["nav-text", "navy-soft", 4.5, "sidebar hover"],
  ["focus", "surface", 3, "focus ring on white (non-text 3:1)"],
  ["focus", "mint", 3, "focus ring on mint"],
  ["focus-on-dark", "navy", 3, "focus ring on navy"],
  ["focus-on-dark", "navy-deep", 3, "focus ring on deep navy"],
  ["border-strong", "surface", 3, "form control border on white (non-text 3:1)"],
  ["border-strong", "bg", 3, "form control border on page background"],
  ["green-graphic", "surface", 3, "green icons (non-text 3:1)"],
];
let failures = 0;
for (const [fg, bg, min, what] of PAIRS) {
  if (!tokens[fg] || !tokens[bg]) {
    console.log(`MISSING token for pair ${fg}/${bg}`);
    failures++;
    continue;
  }
  const r = ratio(tokens[fg], tokens[bg]);
  const ok = r >= min;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1 (min ${min})  ${what}  [${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}]`);
}

// Literal text colours in the stylesheets.
const DARK = /sidebar|nav button|\.account\b|academy-label|academy-monogram|pilot-note|login-story|\.wordmark|nav-label|overview-shell|\.topbar|\.mobile-menu|\.skip-link|\.ax-sidebar|\.ax-drawer/;
const ICON = /wb-metric-icon|wb-attention > span|ov-bubble|wb-roster-item > svg|ov-metric > svg| svg\b/;
const surfaces = [tokens.surface, tokens.bg];
let literal = 0;
for (const file of ["globals.css", "operations.css", "redesign.css", "account/account.css", "shell.css"]) {
  let css;
  try {
    css = read(file);
  } catch {
    continue;
  }
  let selector = "";
  css.split("\n").forEach((line, i) => {
    if (line.includes("{")) selector = line.replace("{", "").trim();
    const m = line.match(/^\s*color:\s*(#[0-9a-fA-F]{3,6})\s*;/);
    if (!m || DARK.test(selector) || ICON.test(selector)) return;
    const worst = Math.min(...surfaces.map((s) => ratio(m[1], s)));
    // Near-white text is white-on-colour (buttons, badges) and is covered by the pair table above.
    if (luminance(m[1]) > 0.62) return;
    if (worst < 4.5) {
      literal++;
      console.log(`FAIL  literal ${m[1]} ${worst.toFixed(2)}:1  ${file}:${i + 1}  ${selector.slice(0, 60)}`);
    }
  });
}
console.log(`\ntoken pairs: ${PAIRS.length - failures}/${PAIRS.length} pass; literal text colours under 4.5:1 on light surfaces: ${literal}`);
process.exit(failures || literal ? 1 : 0);
