/**
 * pi-cache — compaction trigger tests.
 * Covers the gate (one compaction per idle window), the awaitable request,
 * the shared trigger, the TTL idle timer, and the before-turn handler.
 */

import { test, assert, assertEq } from "./harness.ts";
import { CompactionGate } from "../src/compaction-gate.ts";
import { CompactionRequest } from "../src/compaction-request.ts";
import { CompactionTrigger } from "../src/compaction-trigger.ts";
import { IdleTrigger } from "../src/idle-trigger.ts";
import { BeforeTurnTrigger } from "../src/before-turn-trigger.ts";

/** Minimal context with a controllable compact callback. */
interface FakeCtx {
  compact?: (options?: {
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }) => void;
  idle?: boolean;
}

/** Deterministic timer scheduler for the idle trigger. */
class FakeTimers {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();
  private readonly delays = new Map<number, number>();
  readonly unrefed = new Set<number>();

  setTimeoutFn = (callback: () => void, delayMs: number): never => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.delays.set(id, delayMs);
    return { id, unref: () => this.unrefed.add(id) } as never;
  };

  clearTimeoutFn = (handle: unknown): void => {
    this.callbacks.delete((handle as { id: number }).id);
  };

  delayOf(id: number): number | undefined {
    return this.delays.get(id);
  }

  ids(): number[] {
    return [...this.callbacks.keys()];
  }

  fire(id: number): void {
    const callback = this.callbacks.get(id);
    this.callbacks.delete(id);
    callback?.();
  }
}

test("gate: one compaction per window and never two at once", () => {
  const gate = new CompactionGate();
  assertEq(gate.tryBegin("k1"), true, "first claim");
  assertEq(gate.tryBegin("k1"), false, "in-flight blocks a second");
  assertEq(gate.tryBegin("k2"), false, "in-flight blocks another window");
  gate.settle("k1");
  assertEq(gate.tryBegin("k1"), false, "the same window is done");
  assertEq(gate.tryBegin("k2"), true, "a new window may proceed");
  gate.reset();
  assertEq(gate.tryBegin("k1"), true, "reset forgets the window");
});

test("request: resolves true on complete and false on failure", async () => {
  let failures = 0;
  const request = new CompactionRequest(() => failures++);
  const ok: FakeCtx = { compact: (o) => o?.onComplete?.({}) };
  assertEq(await request.request(ok), true);
  const bad: FakeCtx = { compact: (o) => o?.onError?.(new Error("no")) };
  assertEq(await request.request(bad), false);
  assertEq(failures, 1, "failure advisory fired");
  const throws: FakeCtx = {
    compact: () => {
      throw new Error("stale ctx");
    },
  };
  assertEq(await request.request(throws), false);
  assertEq(failures, 2, "a throwing compact is a failure");
  assertEq(await request.request({}), false, "no compact hook is a failure");
});

test("trigger: declines, claims, runs, and settles", async () => {
  const gate = new CompactionGate();
  const calls: string[] = [];
  const request = new CompactionRequest();
  let decide = false;
  const trigger = new CompactionTrigger<FakeCtx>({
    shouldCompact: () => decide,
    keyOf: (ctx) => String(ctx.compact === undefined),
    gate,
    request,
  });
  const ctx: FakeCtx = {
    compact: (o) => {
      calls.push("compact");
      o?.onComplete?.({});
    },
  };
  assertEq(await trigger.tryCompact(ctx), false, "declined when decide is false");
  assertEq(calls.length, 0);
  decide = true;
  assertEq(await trigger.tryCompact(ctx), true, "runs when decide is true");
  assertEq(calls.length, 1);
  assertEq(await trigger.tryCompact(ctx), false, "same window is gated");
  assertEq(calls.length, 1);
});

