import { test } from "node:test";
import assert from "node:assert/strict";
import { emailConfig, providerStatus } from "../src/modules/communications/providers/config";
import { sendEmail } from "../src/modules/communications/providers/zeptomail";
import { canonicalPhone, gmailLink, invitationText, mailtoLink, normalizePhone, outlookLink, whatsappLink } from "../src/modules/communications/share-links";
import type { FetchLike } from "../src/modules/communications/providers/transport";

/** Provider adapters and configuration, with a fake provider. No network, no database, no real credential. */
const TOKEN = "fake-token-Zk39Q-not-a-secret";
const EMAIL_ENV = { ZEPTOMAIL_SEND_TOKEN: TOKEN, ZEPTOMAIL_FROM_ADDRESS: "academy@example.test" };
const reply = (status: number, body: unknown): FetchLike => async () => new Response(JSON.stringify(body), { status });
const email = { to: { address: "mother@example.test", name: "Mother\nInjected: header" }, subject: "Trial\r\nBcc: evil@example.test", text: "Line one\n<script>alert(1)</script>", reference: "delivery-1" };

test("config: the optional e-mail service is configured only with everything it needs; problems name variables, never values", () => {
  assert.equal(emailConfig({}).ok, false);
  const none = emailConfig({});
  assert.deepEqual(!none.ok && none.problems, ["ZEPTOMAIL_SEND_TOKEN is not set", "ZEPTOMAIL_FROM_ADDRESS is not set"]);
  assert.equal(emailConfig(EMAIL_ENV).ok, true);
  const prefixed = emailConfig({ ...EMAIL_ENV, ZEPTOMAIL_SEND_TOKEN: `Zoho-enczapikey ${TOKEN}` });
  assert.equal(prefixed.ok && prefixed.config.token, TOKEN, "the console prefix is accepted and stripped");
  assert.equal(emailConfig({ ...EMAIL_ENV, ZEPTOMAIL_FROM_ADDRESS: "not-an-address" }).ok, false);
  for (const url of ["http://api.zeptomail.com/v1.1/email", "https://evil.example.test/v1.1/email", "https://zeptomail.com.evil.test/x", "nonsense"])
    assert.equal(emailConfig({ ...EMAIL_ENV, ZEPTOMAIL_API_URL: url }).ok, false, `${url} must be refused (the token would be sent there)`);
  assert.equal(emailConfig({ ...EMAIL_ENV, ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email" }).ok, true);
  const bad = emailConfig({ ZEPTOMAIL_SEND_TOKEN: TOKEN, ZEPTOMAIL_FROM_ADDRESS: "nope" });
  assert.ok(!JSON.stringify(bad).includes(TOKEN), "a token never appears in a problem message");

  // WhatsApp has no provider: it is always sent by a person through a free link. E-mail is manual until a service is set up.
  assert.deepEqual(providerStatus({}), { EMAIL: "MANUAL", WHATSAPP: "MANUAL" });
  assert.deepEqual(providerStatus(EMAIL_ENV), { EMAIL: "AVAILABLE", WHATSAPP: "MANUAL" });
});

test("ZeptoMail: request shape, no header or HTML injection, one recipient per request", async () => {
  const cfg = emailConfig(EMAIL_ENV);
  assert.ok(cfg.ok);
  let seen: { url: string; init: RequestInit } | null = null;
  const result = await sendEmail(cfg.config, email, async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ request_id: "req-123", message: "OK" }), { status: 201 });
  });
  assert.deepEqual(result, { kind: "sent", providerId: "req-123" });
  const s = seen as unknown as { url: string; init: RequestInit };
  assert.equal(s.url, "https://api.zeptomail.com/v1.1/email");
  assert.equal(s.init.method, "POST");
  assert.equal((s.init.headers as Record<string, string>).Authorization, `Zoho-enczapikey ${TOKEN}`);
  const body = JSON.parse(String(s.init.body));
  assert.equal(body.to.length, 1);
  assert.equal(body.to[0].email_address.address, "mother@example.test");
  assert.ok(!/[\r\n]/.test(body.subject) && !/[\r\n]/.test(body.to[0].email_address.name), "subject and name are single-line");
  assert.ok(!body.htmlbody.includes("<script>") && body.htmlbody.includes("&lt;script&gt;"), "message text is escaped in the HTML part");
  assert.equal(body.client_reference, "delivery-1");
  assert.equal(body.from.address, "academy@example.test");
});

