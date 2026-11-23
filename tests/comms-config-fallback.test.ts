import { test } from "node:test";
import assert from "node:assert/strict";
import { emailConfig, providerStatus } from "../src/modules/communications/providers/config";
import { sendEmail } from "../src/modules/communications/providers/zeptomail";
import { readFileSync } from "node:fs";
import { ZeptoMailEmailProvider } from "../src/infrastructure/email/zeptomail";
import { validZeptoMailApiUrl, zeptoMailToken } from "../src/infrastructure/email/provider";
import { repoPath } from "./helpers/paths";

/**
 * Communications e-mail reuses the authentication ZeptoMail setting (ZEPTOMAIL_TOKEN, EMAIL_FROM) when its own
 * (ZEPTOMAIL_SEND_TOKEN, ZEPTOMAIL_FROM_ADDRESS) are absent. An explicit variable always wins. Pure configuration: no
 * network, no database, no real credential.
 */
const OWN_TOKEN = "own-token-Qw81x-not-a-secret";
const AUTH_TOKEN = "auth-token-Zk39Q-not-a-secret";
const OWN_FROM = "academy@example.test";
const AUTH_FROM = "Sportozen Auth <no-reply@auth.example.test>";
const ok = (env: Record<string, string | undefined>) => {
  const r = emailConfig(env);
  assert.ok(r.ok, JSON.stringify(r));
  return r.config;
};
const problems = (env: Record<string, string | undefined>) => {
  const r = emailConfig(env);
  assert.ok(!r.ok, "expected the configuration to be refused");
  return r.problems;
};

test("explicit communications variables always override the authentication fallback", () => {
  const cfg = ok({
    ZEPTOMAIL_SEND_TOKEN: OWN_TOKEN,
    ZEPTOMAIL_FROM_ADDRESS: OWN_FROM,
    ZEPTOMAIL_FROM_NAME: "Academy Office",
    ZEPTOMAIL_TOKEN: AUTH_TOKEN,
    EMAIL_FROM: AUTH_FROM,
  });
  assert.equal(cfg.token, OWN_TOKEN);
  assert.equal(cfg.fromAddress, OWN_FROM);
  assert.equal(cfg.fromName, "Academy Office", "an explicit sender name beats the name inside EMAIL_FROM");
  // Without an explicit name, the name of the authentication sender is NOT borrowed for a different explicit address.
  assert.equal(ok({ ZEPTOMAIL_SEND_TOKEN: OWN_TOKEN, ZEPTOMAIL_FROM_ADDRESS: OWN_FROM, EMAIL_FROM: AUTH_FROM }).fromName, "Sportozen Academy");
  // An explicit but WRONG value is reported; it is never silently replaced by the fallback.
  const bad = problems({ ZEPTOMAIL_SEND_TOKEN: OWN_TOKEN, ZEPTOMAIL_FROM_ADDRESS: "not-an-address", EMAIL_FROM: AUTH_FROM, ZEPTOMAIL_TOKEN: AUTH_TOKEN });
  assert.deepEqual(bad, ["ZEPTOMAIL_FROM_ADDRESS is not a valid e-mail address"]);
});