test("idle-trigger: fires at TTL expiry when idle", () => {
  const timers = new FakeTimers();
  const fired: number[] = [];
  const trigger = new IdleTrigger<FakeCtx>({
    enabled: true,
    isIdle: (ctx) => ctx.idle === true,
    idleMs: () => 30_000,
    ttlMs: () => 300_000,
    compact: async () => {
      fired.push(1);
      return true;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const ctx: FakeCtx = { idle: true };
  trigger.arm(ctx);
  assertEq(timers.ids().length, 1, "one timer armed");
  assertEq(timers.delayOf(timers.ids()[0]), 270_000, "fires after the remaining TTL");
  assertEq(timers.unrefed.size, 1, "timer is unref'd");
  timers.fire(timers.ids()[0]);
  assertEq(fired.length, 1, "compaction fired");
});

test("idle-trigger: skips a non-idle or already-expired session", () => {
  const timers = new FakeTimers();
  let fired = 0;
  const trigger = new IdleTrigger<FakeCtx>({
    enabled: true,
    isIdle: (ctx) => ctx.idle === true,
    idleMs: () => 30_000,
    ttlMs: () => 300_000,
    compact: async () => {
      fired++;
      return true;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const busy: FakeCtx = { idle: false };
  trigger.arm(busy);
  const id = timers.ids()[0];
  timers.fire(id);
  assertEq(fired, 0, "not idle: no compaction");
});

test("idle-trigger: disarm clears the timer and disabled never arms", () => {
  const timers = new FakeTimers();
  const trigger = new IdleTrigger<FakeCtx>({
    enabled: true,
    isIdle: () => true,
    idleMs: () => 0,
    ttlMs: () => 10_000,
    compact: async () => true,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  trigger.arm({ idle: true });
  assertEq(trigger.armed, true);
  trigger.disarm();
  assertEq(trigger.armed, false);
  assertEq(timers.ids().length, 0, "timer cleared");
  const off = new IdleTrigger<FakeCtx>({
    enabled: false,
    isIdle: () => true,
    idleMs: () => 0,
    ttlMs: () => 10_000,
    compact: async () => true,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  off.arm({ idle: true });
  assertEq(off.armed, false, "disabled trigger never arms");
  const noUsage = new IdleTrigger<FakeCtx>({
    enabled: true,
    isIdle: () => true,
    idleMs: () => Number.POSITIVE_INFINITY,
    ttlMs: () => 10_000,
    compact: async () => true,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  noUsage.arm({ idle: true });
  assertEq(noUsage.armed, false, "unknown idle time never arms");
});

test("before-turn-trigger: defers only an eligible cold idle prompt", async () => {
  let compactions = 0;
  let disarms = 0;
  let shouldCompact = true;
  const trigger = new BeforeTurnTrigger<
    FakeCtx,
    { streamingBehavior?: string; source?: string }
  >({
    enabled: true,
    eligible: (event) => event.streamingBehavior === undefined && event.source !== "extension",
    shouldCompact: () => shouldCompact,
    compact: async () => {
      compactions++;
      return true;
    },
    disarmIdle: () => disarms++,
  });
  await trigger.handle({ source: "interactive" }, {});
  assertEq(compactions, 1, "idle interactive prompt compacts before continuing");
  assertEq(disarms, 1, "idle timer disarmed");
  await trigger.handle({ source: "interactive", streamingBehavior: "steer" }, {});
  assertEq(compactions, 1, "a steer while streaming is not deferred");
  assertEq(disarms, 2, "an ineligible input still disarms the idle timer");
  await trigger.handle({ source: "extension" }, {});
  assertEq(compactions, 1, "our own re-sent prompt is not intercepted");
  assertEq(disarms, 3, "an extension-source input still disarms the idle timer");
  shouldCompact = false;
  await trigger.handle({ source: "interactive" }, {});
  assertEq(compactions, 1, "a warm prompt is not deferred");
});

test("before-turn-trigger: disarm happens even when disabled", async () => {
  let disarms = 0;
  const trigger = new BeforeTurnTrigger<FakeCtx, { source?: string }>({
    enabled: false,
    eligible: () => true,
    shouldCompact: () => true,
    compact: async () => true,
    disarmIdle: () => disarms++,
  });
  await trigger.handle({ source: "interactive" }, {});
  assertEq(disarms, 1, "a disabled trigger still clears the idle timer on input");
});

test("before-turn-trigger: a failing compaction still lets the prompt through", async () => {
  const trigger = new BeforeTurnTrigger<FakeCtx, { source?: string }>({
    enabled: true,
    eligible: () => true,
    shouldCompact: () => true,
    compact: async () => {
      throw new Error("compaction failed");
    },
    disarmIdle: () => {},
  });
  await trigger.handle({ source: "interactive" }, {});
  assert(true, "handler resolved despite the failure");
});