/**
 * Academy identity for the shell, derived from data the academy already owns (its name and its saved accent
 * colour). No logo upload exists; the monogram is the academy's initials on its own accent colour.
 */
export function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "A";
  const letters =
    words.length === 1
      ? words[0].slice(0, 2)
      : words
          .filter((w) => !/^(the|of|and|academy)$/i.test(w))
          .slice(0, 2)
          .map((w) => w[0])
          .join("") || words[0].slice(0, 2);
  return letters.toUpperCase();
}

const channel = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export function luminance(hex: string) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * A safe monogram colour pair. An accent that is not a 6-digit hex, or that cannot carry readable text, falls
 * back to the brand green, so a poor stored colour never produces an unreadable header.
 */
export function monogramColours(accent: string | null | undefined) {
  const fallback = { background: "#087047", color: "#ffffff" };
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return fallback;
  const white = contrast(accent, "#ffffff");
  const ink = contrast(accent, "#10243a");
  if (white >= 4.5) return { background: accent, color: "#ffffff" };
  if (ink >= 4.5) return { background: accent, color: "#10243a" };
  return fallback;
}
