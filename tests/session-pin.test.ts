/**
 * pi-cache — session pinner tests.
 * The pinner must derive a stable x-session-id from the request prefix
 * head, inject it only when no session header exists yet, and never
 * contaminate the next request.
 */

import { test, assert, assertEq, assertMatches } from "./harness.ts";
import { SessionPinner } from "../src/session-pin.ts";

function payload(model = "m", tools: unknown[] = []) {
  return { model, messages: [{ role: "system", content: "sys" }], tools };
}

test("pin: injects a stable derived id", () => {
  const pin = new SessionPinner();
  pin.propose(payload());
  const headers: Record<string, string> = {};
  pin.apply(headers);
  assertMatches(headers["x-session-id"] ?? "", /^pi-cache-[0-9a-f]{24}$/);
});

test("pin: identical prefixes produce identical ids", () => {
  const pin = new SessionPinner();
  pin.propose(payload("m", [{ name: "a" }]));
  const h1: Record<string, string> = {};
  pin.apply(h1);
  pin.propose(payload("m", [{ name: "a" }]));
  const h2: Record<string, string> = {};
  pin.apply(h2);
  assertEq(h1["x-session-id"], h2["x-session-id"]);
});

test("pin: different prefixes produce different ids", () => {
  const pin = new SessionPinner();
  pin.propose(payload("m"));
  const h1: Record<string, string> = {};
  pin.apply(h1);
  pin.propose(payload("other-model"));
  const h2: Record<string, string> = {};
  pin.apply(h2);
  assert(h1["x-session-id"] !== h2["x-session-id"], "ids differ");
});

test("pin: existing session header is never overwritten", () => {
  const pin = new SessionPinner();
  pin.propose(payload());
  const headers = { session_id: "provider-owned" };
  pin.apply(headers);
  assertEq(headers["session_id"], "provider-owned");
  assertEq(headers["x-session-id"], undefined);
});

test("pin: case-insensitive session key also blocks injection", () => {
  const pin = new SessionPinner();
  pin.propose(payload());
  const headers = { "X-Session-Id": "owned" };
  pin.apply(headers);
  assertEq(headers["x-session-id"], undefined);
});

test("pin: unreadable proposal clears the pending id", () => {
  const pin = new SessionPinner();
  pin.propose(null);
  const headers: Record<string, string> = {};
  pin.apply(headers);
  assertEq(headers["x-session-id"], undefined);
  pin.apply(headers); // and a second apply in the same turn is a no-op too
  assertEq(headers["x-session-id"], undefined);
});

test("pin: proposal is per-request (consumed by apply)", () => {
  const pin = new SessionPinner();
  pin.propose(payload());
  const first: Record<string, string> = {};
  pin.apply(first);
  const second: Record<string, string> = {};
  pin.apply(second); // pending already consumed
  assert(first["x-session-id"] !== undefined, "first apply injects");
  assert(second["x-session-id"] === undefined, "second apply injects nothing");
});