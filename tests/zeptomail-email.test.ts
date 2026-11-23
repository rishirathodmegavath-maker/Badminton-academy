import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResendEmailProvider,
  ZeptoMailEmailProvider,
  createConfiguredEmailProvider,
  emailProviderConfig,
  validZeptoMailApiUrl,
  zeptoMailToken,
  type TransactionalEmailMessage,
} from "../src/infrastructure/email";
import { emailDeliveryConfigured } from "../src/modules/identity/email-delivery";
import { checkSecurityConfig } from "../src/modules/identity/security-config";

/**
 * Zoho ZeptoMail as a transactional email provider: the configuration, the adapter's request and its classification of
 * every kind of answer. ZeptoMail's endpoint is always stubbed here: no request leaves this process.
 */
const TOKEN = "wSsVR60zkBiTX_secret_ZeptoMail_send_mail_token_value_0123456789";
const FROM = "Sportozen <no-reply@sportozen.example>";
const env = (over: Record<string, string> = {}) => ({
  EMAIL_PROVIDER: "zeptomail",
  ZEPTOMAIL_TOKEN: TOKEN,
  EMAIL_FROM: FROM,
  ...over,
});
const pe = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const msg: TransactionalEmailMessage = {
  to: "player@example.test",
  subject: "Your Sportozen verification code",
  text: "Your code is 112233",
  html: "<p>Your code is <b>112233</b></p>",
  idempotencyKey: "email-otp:0b6c1f9e-0000-4000-8000-000000000001",
  kind: "EMAIL_VERIFICATION_OTP",
};

test("configuration: zeptomail is a real provider; the token prefix is optional; Resend is unchanged", () => {
  const ok = emailProviderConfig(env());
  assert.equal(ok.provider, "zeptomail");
  if (ok.provider === "zeptomail") {
    assert.equal(ok.token, TOKEN);
    assert.equal(ok.apiUrl, "https://api.zeptomail.com/v1.1/email");
    assert.equal(ok.from, FROM);
  }
  const prefixed = emailProviderConfig(env({ ZEPTOMAIL_TOKEN: `Zoho-enczapikey ${TOKEN}` }));
  assert.equal(prefixed.provider === "zeptomail" && prefixed.token, TOKEN, "the console's full header value is accepted");
  assert.equal(zeptoMailToken("  zoho-ENCZAPIKEY   abc "), "abc");
  const eu = emailProviderConfig(env({ ZEPTOMAIL_API_URL: "https://api.zeptomail.eu/v1.1/email" }));
  assert.equal(eu.provider === "zeptomail" && eu.apiUrl, "https://api.zeptomail.eu/v1.1/email");
  // Resend still works, and a disabled configuration is still disabled.
  assert.equal(emailProviderConfig({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: FROM }).provider, "resend");
  assert.equal(emailProviderConfig({}).provider, "disabled");
  assert.equal(emailProviderConfig({ EMAIL_PROVIDER: "none" }).provider, "disabled");
});

test("configuration: every incomplete or unsafe setting is refused, and no problem text ever contains the token", () => {
  const bad = (over: Record<string, string>) => emailProviderConfig(env(over));
  const variable = (c: ReturnType<typeof bad>) => (c.provider === "invalid" ? c.variable : c.provider);
  assert.equal(variable(bad({ ZEPTOMAIL_TOKEN: "" })), "ZEPTOMAIL_TOKEN");
  assert.equal(variable(bad({ ZEPTOMAIL_TOKEN: "Zoho-enczapikey " })), "ZEPTOMAIL_TOKEN");
  assert.equal(variable(bad({ ZEPTOMAIL_TOKEN: `${TOKEN} extra` })), "ZEPTOMAIL_TOKEN", "a space inside the token");
  assert.equal(variable(bad({ ZEPTOMAIL_TOKEN: `${TOKEN}\r\nX-Injected: 1` })), "ZEPTOMAIL_TOKEN", "line breaks");
  assert.equal(variable(bad({ EMAIL_FROM: "" })), "EMAIL_FROM");
  assert.equal(variable(bad({ EMAIL_FROM: "bad\r\nheader" })), "EMAIL_FROM");
  assert.equal(variable(bad({ EMAIL_FROM: "not-an-address" })), "EMAIL_FROM");
  for (const url of [
    "http://api.zeptomail.com/v1.1/email", // not https
    "https://evil.example/v1.1/email", // another host would receive the token
    "https://api.zeptomail.com.evil.example/v1.1/email",
    "https://user:pw@api.zeptomail.com/v1.1/email",
    "https://api.zeptomail.com:8443/v1.1/email",
    "https://api.zeptomail.com/v1.1/email?x=1",
    "not a url",
  ])
    assert.equal(variable(bad({ ZEPTOMAIL_API_URL: url })), "ZEPTOMAIL_API_URL", url);
  assert.equal(variable(emailProviderConfig({ EMAIL_PROVIDER: "smtp", ZEPTOMAIL_TOKEN: TOKEN, EMAIL_FROM: FROM })), "EMAIL_PROVIDER");
  // A token without a provider chosen is a mistake, not a silent "disabled".
  assert.equal(variable(emailProviderConfig({ ZEPTOMAIL_TOKEN: TOKEN })), "EMAIL_PROVIDER");
  // Choosing resend while only a ZeptoMail token exists is also refused.
  assert.equal(variable(emailProviderConfig({ EMAIL_PROVIDER: "resend", ZEPTOMAIL_TOKEN: TOKEN, EMAIL_FROM: FROM })), "RESEND_API_KEY");
  for (const c of [
    bad({ ZEPTOMAIL_TOKEN: `${TOKEN} extra` }),
    bad({ EMAIL_FROM: "bad" }),
    emailProviderConfig({ ZEPTOMAIL_TOKEN: TOKEN }),
    bad({ ZEPTOMAIL_API_URL: "https://evil.example/" }),
  ])
    assert.ok(!JSON.stringify(c).includes(TOKEN), "the token is never echoed");
  assert.ok(validZeptoMailApiUrl("https://api.zeptomail.in/v1.1/email"));
  assert.ok(validZeptoMailApiUrl("https://api.zeptomail.com.au/v1.1/email"));
});

