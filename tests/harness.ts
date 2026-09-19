/**
 * pi-cache — minimal zero-dependency test harness.
 *
 * One responsibility: register named tests, run them sequentially, report
 * pass/fail with a non-zero exit on failure, and own the per-run scratch
 * root (always under ~/tmp per the machine's shared rules — never /tmp).
 * No module-global mutable state outside this registry object.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type TestFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
}

class TestRegistry {
  private readonly cases: TestCase[] = [];
  private passed = 0;
  private readonly failures: string[] = [];

  register(name: string, fn: TestFn): void {
    this.cases.push({ name, fn });
  }

  async runAll(): Promise<void> {
    for (const testCase of this.cases) {
      const started = Date.now();
      try {
        await testCase.fn();
        this.passed++;
        console.log(`  ok   ${testCase.name} (${Date.now() - started}ms)`);
      } catch (error) {
        this.failures.push(testCase.name);
        console.error(`  FAIL ${testCase.name}`);
        console.error(
          `       ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        );
      }
    }
    const total = this.cases.length;
    console.log(`\n${this.passed}/${total} passed`);
    if (this.failures.length > 0) {
      console.error(`Failed: ${this.failures.join(", ")}`);
    }
  }

  get failed(): number {
    return this.failures.length;
  }
}

export const registry = new TestRegistry();

/** Register one test case. */
export function test(name: string, fn: TestFn): void {
  registry.register(name, fn);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEq<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message ?? "assertEq"} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertDeepEq(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message ?? "assertDeepEq"} — expected ${b}, got ${a}`);
  }
}

export function assertThrows(fn: () => unknown, message?: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${message ?? "assertThrows"} — expected an exception`);
}

export function assertMatches(actual: string, pattern: RegExp, message?: string): void {
  if (!pattern.test(actual)) {
    throw new Error(`${message ?? "assertMatches"} — ${JSON.stringify(actual)} !~ ${pattern}`);
  }
}

/** Dry-run a value through a JSON round-trip to prove it is parseable. */
export function assertJsonLine(line: string): Record<string, unknown> {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`assertJsonLine — not an object: ${line}`);
  }
  return parsed;
}

/** One scratch root for the whole run, under ~/tmp (never /tmp). */
let scratchRoot: string | undefined;

export function scratchDir(): string {
  if (scratchRoot === undefined) {
    scratchRoot = mkdtempSync(join(homedir(), "tmp", "pi-cache-tests-"));
  }
  return scratchRoot;
}

/** Remove the run's scratch root. */
export function cleanupScratch(): void {
  if (scratchRoot !== undefined) {
    rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  }
}

/** Poll until `predicate` returns true (bounded, for async persistence). */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout: ${message}`);
}