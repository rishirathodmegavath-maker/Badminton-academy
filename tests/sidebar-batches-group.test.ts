// The staff menu has a collapsible "Batches" group (Branches & batches, Create branch, Create batch) after Calendar.
// A static check of the wiring; the behaviour was checked in a browser (see the Wave 5 report).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("sidebar: Batches group", () => {
  const studio = read("src/modules/training/ui/studio.tsx");
  const shell = read("src/shell/app-shell.tsx");
  const settings = read("src/modules/academy/ui/views/settings-view.tsx");
  it("is offered only to those who may manage branches and batches, right after Calendar", () => {
    assert.match(studio, /s === "calendar" && canOpen\(who\.role, "settings"\) && context && can\(context\.actor, "academy\.structure"\)/);
    for (const label of ["Branches & batches", "Create branch", "Create batch"]) assert.ok(studio.includes(`label: "${label}"`), label);
  });
  it("is a collapsible group that starts closed and widens the icon-only sidebar when pressed", () => {
    assert.match(shell, /children\?: ShellItem\[\]/);
    assert.match(shell, /aria-expanded=\{groupOpen\}/);
    assert.match(shell, /useState<Record<string, boolean>>\(\{\}\)/);
    assert.match(shell, /if \(compact\) \{\s*toggleCollapsed\(\);/);
  });
  it("opens Settings on Sessions and, for the Create entries, the existing forms (the server still decides who may save)", () => {
    assert.match(settings, /group:Sessions\\|\(branch\|batch\)/);
    assert.match(settings, /if \(!d\.permissions\.ops\) return;/);
  });
});