test("ZeptoMail: outcomes are classified as sent, retry or failed, and a token never reaches the detail", async () => {
  const cfg = emailConfig(EMAIL_ENV);
  assert.ok(cfg.ok);
  const run = (f: FetchLike) => sendEmail(cfg.config, email, f);
  assert.equal((await run(reply(200, { request_id: "x" }))).kind, "sent");
  for (const status of [429, 500, 502, 503, 408]) assert.equal((await run(reply(status, { error: { code: "TM_X", message: "busy" } }))).kind, "retry", `HTTP ${status}`);
  for (const status of [400, 404, 422]) assert.equal((await run(reply(status, { error: { code: "TM_3201", message: "Invalid recipient" } }))).kind, "failed", `HTTP ${status}`);
  const auth = await run(reply(401, { error: { code: "TM_4001", message: `Access denied ${TOKEN}` } }));
  assert.equal(auth.kind, "failed");
  assert.ok(auth.kind === "failed" && /credentials/.test(auth.detail) && !auth.detail.includes(TOKEN), "an echoed token is redacted");
  const network = await run(async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(network.kind, "retry");
  const timeout = await run(async () => {
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  });
  assert.ok(timeout.kind === "retry" && /timed out/.test(timeout.detail));
  assert.equal((await run(async () => new Response("<html>gateway</html>", { status: 502 }))).kind, "retry", "a non-JSON error body is still classified");
  for (const r of [auth, network, timeout]) assert.ok(!JSON.stringify(r).includes("mother@example.test"), "no address in a stored detail");
});

test("phone numbers become E.164 only when unambiguous", () => {
  assert.equal(normalizePhone("+91 98765-43210", null), "919876543210");
  assert.equal(normalizePhone("0044 7700 900123", null), "447700900123");
  assert.equal(normalizePhone("98765 43210", null), null, "no country code and no default: refused, not guessed");
  assert.equal(normalizePhone("98765 43210", "91"), "919876543210");
  assert.equal(normalizePhone("098765 43210", "91"), "919876543210", "a leading trunk zero is dropped");
  for (const bad of ["", "abc", "+12", "+9198765432101234567", "call me", "+91 98765 43210 ext 5", "++919876543210", "91+9876543210", "+91+9876543210"]) assert.equal(normalizePhone(bad, "91"), null, bad);
});

test("free links: wa.me opens the right chat with the text encoded; mailto fills recipient, subject and body", () => {
  const text = "Hello Meera,\n\nTrial & fees: 50% off? #1";
  const link = whatsappLink("+91 98765-43210", text);
  assert.ok(link.startsWith("https://wa.me/919876543210?text="));
  assert.equal(decodeURIComponent(link.split("?text=")[1]), text, "the message survives the round trip unchanged");
  assert.ok(!link.includes("+") && !link.includes(" ") && !link.includes("\n"), "no raw plus, space or line break in the URL");
  assert.equal(whatsappLink("98765 43210", "Hi", "91"), "https://wa.me/919876543210?text=Hi", "a local number is read in the academy's country");
  assert.equal(whatsappLink("not a number", "Hi"), "https://wa.me/?text=Hi", "no usable number: WhatsApp opens its own chooser");
  assert.equal(whatsappLink(null, "Hi"), "https://wa.me/?text=Hi");
  const mail = mailtoLink("mother@example.test", "Trial day", "Line one\nLine two & more");
  assert.equal(mail, "mailto:mother@example.test?subject=Trial%20day&body=Line%20one%0ALine%20two%20%26%20more");
  const injected = mailtoLink("a@b.test", "Subject\r\nBcc: evil@example.test", "x");
  assert.ok(!/[\r\n]/.test(injected), "no raw line break anywhere in the link");
  assert.ok(injected.includes("Subject%0D%0ABcc%3A%20evil%40example.test"), "a line break in the subject is encoded, not sent as a header");
  assert.equal(canonicalPhone("98765 43210", "91"), "+919876543210");
  assert.equal(canonicalPhone("98765 43210", null), null);
  // A computer with no mail app cannot follow a mailto: link, so the web compose links must exist and be safe too.
  assert.equal(
    gmailLink("mother@example.test", "Trial day", "Line one\nLine two & more"),
    "https://mail.google.com/mail/?view=cm&fs=1&to=mother%40example.test&su=Trial%20day&body=Line%20one%0ALine%20two%20%26%20more",
  );
  assert.equal(
    outlookLink("mother@example.test", "Trial day", "Hi & bye"),
    "https://outlook.live.com/mail/0/deeplink/compose?to=mother%40example.test&subject=Trial%20day&body=Hi%20%26%20bye",
  );
  assert.ok(!/[\r\n ]/.test(gmailLink("a@b.test", "Subject\r\nBcc: evil@example.test", "x")), "no raw break or space in the web link");
});

test("free links: the invitation text carries the link and says who to sign in as", () => {
  const t = invitationText("Greenfield Badminton", "Meera", "https://example.test/invite#abc");
  assert.ok(t.includes("Greenfield Badminton") && t.includes("Meera") && t.includes("https://example.test/invite#abc"));
  assert.ok(/sign in with the email address/.test(t));
  assert.ok(!/Hello ,/.test(invitationText("Academy", "", "https://x.test/invite#t")), "no stray comma when no name is given");
});