test("fallback: unset or blank communications variables use ZEPTOMAIL_TOKEN and EMAIL_FROM; the API URL stays shared", () => {
  const cfg = ok({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM });
  assert.equal(cfg.token, AUTH_TOKEN);
  assert.equal(cfg.fromAddress, "no-reply@auth.example.test", "EMAIL_FROM 'Name <address>' is split: ZeptoMail gets the bare address");
  assert.equal(cfg.fromName, "Sportozen Auth", "and the display name becomes the sender name");
  assert.equal(cfg.apiUrl, "https://api.zeptomail.com/v1.1/email");

  // blank explicit values count as unset
  const blank = ok({ ZEPTOMAIL_SEND_TOKEN: "  ", ZEPTOMAIL_FROM_ADDRESS: "", ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: "no-reply@auth.example.test" });
  assert.equal(blank.token, AUTH_TOKEN);
  assert.equal(blank.fromAddress, "no-reply@auth.example.test");
  assert.equal(blank.fromName, "Sportozen Academy", "a bare EMAIL_FROM has no name: the default is used");

  // the console prefix on the authentication token is accepted, exactly as for the communications token
  assert.equal(ok({ ZEPTOMAIL_TOKEN: `Zoho-enczapikey ${AUTH_TOKEN}`, EMAIL_FROM: AUTH_FROM }).token, AUTH_TOKEN);
  // a quoted display name
  assert.equal(ok({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: '"Sportozen Office" <no-reply@auth.example.test>' }).fromName, "Sportozen Office");

  // mixed: each variable resolves on its own
  const mixedA = ok({ ZEPTOMAIL_SEND_TOKEN: OWN_TOKEN, EMAIL_FROM: AUTH_FROM, ZEPTOMAIL_TOKEN: AUTH_TOKEN });
  assert.deepEqual([mixedA.token, mixedA.fromAddress], [OWN_TOKEN, "no-reply@auth.example.test"]);
  const mixedB = ok({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, ZEPTOMAIL_FROM_ADDRESS: OWN_FROM, EMAIL_FROM: AUTH_FROM });
  assert.deepEqual([mixedB.token, mixedB.fromAddress], [AUTH_TOKEN, OWN_FROM]);

  // the shared API URL applies to the fallback too, and is validated the same way
  assert.equal(ok({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM, ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email" }).apiUrl, "https://api.zeptomail.in/v1.1/email");
  for (const url of ["http://api.zeptomail.com/v1.1/email", "https://evil.example.test/v1.1/email", "nonsense"])
    assert.equal(emailConfig({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM, ZEPTOMAIL_API_URL: url }).ok, false, `${url} must be refused`);
  assert.deepEqual(providerStatus({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM }).EMAIL, "AVAILABLE");
});

test("missing or invalid configuration is refused with variable names only, never values", () => {
  // nothing at all: exactly the messages the channel always gave
  assert.deepEqual(problems({}), ["ZEPTOMAIL_SEND_TOKEN is not set", "ZEPTOMAIL_FROM_ADDRESS is not set"]);
  assert.deepEqual(problems({ EMAIL_FROM: AUTH_FROM }), ["ZEPTOMAIL_SEND_TOKEN is not set"], "a sender alone is not enough");
  assert.deepEqual(problems({ ZEPTOMAIL_TOKEN: AUTH_TOKEN }), ["ZEPTOMAIL_FROM_ADDRESS is not set"], "a token alone is not enough");
  assert.deepEqual(problems({ ZEPTOMAIL_TOKEN: "   ", EMAIL_FROM: "   " }), ["ZEPTOMAIL_SEND_TOKEN is not set", "ZEPTOMAIL_FROM_ADDRESS is not set"]);

  // an invalid fallback sender is named as EMAIL_FROM, and its value is not echoed
  for (const from of ["not-an-address", "Name <nope>", "Name <a@example.test> <b@example.test>", "<>"]) {
    const found = problems({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: from });
    assert.deepEqual(found, ["EMAIL_FROM is not a valid e-mail address"], from);
    assert.ok(!JSON.stringify(found).includes(from));
  }
  // no credential or address ever appears in any problem text
  const all = JSON.stringify([
    problems({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: "bad-sender-value" }),
    problems({ ZEPTOMAIL_SEND_TOKEN: OWN_TOKEN, ZEPTOMAIL_FROM_ADDRESS: "bad-own-sender" }),
    problems({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM, ZEPTOMAIL_API_URL: "http://api.zeptomail.com/x" }),
  ]);
  for (const secret of [AUTH_TOKEN, OWN_TOKEN, "bad-sender-value", "bad-own-sender", "no-reply@auth.example.test"]) assert.ok(!all.includes(secret), `${secret} must not appear`);
  assert.deepEqual(providerStatus({ EMAIL_FROM: AUTH_FROM }).EMAIL, "MANUAL", "an incomplete e-mail service means e-mail is sent by hand, for free");

  // control characters in the display name cannot reach the request: they are dropped, and the length is capped
  const messy = ok({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: `"Evil\r\nBcc: x" <no-reply@auth.example.test>` });
  assert.ok(!/[\r\n]/.test(messy.fromName));
  assert.ok(ok({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: `${"N".repeat(300)} <no-reply@auth.example.test>` }).fromName.length <= 100);
});

test("a fallback configuration sends the same request as an explicit one", async () => {
  const send = async (env: Record<string, string>) => {
    let seen: { url: string; init: RequestInit } | null = null;
    const cfg = ok(env);
    const result = await sendEmail(cfg, { to: { address: "mother@example.test", name: "Mother" }, subject: "Hello", text: "Body", reference: "d-1" }, async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ request_id: "req-9" }), { status: 201 });
    });
    assert.deepEqual(result, { kind: "sent", providerId: "req-9" });
    const s = seen as unknown as { url: string; init: RequestInit };
    return { url: s.url, auth: (s.init.headers as Record<string, string>).Authorization, body: JSON.parse(String(s.init.body)) };
  };
  const viaAuth = await send({ ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM });
  assert.equal(viaAuth.url, "https://api.zeptomail.com/v1.1/email");
  assert.equal(viaAuth.auth, `Zoho-enczapikey ${AUTH_TOKEN}`);
  assert.deepEqual(viaAuth.body.from, { address: "no-reply@auth.example.test", name: "Sportozen Auth" });
  const viaOwn = await send({ ZEPTOMAIL_SEND_TOKEN: OWN_TOKEN, ZEPTOMAIL_FROM_ADDRESS: OWN_FROM, ZEPTOMAIL_TOKEN: AUTH_TOKEN, EMAIL_FROM: AUTH_FROM });
  assert.equal(viaOwn.auth, `Zoho-enczapikey ${OWN_TOKEN}`);
  assert.equal(viaOwn.body.from.address, OWN_FROM);
  assert.deepEqual(Object.keys(viaAuth.body).sort(), Object.keys(viaOwn.body).sort(), "same request shape either way");
});

