import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUARDIAN_ACCESS_SCOPES, GUARDIAN_ACCESS_EVENTS } from "../src/modules/academy/domain/guardian-access";
import {
  SCOPE_INFO,
  actorText,
  eventLabel,
  knownScopes,
  plan,
  sameScopes,
  scopeSummary,
  stateLabel,
  type GrantState,
} from "../src/modules/academy/ui/guardian-access-view";
import { REPO_ROOT } from "./helpers/paths";
/**
 * RC-5 adult guardian-access screen: the pure rules (no React, no server). The server is authoritative for every
 * decision; these tests pin only what the screen shows and offers, against the RC-4 contract
 * (RC4_ENDPOINT_CONTRACTS.md): seven sections, four states, NO time-based expiry, consent never a section.
 */
const SEVEN = ["SCHEDULE", "REPORTS", "NUTRITION", "HEALTH", "FEES", "MEDIA", "MESSAGES"];

test("the screen offers exactly the seven approved sections, in contract order, and never consent", () => {
  assert.deepEqual([...GUARDIAN_ACCESS_SCOPES], SEVEN);
  assert.deepEqual(Object.keys(SCOPE_INFO), SEVEN);
  for (const s of SEVEN) assert.ok(SCOPE_INFO[s as keyof typeof SCOPE_INFO].label && SCOPE_INFO[s as keyof typeof SCOPE_INFO].detail, s);
  for (const text of Object.values(SCOPE_INFO).flatMap((i) => [i.label, i.detail]))
    assert.ok(!/consent/i.test(text), `no section is worded as consent: ${text}`);
  // Anything that is not one of the seven is dropped before it can be shown or sent.
  assert.deepEqual(knownScopes(["CONSENT"]), []);
  assert.deepEqual(knownScopes(["FEES", "CONSENT", "fees", "MEDIA", "FEES", 7, null, "__proto__"]), ["FEES", "MEDIA"]);
  assert.deepEqual(knownScopes(["MESSAGES", "SCHEDULE"]), ["SCHEDULE", "MESSAGES"], "canonical order");
  for (const bad of [null, undefined, "FEES", { 0: "FEES" }, 5, true]) assert.deepEqual(knownScopes(bad), []);
  assert.equal(sameScopes(["MEDIA", "FEES"], ["FEES", "MEDIA"]), true);
  assert.equal(sameScopes(["FEES"], ["FEES", "MEDIA"]), false);
});

test("every one of the seven sections works on its own and all together", () => {
  const none = { state: "none" as GrantState, eligible: true, scopes: [] };
  for (const s of SEVEN) {
    assert.deepEqual(plan(none, [s]).save, { label: "Grant access", scopes: [s] }, s);
    const active = { state: "active" as GrantState, eligible: true, scopes: [s] };
    assert.equal(plan(active, [s]).save, null, `${s}: unchanged is not saved`);
  }
  assert.deepEqual(plan(none, SEVEN).save, { label: "Grant access", scopes: SEVEN });
  assert.deepEqual(plan({ state: "active", eligible: true, scopes: ["FEES"] }, SEVEN).save, { label: "Save changes", scopes: SEVEN });
  assert.deepEqual(plan({ state: "active", eligible: true, scopes: SEVEN }, ["MEDIA"]).save, { label: "Save changes", scopes: ["MEDIA"] });
});

test("buttons per state: none, active, revoked, void; ticking nothing never sends an accidental revoke", () => {
  const states: GrantState[] = ["none", "active", "revoked", "void"];
  for (const state of states) {
    const g = { state, eligible: true, scopes: state === "active" ? ["FEES"] : [] };
    const p = plan(g, []);
    assert.equal(p.save, null, `${state}: nothing ticked, nothing to save`);
    assert.equal(p.revoke, state === "active" || state === "void", `${state}: revoke offered only for an open grant`);
    assert.equal(p.note, null);
  }
  // none / revoked / void with something ticked: a new grant.
  for (const state of ["none", "revoked", "void"] as GrantState[])
    assert.deepEqual(plan({ state, eligible: true, scopes: [] }, ["FEES"]).save, { label: "Grant access", scopes: ["FEES"] }, state);
  // active with the same sections: nothing to save; with an unticked everything: only the explicit revoke button.
  assert.equal(plan({ state: "active", eligible: true, scopes: ["FEES"] }, ["FEES"]).save, null);
  assert.equal(plan({ state: "active", eligible: true, scopes: ["FEES"] }, []).save, null);
  assert.equal(plan({ state: "active", eligible: true, scopes: ["FEES"] }, []).revoke, true);
});

