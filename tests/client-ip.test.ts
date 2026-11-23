import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClientIpConfigError,
  clientIpConfig,
  clientIpTrusted,
  parseTrustedProxies,
} from "../src/modules/identity/client-ip";
/** The deployment setting that decides whether a forwarding header may be believed. */
test("unset or blank TRUSTED_PROXIES trusts no header at all", () => {
  for (const env of [
    {},
    { TRUSTED_PROXIES: "" },
    { TRUSTED_PROXIES: " , ," },
  ]) {
    assert.deepEqual(clientIpConfig(env), { ipAddressHeaders: [] });
    assert.equal(clientIpTrusted(env), false);
  }
  // A header name alone, without proxies, must not enable anything.
  assert.deepEqual(clientIpConfig({ TRUSTED_CLIENT_IP_HEADER: "x-real-ip" }), {
    ipAddressHeaders: [],
  });
});
test("a proxy list enables exactly one header, x-forwarded-for by default", () => {
  assert.deepEqual(
    clientIpConfig({ TRUSTED_PROXIES: "10.0.0.0/8, 2001:db8::/32 ,127.0.0.1" }),
    {
      ipAddressHeaders: ["x-forwarded-for"],
      trustedProxies: ["10.0.0.0/8", "2001:db8::/32", "127.0.0.1"],
    },
  );
  assert.deepEqual(
    clientIpConfig({
      TRUSTED_PROXIES: "192.0.2.1",
      TRUSTED_CLIENT_IP_HEADER: " X-Real-IP ",
    }),
    { ipAddressHeaders: ["x-real-ip"], trustedProxies: ["192.0.2.1"] },
  );
});
test("invalid proxy entries or header names fail loudly instead of silently trusting everything", () => {
  for (const bad of [
    "proxy.example.com",
    "10.0.0.0/33",
    "2001:db8::/129",
    "10.0.0.1/abc",
    "10.0.0.1/8/8",
    "999.1.1.1",
    "*",
  ])
    assert.throws(
      () => parseTrustedProxies(`127.0.0.1,${bad}`),
      ClientIpConfigError,
      bad,
    );
  assert.throws(
    () =>
      clientIpConfig({
        TRUSTED_PROXIES: "127.0.0.1",
        TRUSTED_CLIENT_IP_HEADER: "x forwarded\r\nfor",
      }),
    ClientIpConfigError,
  );
  try {
    parseTrustedProxies("secret-host.internal");
  } catch (error) {
    assert.match((error as Error).message, /not an IP address or CIDR/);
  }
});
