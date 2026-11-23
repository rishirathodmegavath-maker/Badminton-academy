// The written design standard (Wave 5, UX-D4 option A) as tests: one breakpoint scale, a type scale, and no new hard-coded colours.
// These tests read the stylesheets as text. They change nothing and need no server or database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BREAKPOINTS, DRAWER_QUERY, PHONE_QUERY } from "../src/shell/breakpoints";

const root = process.cwd();
const cssFiles = (() => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".css")) found.push(full);
    }
  };
  walk(join(root, "src"));
  return found.sort();
})();
const rel = (file: string) => file.slice(root.length + 1).replaceAll("\\", "/");
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

describe("breakpoint scale", () => {
  const max = Object.values(BREAKPOINTS) as number[];
  const min = max.map((v) => v + 1);
  it("every stylesheet uses only the scale: max-width 479, 767, 1023, 1279, 1535 and min-width 480, 768, 1024, 1280, 1536", () => {
    const off: string[] = [];
    let used = 0;
    for (const file of cssFiles) {
      const text = withoutComments(read(file));
      for (const media of text.matchAll(/@media([^{]*)\{/g)) {
        for (const w of media[1].matchAll(/\((max|min)-width:\s*([0-9.]+)px\)/g)) {
          used++;
          const value = Number(w[2]);
          if (!(w[1] === "max" ? max : min).includes(value)) off.push(`${rel(file)}: ${w[0]}`);
        }
        // a width written another way (em, rem, range syntax) would bypass the scale
        if (/width\s*(<|>)|\bwidth:\s*[0-9.]+(em|rem)\b/.test(media[1])) off.push(`${rel(file)}: ${media[1].trim()}`);
      }
    }
    assert.ok(used > 40, "the stylesheets should contain width queries to check");
    assert.deepEqual(off, [], "width queries off the scale");
  });
  it("the scale is ascending and its 'min' partner is exactly one above, so two queries never overlap or leave a gap", () => {
    assert.deepEqual(max, [...max].sort((a, b) => a - b));
    assert.deepEqual(min, max.map((v) => v + 1));
  });
  it("the script queries are the same widths the stylesheets use", () => {
    assert.equal(PHONE_QUERY, `(max-width: ${BREAKPOINTS.phone}px)`);
    assert.equal(DRAWER_QUERY, `(max-width: ${BREAKPOINTS.laptop}px)`);
    const shell = withoutComments(read(join(root, "src/app/shell.css")));
    // the drawer menu and the bottom bar are driven by these two widths in the stylesheet as well
    assert.match(shell, new RegExp(`@media \\(max-width: ${BREAKPOINTS.laptop}px\\) \\{[^@]*\\.ax-sidebar`));
    assert.match(shell, new RegExp(`@media \\(max-width: ${BREAKPOINTS.phone}px\\) \\{[^@]*\\.ax-bottom-bar`));
  });
  it("tokens.css documents the same table", () => {
    const tokens = read(join(root, "src/app/tokens.css"));
    for (const [name, value] of Object.entries(BREAKPOINTS)) {
      const label = name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
      assert.match(tokens, new RegExp(`${label}\\s+max-width ${value}\\s+min-width ${value + 1}`), `${label} missing from tokens.css`);
    }
  });
});

describe("type scale", () => {
  const tokens = read(join(root, "src/app/tokens.css"));
  const scale = new Map([...tokens.matchAll(/(--fs-[a-z0-9]+):\s*([0-9]+)px;/g)].map((m) => [m[1], Number(m[2])]));
  it("is ten steps from 11 to 32 px", () => {
    assert.deepEqual([...scale.values()], [11, 12, 13, 14, 16, 18, 20, 24, 28, 32]);
  });
  it("no stylesheet sets a font size in px or rem: every size is a --fs- token", () => {
    const raw: string[] = [];
    for (const file of cssFiles) {
      const text = withoutComments(read(file));
      text.split("\n").forEach((line, i) => {
        if (/^\s*--/.test(line)) return;
        if (/(^|[\s;{])font-size:\s*[0-9.]+(px|rem)\b/.test(line)) raw.push(`${rel(file)}:${i + 1} ${line.trim().slice(0, 70)}`);
      });
    }
    assert.deepEqual(raw, [], "use var(--fs-xs) and friends");
  });
  it("every --fs- token that is used exists", () => {
    const missing = new Set<string>();
    for (const file of cssFiles)
      for (const m of read(file).matchAll(/var\((--fs-[a-z0-9]+)\)/g)) if (!scale.has(m[1])) missing.add(`${rel(file)}: ${m[1]}`);
    assert.deepEqual([...missing], []);
  });
});

describe("colours", () => {
  // A ratchet: the number of hard-coded hex colours outside custom-property declarations may fall, never rise. When you
  // replace colours with tokens, lower the number in tests/fixtures/design-colour-baseline.json in the same change.
  const baseline = JSON.parse(readFileSync(join(root, "tests/fixtures/design-colour-baseline.json"), "utf8")) as Record<string, number>;
  const count = (file: string) => {
    let n = 0;
    for (const line of withoutComments(read(file)).split("\n")) {
      if (/^\s*--[a-zA-Z0-9-]+\s*:/.test(line) || line.includes("url(")) continue;
      n += (line.match(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g) ?? []).length;
    }
    return n;
  };
  it("no stylesheet gained a hard-coded colour", () => {
    const grew: string[] = [];
    for (const file of cssFiles) {
      const have = count(file),
        allowed = baseline[rel(file)] ?? 0;
      if (have > allowed) grew.push(`${rel(file)}: ${have} hard-coded colours, baseline ${allowed}. Use a token from src/app/tokens.css.`);
    }
    assert.deepEqual(grew, []);
  });
  it("the baseline names only files that exist and is not stale-high by more than a few", () => {
    const names = new Set(cssFiles.map(rel));
    for (const name of Object.keys(baseline)) assert.ok(names.has(name), `${name} is in the baseline but is not a stylesheet`);
    for (const file of cssFiles) {
      const have = count(file);
      assert.ok((baseline[rel(file)] ?? 0) - have <= 5, `${rel(file)}: baseline ${baseline[rel(file)]} but ${have} found; lower the baseline`);
    }
  });
  it("tokens.css still defines the brand and the text tokens the contrast check depends on", () => {
    const tokens = read(join(root, "src/app/tokens.css"));
    for (const name of ["--green", "--navy", "--ink", "--text-muted", "--line", "--surface", "--bg", "--white", "--line-soft"])
      assert.match(tokens, new RegExp(`${name}:\\s*#`), `${name} must be a plain colour in tokens.css`);
  });
});

describe("touch targets", () => {
  it("tokens.css keeps a 44 px minimum for controls on coarse pointers", () => {
    const tokens = read(join(root, "src/app/tokens.css"));
    assert.match(tokens, /--touch:\s*44px/);
    assert.match(tokens, /@media \(pointer: coarse\)/);
  });
});
