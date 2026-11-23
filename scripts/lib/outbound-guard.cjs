// Preloaded into a DISPOSABLE browser-test server with `node --require` (scripts/e2e-ci.ts sets NODE_OPTIONS for it).
//
// It makes "nothing left this computer" something a test run can show instead of assume: every outbound fetch and every socket
// connection to a host that is not this computer is REFUSED, and recorded in OUTBOUND_GUARD_LOG as one JSON line holding the
// kind of call, the process id and the host name. Nothing else is recorded: no path, query, header, body or address of a person,
// so the log can never hold a code, a link or a token. Loopback (127.0.0.0/8, ::1, localhost) and local pipes are untouched, so
// the database and the server itself work as usual.
//
// It never ships in the application and is never loaded outside the browser-test launcher.
"use strict";

const fs = require("node:fs");
const net = require("node:net");

const logFile = process.env.OUTBOUND_GUARD_LOG;

function isLocal(host) {
  if (!host) return true;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "::" || h === "0.0.0.0" || /^127\./.test(h);
}

function note(kind, host) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, host: String(host) }) + "\n");
  } catch {
    // The guard must never be the reason the server stops.
  }
}

const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function guardedFetch(input, init) {
    let host = "(unreadable)";
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      host = new URL(raw).hostname;
    } catch {
      // A relative or malformed address cannot leave the computer either; let fetch reject it as usual.
      return realFetch.call(this, input, init);
    }
    if (!isLocal(host)) {
      note("fetch-blocked", host);
      return Promise.reject(new TypeError("Outbound request refused by the browser-test guard."));
    }
    return realFetch.call(this, input, init);
  };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  try {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    let host;
    if (first && typeof first === "object") host = first.path ? undefined : first.host;
    else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) host = typeof args[1] === "string" ? args[1] : undefined;
    if (!isLocal(host)) {
      note("connect-blocked", host);
      const error = new Error("Outbound connection refused by the browser-test guard.");
      error.code = "EOUTBOUNDREFUSED";
      process.nextTick(() => this.destroy(error));
      return this;
    }
  } catch {
    // Fall through to the real connect on anything unexpected rather than break the server.
  }
  return realConnect.apply(this, args);
};