test("delivery is 'configured' for either provider only; the factory returns the matching adapter; startup checks report it", () => {
  assert.equal(emailDeliveryConfigured(pe(env())), true);
  assert.equal(emailDeliveryConfigured(pe({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: FROM })), true);
  assert.equal(emailDeliveryConfigured(pe({})), false);
  assert.equal(emailDeliveryConfigured(pe(env({ ZEPTOMAIL_TOKEN: "" }))), false, "an incomplete configuration is not delivery");
  assert.equal(createConfiguredEmailProvider(env())?.name, "zeptomail");
  assert.ok(createConfiguredEmailProvider(env()) instanceof ZeptoMailEmailProvider);
  assert.ok(createConfiguredEmailProvider({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: FROM }) instanceof ResendEmailProvider);
  assert.equal(createConfiguredEmailProvider({}), null);
  assert.throws(() => createConfiguredEmailProvider(env({ ZEPTOMAIL_TOKEN: "" })), /ZEPTOMAIL_TOKEN/);
  const issues = checkSecurityConfig(env());
  assert.ok(issues.some((i) => i.level === "info" && /Zoho ZeptoMail/.test(i.message)));
  assert.equal(issues.filter((i) => i.level === "error" && i.variable.startsWith("EMAIL")).length, 0);
  const wrong = checkSecurityConfig(env({ ZEPTOMAIL_TOKEN: "" }));
  assert.ok(wrong.some((i) => i.level === "error" && i.variable === "ZEPTOMAIL_TOKEN"));
  assert.ok(!JSON.stringify(checkSecurityConfig(env({ EMAIL_FROM: "bad" }))).includes(TOKEN));
});

test("the request is exactly ZeptoMail's send API: endpoint, auth header, nested recipient, text and html, tracking off, reference", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ data: [{ code: "EM_104", additional_info: [], message: "OK" }], message: "OK", request_id: "2d6f.1a2b.k1.req-123" }), { status: 200 });
  }) as unknown as typeof fetch;
  for (const raw of [TOKEN, `Zoho-enczapikey ${TOKEN}`]) {
    const provider = new ZeptoMailEmailProvider({ token: raw, from: FROM, fetchImpl });
    const result = await provider.send(msg);
    assert.deepEqual(result, { ok: true, providerMessageId: "2d6f.1a2b.k1.req-123" });
  }
  assert.equal(seen[0].url, "https://api.zeptomail.com/v1.1/email");
  assert.equal(seen[0].init.method, "POST");
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Zoho-enczapikey ${TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal((seen[1].init.headers as Record<string, string>).Authorization, headers.Authorization, "prefix is not doubled");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), {
    from: { address: "no-reply@sportozen.example", name: "Sportozen" },
    to: [{ email_address: { address: "player@example.test" } }],
    subject: msg.subject,
    textbody: msg.text,
    htmlbody: msg.html,
    client_reference: msg.idempotencyKey,
    track_clicks: false,
    track_opens: false,
  });
  // A bare sender address (no display name) and no html.
  const bare = new ZeptoMailEmailProvider({ token: TOKEN, from: "no-reply@sportozen.example", fetchImpl });
  await bare.send({ ...msg, html: undefined });
  const body = JSON.parse(String(seen[2].init.body));
  assert.deepEqual(body.from, { address: "no-reply@sportozen.example" });
  assert.equal("htmlbody" in body, false);
  // A data centre other than the default.
  const eu = new ZeptoMailEmailProvider({ token: TOKEN, from: FROM, apiUrl: "https://api.zeptomail.eu/v1.1/email", fetchImpl });
  await eu.send(msg);
  assert.equal(seen[3].url, "https://api.zeptomail.eu/v1.1/email");
  // Constructor guards.
  assert.throws(() => new ZeptoMailEmailProvider({ token: "", from: FROM }));
  assert.throws(() => new ZeptoMailEmailProvider({ token: TOKEN, from: "" }));
  assert.throws(() => new ZeptoMailEmailProvider({ token: TOKEN, from: FROM, apiUrl: "https://evil.example/v1.1/email" }));
  assert.throws(() => new ZeptoMailEmailProvider({ token: "two words", from: FROM }));
});