/** What the authentication adapter itself does with a token and an endpoint (the construction is the validation). */
const authAccepts = (token: string, apiUrl: string) => {
  try {
    new ZeptoMailEmailProvider({ token, from: "no-reply@auth.example.test", apiUrl });
    return true;
  } catch {
    return false;
  }
};
const SENDER = "no-reply@auth.example.test";

test("parity: communications accepts and refuses exactly the API URLs the authentication adapter does", () => {
  const urls = [
    "https://api.zeptomail.com/v1.1/email", "https://api.zeptomail.in/v1.1/email", "https://api.zeptomail.eu/v1.1/email",
    "https://api.zeptomail.com.au/v1.1/email", "https://API.ZEPTOMAIL.COM/v1.1/email",
    "http://api.zeptomail.com/v1.1/email", "https://evil.example.test/v1.1/email", "https://zeptomail.com.evil.test/x",
    "https://api.zeptomail.com.evil.test/v1.1/email", "https://zeptomail.com/v1.1/email", "https://mail.zeptomail.com/v1.1/email",
    "https://api.zeptomail.com:8443/v1.1/email", "https://user:pw@api.zeptomail.com/v1.1/email", "https://api.zeptomail.com/v1.1/email?x=1",
    "https://api.zeptomail.com/v1.1/email#frag", "ftp://api.zeptomail.com/x", "nonsense", "//api.zeptomail.com/x",
  ];
  for (const url of urls) {
    const mine = emailConfig({ ZEPTOMAIL_TOKEN: "tok-123", EMAIL_FROM: SENDER, ZEPTOMAIL_API_URL: url }).ok;
    assert.equal(mine, validZeptoMailApiUrl(url), `${url}: same verdict as validZeptoMailApiUrl`);
    assert.equal(mine, authAccepts("tok-123", url), `${url}: same verdict as the authentication adapter`);
  }
  // a few of them are not trivially "both say yes"
  for (const refused of ["https://api.zeptomail.com:8443/x", "https://user:pw@api.zeptomail.com/x", "https://api.zeptomail.com/x?x=1", "https://zeptomail.com/x", "https://mail.zeptomail.com/x"])
    assert.equal(emailConfig({ ZEPTOMAIL_TOKEN: "tok-123", EMAIL_FROM: SENDER, ZEPTOMAIL_API_URL: refused }).ok, false, refused);
  assert.equal(emailConfig({ ZEPTOMAIL_TOKEN: "tok-123", EMAIL_FROM: SENDER, ZEPTOMAIL_API_URL: "https://api.zeptomail.com.au/v1.1/email" }).ok, true);
  // unset or blank means the shared default, which both accept
  assert.equal(emailConfig({ ZEPTOMAIL_TOKEN: "tok-123", EMAIL_FROM: SENDER, ZEPTOMAIL_API_URL: "   " }).ok, true);
});

test("parity: communications reads a token exactly as the authentication adapter does (prefix removed, nothing left over, no whitespace)", () => {
  const tokens = ["abc123", "Zoho-enczapikey abc123", "zoho-enczapikey    abc123", "  Zoho-enczapikey abc123  ", "Zoho-enczapikey", "Zoho-enczapikey   ", "ab cd", "Zoho-enczapikey ab cd", "abc\tdef"];
  for (const raw of tokens) {
    for (const variable of ["ZEPTOMAIL_SEND_TOKEN", "ZEPTOMAIL_TOKEN"]) {
      const env = { [variable]: raw, ZEPTOMAIL_FROM_ADDRESS: "academy@example.test" };
      const mine = emailConfig(env);
      const wanted = authAccepts(raw, "https://api.zeptomail.com/v1.1/email") && raw.trim() !== "";
      assert.equal(mine.ok, wanted, `${JSON.stringify(raw)} via ${variable}: same verdict as the authentication adapter`);
      if (mine.ok) assert.equal(mine.config.token, zeptoMailToken(raw), "and the same token is sent");
      else assert.ok(!JSON.stringify(mine.problems).includes("abc123") && !JSON.stringify(mine.problems).includes("ab cd"), "a refusal never echoes the token");
    }
  }
});

test("parity: the rules live in the authentication module only; the communications config imports them", () => {
  const source = readFileSync(repoPath("src/modules/communications/providers/config.ts"), "utf8");
  assert.match(source, /infrastructure\/email\/provider/);
  assert.ok(!/ZEPTO_HOST|DEFAULT_ZEPTO_URL|api\\\.zeptomail/.test(source), "no second copy of the host rule or the default URL");
});