test("an inactive guardian link: no grant offered, an explanation shown, revoking still possible", () => {
  for (const state of ["none", "active", "revoked", "void"] as GrantState[]) {
    const p = plan({ state, eligible: false, scopes: [] }, ["FEES"]);
    assert.equal(p.save, null, state);
    assert.ok(p.note && /no longer active/.test(p.note), state);
    assert.equal(p.revoke, state === "active" || state === "void", state);
  }
});

test("there is no expiry anywhere in the screen: four states, no expiry wording, no time-based field", () => {
  assert.equal(stateLabel("active"), "Active");
  assert.equal(stateLabel("revoked"), "Revoked");
  assert.equal(stateLabel("none"), "No access");
  assert.equal(stateLabel("void"), "No access", "void is worded like none");
  for (const v of ["expired", "EXPIRED", "pending", "", null, undefined, 3]) assert.equal(stateLabel(v), "No access", String(v));
  for (const name of ["guardian-access-view.ts", "guardian-access-panel.tsx"]) {
    const src = readFileSync(join(REPO_ROOT, "src/modules/academy/ui", name), "utf8");
    // Comments may say "no expiry"; the code must not use one.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/expir/i.test(code), `${name}: no expiry in code`);
    assert.ok(!/expiresAt|validUntil|untilDate/i.test(code), `${name}: no time-based field`);
    // The panel tells the adult that consent is separate (a sentence); it must never be a scope name or option.
    assert.ok(!/CONSENT/.test(code), `${name}: CONSENT is never a scope name`);
  }
});

test("history wording covers every event of the append-only history, and names the actor by type only", () => {
  const events = [...GUARDIAN_ACCESS_EVENTS];
  assert.deepEqual(events, ["ACCESS_ENDED_ADULTHOOD", "GRANTED", "SCOPES_CHANGED", "REVOKED", "ENDED_LINK_INACTIVE", "ENDED_ADULT_FLAG_CLEARED"]);
  const labels = events.map((e) => eventLabel(e));
  assert.equal(new Set(labels).size, events.length, "every event has its own wording");
  for (const l of labels) assert.notEqual(l, "Access updated");
  assert.equal(eventLabel("SOMETHING_NEW"), "Access updated", "an unknown event is shown generically, not hidden");
  assert.equal(actorText({ byPlayer: true, actorRole: "ADULT_PLAYER" }), "You");
  assert.equal(actorText({ byPlayer: false, actorRole: "ADMIN" }), "The academy (Staff · Administrator)");
  assert.equal(actorText({ byPlayer: false, actorRole: "OWNER" }), "The academy (Owner)");
  assert.equal(actorText({ byPlayer: false, actorRole: null }), "The academy");
  assert.equal(scopeSummary(["MEDIA", "FEES"]), "Fees, Media");
  assert.equal(scopeSummary(null), "");
});

