/**
 * pi-cache — calibration fixture repo.
 *
 * One responsibility: materialise a fixture into a throwaway repository,
 * accept the model's rewritten file, and grade it by running that
 * fixture's own test. Grading refuses a run whose test file was touched,
 * so a passing grade cannot come from weakening the check.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Fixture } from "./protocol.ts";

const run = promisify(execFile);

/** What a grade concluded. */
export interface Grade {
  success: boolean;
  detail: string;
}

/** The fenced answer a continuation is expected to produce. */
export function extractAnswer(text: string): string | null {
  const fenced = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (const match of text.matchAll(fenced)) {
    if (match[1] !== undefined) last = match[1];
  }
  if (last !== null) return last;
  // An answer cut off at the output limit has no closing fence; the code it
  // did manage to send is still graded, and the observation records the cut.
  const open = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*)$/.exec(text);
  return open?.[1] ?? null;
}

/** One fixture in a scratch repository. */
export class FixtureRepo {
  private readonly root: string;
  private readonly fixture: Fixture;
  private readonly testHash: string;

  private constructor(root: string, fixture: Fixture, testHash: string) {
    this.root = root;
    this.fixture = fixture;
    this.testHash = testHash;
  }

  /** Create the scratch repo for one cell; the root is returned for cleanup. */
  static async materialise(
    fixture: Fixture,
    label: string,
    base: string = join(homedir(), "tmp", "pi-cache-calibration"),
  ): Promise<FixtureRepo> {
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, `${label}-`));
    const testPath = join(root, "test", `${fixture.id}.test.js`);
    await mkdir(dirname(join(root, fixture.file)), { recursive: true });
    await mkdir(dirname(testPath), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: fixture.id, private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(root, fixture.file), fixture.broken, "utf8");
    await writeFile(testPath, fixture.test, "utf8");
    const testHash = createHash("sha256").update(fixture.test).digest("hex");
    return new FixtureRepo(root, fixture, testHash);
  }

  /** Where the scratch repo lives. */
  get path(): string {
    return this.root;
  }

  /** Run the fixture's test file; the pre-fix source must fail it. */
  async grade(): Promise<Grade> {
    const testPath = join(this.root, "test", `${this.fixture.id}.test.js`);
    if ((await this.testDigest(testPath)) !== this.testHash) {
      return { success: false, detail: "test file modified — grade refused" };
    }
    let passed = false;
    let detail = "";
    try {
      await run("node", ["--test", `test/${this.fixture.id}.test.js`], {
        cwd: this.root,
        timeout: 60000,
      });
      passed = true;
      detail = "test passed";
    } catch (error) {
      const out = error instanceof Error ? error.message : String(error);
      detail = out.split("\n").slice(0, 3).join(" / ");
    }
    // Generated code runs inside the test process, so the invariant has to be
    // rechecked after it: a test weakened during the run passed nothing.
    if ((await this.testDigest(testPath)) !== this.testHash) {
      return { success: false, detail: "test file modified during the run — grade refused" };
    }
    return { success: passed, detail };
  }

  /** The test file's digest, or a marker when the run removed it. */
  private async testDigest(path: string): Promise<string> {
    try {
      return createHash("sha256").update(await readFile(path, "utf8")).digest("hex");
    } catch {
      return "missing";
    }
  }

  /** Write the model's answer into the repo, or report why it cannot. */
  async apply(answer: string | null): Promise<Grade | null> {
    if (answer === null || answer.trim().length === 0) {
      return { success: false, detail: "no fenced code block in the answer" };
    }
    await writeFile(resolve(this.root, this.fixture.file), answer, "utf8");
    return null;
  }
}
