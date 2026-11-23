/**
 * pi-cache — settings reconciliation tests.
 *
 * The rule: at most one packages entry may install this package, and the
 * pin matching the installed version wins. An entry names this checkout by
 * a path whose *canonical* form is the repository root, whatever the entry
 * is spelled as, so the comparison takes its resolver as a seam: a case
 * writes down what two spellings mean instead of creating an alias on the
 * host.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { test, assert, assertEq, assertDeepEq, scratchDir } from "./harness.ts";
import { SettingsReconciler } from "../scripts/settings-reconciler.mjs";

const REPO = "/checkouts/pi-cache";

/** A settings file in this run's scratch root, holding `packages`. */
function settingsWith(packages: unknown[]): string {
  const dir = join(scratchDir(), `settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ packages }, null, 2) + "\n");
  return path;
}

/** A resolver that answers for the paths a case names, else rejects. */
function resolverFor(answers: Record<string, string>) {
  return (value: string): string => {
    const answer = answers[value];
    if (answer === undefined) throw new Error(`ENOENT: ${value}`);
    return answer;
  };
}

test("reconciler: an entry that resolves to this checkout installs the package", () => {
  const reconciler = new SettingsReconciler(
    settingsWith([]), "0.19.0", "pi-cache", REPO,
    resolverFor({ [REPO]: REPO, "/checkouts/worktree-of-pi-cache": REPO }),
  );
  assertEq(reconciler.installsPackage("/checkouts/worktree-of-pi-cache"), true,
    "one canonical root under another directory name installs the package");
  assertEq(reconciler.installsPackage(REPO), true, "the root itself installs the package");
});

test("reconciler: an entry that resolves elsewhere does not install the package", () => {
  const reconciler = new SettingsReconciler(
    settingsWith([]), "0.19.0", "pi-cache", REPO,
    resolverFor({ [REPO]: REPO, "/checkouts/other-package": "/checkouts/other-package" }),
  );
  assertEq(reconciler.installsPackage("/checkouts/other-package"), false,
    "a different canonical path is a different package");
});

test("reconciler: the package directory name installs the package wherever it is", () => {
  const reconciler = new SettingsReconciler(
    settingsWith([]), "0.19.0", "pi-cache", REPO,
    resolverFor({ [REPO]: REPO, "/somewhere/pi-cache": "/somewhere/pi-cache" }),
  );
  assertEq(reconciler.installsPackage("/somewhere/pi-cache"), true,
    "the package's own directory name is the package");
  assertEq(reconciler.installsPackage("/somewhere/pi-cache/"), true,
    "a trailing separator does not change that");
});

test("reconciler: pins, unknown entries, and an unknown root", () => {
  const reconciler = new SettingsReconciler(
    settingsWith([]), "0.19.0", "pi-cache", REPO, resolverFor({ [REPO]: REPO }),
  );
  assertEq(reconciler.installsPackage("git:github.com/ederevx/pi-cache@v0.19.0"), true,
    "a pin for this package installs it");
  assertEq(reconciler.installsPackage("git:github.com/ederevx/pi-consult@v0.26.7"), false,
    "another package's pin does not");
  assertEq(reconciler.installsPackage(42), false, "a non-string entry is not an entry");
  assertEq(reconciler.installsPackage(null), false, "and neither is null");
  const rootless = new SettingsReconciler(
    settingsWith([]), "0.19.0", "pi-cache", "", resolverFor({}),
  );
  assertEq(rootless.installsPackage("/checkouts/unnamed"), false,
    "without a root no path can be compared to it");
});

test("reconciler: an unresolvable entry is compared as given", () => {
  const reconciler = new SettingsReconciler(
    settingsWith([]), "0.19.0", "pi-cache", REPO,
    // Both the root and the entry are unresolvable: the comparison falls
    // back to the given spelling instead of throwing.
    () => { throw new Error("ENOENT"); },
  );
  assertEq(reconciler.installsPackage("/checkouts/pi-cache"), true,
    "the package name still decides an unresolvable entry");
});

test("reconciler: reconcile keeps the matching pin and drops the alias", () => {
  const alias = "/checkouts/worktree-alias";
  const path = settingsWith([
    "git:github.com/ederevx/pi-cache@v0.19.0",
    alias,
    "git:github.com/ederevx/pi-consult@v0.26.7",
  ]);
  const reconciler = new SettingsReconciler(
    path, "0.19.0", "pi-cache", REPO,
    resolverFor({ [REPO]: REPO, [alias]: REPO }),
  );
  assertDeepEq(reconciler.reconcile(), [alias], "the alias entry is the one dropped");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { packages: string[] };
  assertDeepEq(saved.packages, [
    "git:github.com/ederevx/pi-cache@v0.19.0",
    "git:github.com/ederevx/pi-consult@v0.26.7",
  ], "the installed version's pin stays and another package is untouched");
});

test("reconciler: one installing entry needs no change", () => {
  const path = settingsWith(["git:github.com/ederevx/pi-cache@v0.19.0"]);
  const before = readFileSync(path, "utf8");
  const reconciler = new SettingsReconciler(
    path, "0.19.0", "pi-cache", REPO, resolverFor({ [REPO]: REPO }),
  );
  assertDeepEq(reconciler.reconcile(), [], "a single pin is left alone");
  assertEq(readFileSync(path, "utf8"), before, "and the settings file is not rewritten");
  assert(reconciler.reconcile().length === 0, "the rule is idempotent");
});