test("every answer is classified: 2xx with an id sent; 429/408/5xx/network/timeout retried; other 4xx permanent; nothing secret leaks", async () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new ZeptoMailEmailProvider({
      token: TOKEN,
      from: FROM,
      fetchImpl: (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch,
    });
  const leaky = `bad ${TOKEN} player@example.test 112233`;

  assert.deepEqual(await answer(201, { message: "OK", request_id: "req-1" }).send(msg), { ok: true, providerMessageId: "req-1" });
  assert.deepEqual(await answer(200, "not json").send(msg), { ok: false, retryable: true, errorCode: "ZEPTOMAIL_INVALID_JSON" });
  assert.deepEqual(await answer(200, { message: "OK" }).send(msg), { ok: false, retryable: true, errorCode: "ZEPTOMAIL_MISSING_REQUEST_ID" });

  assert.deepEqual(await answer(429, { message: leaky }, { "retry-after": "30" }).send(msg), {
    ok: false,
    retryable: true,
    errorCode: "ZEPTOMAIL_HTTP_429",
    retryAfterSeconds: 30,
  });
  assert.deepEqual(await answer(503, { message: leaky }).send(msg), { ok: false, retryable: true, errorCode: "ZEPTOMAIL_HTTP_503" });
  assert.deepEqual(await answer(408, {}).send(msg), { ok: false, retryable: true, errorCode: "ZEPTOMAIL_HTTP_408" });

  // ZeptoMail's own identifiers are kept (they say WHY: unverified sender domain, bad key, daily limit ...), nothing else is.
  const unverified = { error: { code: "TM_4001", message: leaky, details: [{ code: "SM_111", message: `${leaky}`, target: "from" }] }, request_id: "r" };
  const r400 = await answer(400, unverified).send(msg);
  assert.deepEqual(r400, { ok: false, retryable: false, errorCode: "ZEPTOMAIL_TM_4001_SM_111" });
  assert.deepEqual(await answer(401, { error: { code: "TM_4001", details: [{ code: "SERR_157" }] } }).send(msg), {
    ok: false,
    retryable: false,
    errorCode: "ZEPTOMAIL_TM_4001_SERR_157",
  });
  assert.deepEqual(await answer(400, { data: { error_code: "TM_3201" }, message: "error" }).send(msg), {
    ok: false,
    retryable: false,
    errorCode: "ZEPTOMAIL_TM_3201",
  });
  assert.deepEqual(await answer(422, "<html>gateway</html>").send(msg), { ok: false, retryable: false, errorCode: "ZEPTOMAIL_HTTP_422" });
  for (const r of [r400, await answer(503, { message: leaky }).send(msg), await answer(400, { message: leaky }).send(msg)]) {
    const text = JSON.stringify(r);
    assert.ok(!text.includes(TOKEN) && !text.includes("player@example.test") && !text.includes("112233"), "no secret, address or code in a result");
  }

  const slow = new ZeptoMailEmailProvider({
    token: TOKEN,
    from: FROM,
    timeoutMs: 25,
    fetchImpl: ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch,
  });
  assert.deepEqual(await slow.send(msg), { ok: false, retryable: true, errorCode: "ZEPTOMAIL_TIMEOUT" });
  const down = new ZeptoMailEmailProvider({ token: TOKEN, from: FROM, fetchImpl: (async () => { throw new Error(`boom ${TOKEN}`); }) as unknown as typeof fetch });
  assert.deepEqual(await down.send(msg), { ok: false, retryable: true, errorCode: "ZEPTOMAIL_NETWORK_ERROR" });
  const controller = new AbortController();
  const aborted = new ZeptoMailEmailProvider({
    token: TOKEN,
    from: FROM,
    fetchImpl: ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch,
  });
  const pending = aborted.send(msg, controller.signal);
  controller.abort();
  assert.equal((await pending).ok, false, "a shutdown signal stops an in-flight send");
});