test("the screen decides no authority: no role comparison and no direct request other than the two RC-4 endpoints", () => {
  const view = readFileSync(join(REPO_ROOT, "src/modules/academy/ui/guardian-access-view.ts"), "utf8");
  const panel = readFileSync(join(REPO_ROOT, "src/modules/academy/ui/guardian-access-panel.tsx"), "utf8");
  for (const [name, src] of [["view", view], ["panel", panel]] as const)
    assert.ok(!/"(OWNER|ADMIN|HEAD_COACH|COACH|FINANCE|NUTRITION_PRO|GUARDIAN|ADULT_PLAYER)"/.test(src), `${name}: no role literal`);
  const paths = [...panel.matchAll(/academyRequest[^(]*\(\s*(?:<[^>]*>)?\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(paths, ["/guardian-access", "/guardian-access/save"]);
  assert.ok(/view\.manage/.test(panel), "controls appear only when the server says manage");
  assert.ok(/version: g\.version/.test(panel), "the version just read is sent back");
});

test("revoking always asks first: the only path to an empty-scope save is the confirmation dialog", () => {
  const panel = readFileSync(join(REPO_ROOT, "src/modules/academy/ui/guardian-access-panel.tsx"), "utf8");
  // The Revoke button only opens the confirmation.
  assert.ok(/aria-label=\{`Revoke all access for \$\{g\.name\}`\}[\s\S]{0,120}onClick=\{\(\) => setConfirming\(/.test(panel), "the Revoke button opens the confirmation");
  // The empty-scope save ("revoke" action) is called exactly once, inside the confirmation's confirm handler.
  const revokeSaves = [...panel.matchAll(/await save\([^)]*\[\][^)]*"revoke"/g)];
  assert.equal(revokeSaves.length, 1, "one revoke call site");
  const modal = panel.slice(panel.indexOf("<Modal"));
  assert.ok(modal.includes('"revoke", "Access revoked."'), "and it is inside the dialog");
  // Dialog behaviour: the shared native dialog (focus trap, Escape, focus return), Cancel focused first, disabled while saving.
  assert.ok(/from "\.\.\/\.\.\/training\/ui\/common"/.test(panel) && /<Modal /.test(panel));
  assert.ok(/<CancelButton /.test(modal), "the dialog uses the Cancel button that takes focus first");
  const cancel = panel.slice(panel.indexOf("function CancelButton"), panel.indexOf("export function GuardianAccessPanel"));
  assert.ok(/requestAnimationFrame\(\(\) => ref\.current\?\.focus\(\)\)/.test(cancel), "focus is set once the native dialog is open");
  assert.ok(!/autoFocus/.test(panel.replace(/`autoFocus`/g, "")), "autoFocus runs before the dialog opens and is not used");
  assert.ok(/disabled=\{!!pending\}/.test(modal), "buttons are disabled while a request runs");
  assert.ok(/if \(pending\) return false;/.test(panel), "one request at a time");
});

test("the screen has a loading state, a retry and screen-reader announcements; the empty state cannot show while loading", () => {
  const panel = readFileSync(join(REPO_ROOT, "src/modules/academy/ui/guardian-access-panel.tsx"), "utf8");
  const beforeView = panel.slice(panel.indexOf("if (!view)"), panel.indexOf("if (!view.manage)"));
  assert.ok(/Loading your guardian access…/.test(beforeView) && /role="status"/.test(beforeView), "loading is announced");
  assert.ok(/Try again/.test(beforeView) && /role="alert"/.test(beforeView), "a failed load is announced and can be retried");
  assert.ok(!/No guardian is linked/.test(beforeView), "the empty state is only reachable once data has loaded");
  assert.ok(/aria-busy/.test(panel) && /className="sr-only" role="status"/.test(panel), "pending work is announced");
  assert.ok(/role="status">\{notice\}/.test(panel.replace(/\s+/g, " ").replace(/> \{notice\}/, ">{notice}")) || /\{notice && <div className="notice" role="status">/.test(panel), "success is announced");
});

test("the Family Portal shows the screen only inside the adult PLAYER account type, derived from the authority module", () => {
  const portal = readFileSync(join(REPO_ROOT, "src/modules/academy/ui/family-portal.tsx"), "utf8").replace(/\s+/g, " ");
  assert.ok(/authorityOf\(data\.actor\.role\)\?\.accountType === "PLAYER" && \( <GuardianAccessPanel \/> \)/.test(portal), "rendered only for the PLAYER account type");
  assert.ok(!/"GUARDIAN"/.test(portal) && !/"ADULT_PLAYER"/.test(portal), "no role literal in the family portal");
});

test("a superseded or late read never replaces the screen or wipes ticked sections", () => {
  const panel = readFileSync(join(REPO_ROOT, "src/modules/academy/ui/guardian-access-panel.tsx"), "utf8");
  assert.ok(/const load = useCallback\(async \(current: \(\) => boolean = \(\) => true\)/.test(panel), "load takes a currency check");
  assert.ok(/if \(!current\(\)\) return false;\s*setView\(next\);\s*setDrafts\(\{\}\);/.test(panel), "an out-of-date answer is dropped before it touches state");
  assert.ok(/let live = true;\s*void load\(\(\) => live\);\s*return \(\) => \{\s*live = false;/.test(panel), "the mount effect marks its read out of date when it is cleaned up");
});
