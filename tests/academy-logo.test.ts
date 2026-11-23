import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { FIXTURE_PASSWORD, addFixtureUser } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, unique } from "./helpers/accounts";
import { LOGO_MAX_BYTES, checkLogo, publicSettings } from "../src/modules/settings/domain/logo";

/**
 * The academy profile and logo: a small PNG kept with the academy settings, checked on the server, never sent inside the
 * page data (only through GET /api/academy/logo, to the academy's own members), and changeable only by whoever may change
 * the academy settings.
 */
let app: Harness;
before(async () => {
  app = await startHarness("academy-logo");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app.stop();
}, { timeout: HOOK_TIMEOUT });

const db = () => database();
/** A PNG that is valid as far as the checks go (signature + IHDR); the picture data itself is not needed. */
function png(width: number, height: number, padTo = 0) {
  const bytes = Buffer.alloc(Math.max(33, padTo));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const url = (bytes: Buffer, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;
const GOOD = url(png(512, 512, 600));

test("only a real, small PNG is accepted as a logo", () => {
  const ok = checkLogo(GOOD);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual([ok.width, ok.height], [512, 512]);
  const refused = (value: unknown, why: RegExp) => {
    const r = checkLogo(value);
    assert.equal(r.ok, false, String(value).slice(0, 40));
    if (!r.ok) assert.match(r.message, why);
  };
  refused(url(png(512, 512), "image/jpeg"), /PNG/);
  refused(url(Buffer.from("<svg onload=alert(1)></svg>"), "image/svg+xml"), /PNG/);
  refused("data:image/png;base64,@@@not-base64@@@", /not a supported PNG/);
  refused(url(Buffer.from("this is not a png at all, only text bytes!!")), /not a supported PNG/);
  refused(url(png(512, 512, LOGO_MAX_BYTES + 1)), /larger than 200 KB|PNG logo under 200 KB/);
  refused(url(png(8, 512)), /too small/);
  refused(url(png(512, 4096)), /too large/);
  refused(42, /PNG/);
  refused(undefined, /PNG/);
  // A PNG whose first chunk is not IHDR is refused.
  const odd = png(512, 512, 100);
  odd.write("XXXX", 12, "ascii");
  refused(url(odd), /not a supported PNG/);
});

test("page data never carries the logo itself, only whether one exists", () => {
  const shown = publicSettings({ version: 3, data: { colour: "#17644e", logoData: GOOD } });
  assert.equal(JSON.stringify(shown).includes("base64"), false);
  assert.equal(shown.data.hasLogo, true);
  assert.equal(publicSettings({ version: 1, data: { colour: "#17644e" } }).data.hasLogo, false);
});

async function person(role: "OWNER" | "COACH", academyId: "green" | "blue" = "green") {
  const id = `lg-${unique()}`;
  const { email } = await addFixtureUser(id, [{ academyId, role }]);
  const client = app.anonymous();
  const r = await client.signIn(email, FIXTURE_PASSWORD);
  assert.equal(r.status, 200, r.text.slice(0, 150));
  return { id, client };
}
type Boot = { settings: { version: number; data: Record<string, unknown> } };
async function settingsBody(c: Awaited<ReturnType<typeof person>>["client"], extra: Record<string, unknown> = {}) {
  const boot = (await c.get("/api/academy")).json as Boot;
  const s = boot.settings.data as { country: string; currency: string; colour: string; policy: string; retentionDays: number; features: Record<string, boolean> };
  const identity = (await c.get("/api/academy/identity")).json as { academy: { name: string } };
  return {
    version: boot.settings.version,
    name: identity.academy.name,
    timezone: "Asia/Kolkata",
    country: s.country,
    currency: s.currency,
    colour: s.colour,
    policy: s.policy,
    retentionDays: s.retentionDays,
    features: s.features,
    ...extra,
  };
}

test("an owner saves the profile and a logo; the logo is served to members only and revalidates by ETag", async () => {
  const owner = await person("OWNER");
  const save = await owner.client.post("/api/academy/settings/save", await settingsBody(owner.client, {
    city: "Gurugram",
    contactEmail: "office@example.test",
    about: "A friendly academy for juniors.",
    logoData: GOOD,
  }));
  assert.equal(save.status, 200, save.text.slice(0, 200));

  const boot = (await owner.client.get("/api/academy")).json as Boot;
  assert.equal(boot.settings.data.hasLogo, true);
  assert.equal(boot.settings.data.city, "Gurugram");
  assert.equal(boot.settings.data.contactEmail, "office@example.test");
  assert.equal(boot.settings.data.about, "A friendly academy for juniors.");
  assert.ok(!JSON.stringify(boot).includes("iVBORw0KGgo"), "the picture is not inside the page data");

  const identity = (await owner.client.get("/api/academy/identity")).json as { academy: { logo: string | null } };
  assert.match(identity.academy.logo ?? "", /^\/api\/academy\/logo\?v=\d+$/);

  const served = await owner.client.get("/api/academy/logo");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("cache-control") ?? "", /no-cache/);
  const etag = served.headers.get("etag")!;
  assert.ok(etag);
  assert.equal((await owner.client.get("/api/academy/logo", { headers: { "if-none-match": etag } })).status, 304);

  // Another member of the SAME academy sees it; a member of ANOTHER academy sees only their own (here: none).
  const coach = await person("COACH");
  assert.equal((await coach.client.get("/api/academy/logo")).status, 200);
  const other = await person("OWNER", "blue");
  const theirs = await other.client.get("/api/academy/logo");
  assert.equal(theirs.status, 404, "another academy's logo is never served");
  assert.equal((await app.anonymous().get("/api/academy/logo")).status, 401);

  // The change history records that the logo changed, not the picture.
  const revisions = await db().select().from(t.recordRevisions).where(eq(t.recordRevisions.kind, "academy-settings"));
  const text = JSON.stringify(revisions.map((r) => r.data));
  assert.ok(!text.includes("iVBORw0KGgo"), "the history does not copy the picture");
  assert.ok(text.includes('"logo":"changed"'));
});

test("saving later without a logo keeps it; an empty value clears a profile field; null removes the logo", async () => {
  const owner = await person("OWNER");
  assert.equal((await owner.client.post("/api/academy/settings/save", await settingsBody(owner.client, { city: "Pune", about: "Hello", logoData: GOOD }))).status, 200);
  assert.equal((await owner.client.post("/api/academy/settings/save", await settingsBody(owner.client, { about: "" }))).status, 200);
  let boot = (await owner.client.get("/api/academy")).json as Boot;
  assert.equal(boot.settings.data.hasLogo, true, "a save that says nothing about the logo keeps it");
  assert.equal(boot.settings.data.city, "Pune", "left out = unchanged");
  assert.equal(boot.settings.data.about, undefined, "empty = cleared");

  assert.equal((await owner.client.post("/api/academy/settings/save", await settingsBody(owner.client, { logoData: null }))).status, 200);
  boot = (await owner.client.get("/api/academy")).json as Boot;
  assert.equal(boot.settings.data.hasLogo, false);
  assert.equal((await owner.client.get("/api/academy/logo")).status, 404);
  assert.equal((await owner.client.get("/api/academy/identity")).json && ((await owner.client.get("/api/academy/identity")).json as { academy: { logo: unknown } }).academy.logo, null);
});

test("a bad logo or profile value is refused with a reason and nothing is saved", async () => {
  const owner = await person("OWNER");
  const before = ((await owner.client.get("/api/academy")).json as Boot).settings.version;
  for (const [extra, why] of [
    [{ logoData: url(png(512, 512), "image/jpeg") }, "LOGO_INVALID"],
    [{ logoData: url(png(8, 8)) }, "LOGO_INVALID"],
    [{ logoData: "data:image/png;base64,AAAA" }, "LOGO_INVALID"],
  ] as const) {
    const r = await owner.client.post("/api/academy/settings/save", await settingsBody(owner.client, extra));
    assert.equal(r.status, 400, JSON.stringify(extra).slice(0, 60));
    assert.equal(code(r), why);
  }
  for (const extra of [{ about: "x".repeat(251) }, { contactEmail: "not-an-email" }, { city: "c".repeat(81) }]) {
    const r = await owner.client.post("/api/academy/settings/save", await settingsBody(owner.client, extra));
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(extra).slice(0, 40));
  }
  assert.equal(((await owner.client.get("/api/academy")).json as Boot).settings.version, before, "nothing was saved");
});

test("a coach cannot change the logo or the profile", async () => {
  const coach = await person("COACH");
  const r = await coach.client.post("/api/academy/settings/save", await settingsBody(coach.client, { logoData: GOOD, about: "mine now" }));
  assert.equal(r.status, 403, r.text.slice(0, 150));
});
