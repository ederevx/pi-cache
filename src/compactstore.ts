/**
 * pi-cache — temporary store for soft-compaction captures.
 *
 * One responsibility: persist the entries a soft fast compaction drops
 * (including tool_use/tool_result and subagent output) to an owned,
 * GC'd, agent-readable store, WITHOUT changing the compaction itself —
 * the FAST_COMPACTION_STUB stays byte-identical and nothing new enters
 * the LLM context. The well-known access channel is the store's global
 * LATEST pointer (`~/tmp/pi-cache/compacts/LATEST`), surfaced via the
 * existing pi-cache advisory entry.
 *
 * Three collaborators:
 *  - CompactStorePaths — the owned root and file naming (root, per-session
 *    dirs, `NNNN-<firstKeptEntryId>.jsonl` artifacts, LATEST pointers).
 *    Directories are created 0700 on write; artifacts/LATEST 0600 via
 *    atomically-renamed .tmp files.
 *  - CompactCapture — pure (no I/O) derivation of the compacted span from
 *    the branch entries at proposal time, plus JSONL serialization with a
 *    hard maxBytes cap and an explicit overflow record.
 *  - CompactGC — strict, fail-open pruning confined to the owned root via
 *    a realpath ownership guard: per-session ring (newest N, footer-valid
 *    preferred), global cap, TTL, LATEST reconciliation, empty-dir cleanup.
 *    Never touches anything outside the root.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { FAST_COMPACTION_STUB } from "./softcompact.ts";

/** Minimal structural view of a session branch entry (pi SessionEntry). */
export interface BranchEntryView {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

/** Keep `[A-Za-z0-9_-]`, replace everything else with `_` (safe file names). */
export function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** True only when the path is provably inside `realRoot` (else stderr + false). */
function ensureOwned(p: string, realRoot: string): boolean {
  try {
    const rp = realpathSync(dirname(p));
    return rp === realRoot || rp.startsWith(realRoot + sep);
  } catch {
    console.error(`pi-cache: compact GC skipping unowned path ${p}`);
    return false;
  }
}

export class CompactStorePaths {
  constructor(readonly rootPath: string) {}

  /** The owned root; created 0700 on demand (write path only). */
  root(): string {
    mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    return this.rootPath;
  }

  /** Per-session directory under the root. */
  sessionDir(sessionId: string): string {
    return join(this.rootPath, sanitize(sessionId));
  }

  /** `NNNN-<sanitized firstKeptEntryId>.jsonl` artifact path for a session. */
  artifactPath(sessionId: string, seq: number, firstKeptEntryId: string): string {
    const name = `${String(seq).padStart(4, "0")}-${sanitize(firstKeptEntryId)}.jsonl`;
    return join(this.sessionDir(sessionId), name);
  }

  /** Per-session LATEST pointer file. */
  latestFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), "LATEST");
  }

  /** The well-known global LATEST pointer (the store's access channel). */
  globalLatestFile(): string {
    return join(this.rootPath, "LATEST");
  }

  /** Root-relative artifact reference stored in the global LATEST pointer. */
  artifactRef(sessionId: string, artifactPath: string): string {
    return join(sanitize(sessionId), basename(artifactPath));
  }

  /** Write an artifact atomically (0600) under an owned 0700 path. */
  writeArtifact(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.writeAtomic(path, text);
  }

  /** Write/refresh a LATEST pointer atomically (0600), parent 0700. */
  writeLatest(file: string, sessionId: string, artifact: string): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.writeAtomic(file, `${JSON.stringify({ sessionId, artifact })}\n`);
  }

  /** Parse a LATEST pointer; undefined when missing or corrupt. */
  readLatest(
    file: string,
  ): { sessionId: string; artifact: string } | undefined {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        sessionId?: unknown;
        artifact?: unknown;
      };
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.artifact === "string"
      ) {
        return { sessionId: parsed.sessionId, artifact: parsed.artifact };
      }
    } catch {
      /* missing or corrupt pointer: caller treats it as absent */
    }
    return undefined;
  }

  /** Next artifact sequence for a session: 1 + max existing seq (0 if none). */
  nextSeq(sessionId: string): number {
    let max = 0;
    try {
      for (const name of readdirSync(this.sessionDir(sessionId))) {
        const m = /^(\d+)-/.exec(name);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > max) max = n;
        }
      }
    } catch {
      /* session dir absent or unreadable: start at seq 1 */
    }
    return max + 1;
  }

  private writeAtomic(file: string, data: string): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  }
}

export interface CompactDelta {
  /** Branch entries this compaction actually drops (verbatim capture). */
  entries: BranchEntryView[];
  /** Cut of the previous compaction, when one predates the span. */
  prevFirstKeptEntryId: string | undefined;
  /** Id of the most recent prior compaction stub, when one leaves context. */
  prevStubId: string | undefined;
}

export interface CompactSerializeInput {
  sessionId: string;
  sessionFile?: string | undefined;
  seq: number;
  reason: string;
  tokensBefore: number;
  firstKeptEntryId: string;
  prevFirstKeptEntryId: string | undefined;
  prevStubId: string | undefined;
  entries: readonly BranchEntryView[];
  /** Hard per-artifact cap in bytes; on overflow, trailing entries drop. */
  maxBytes?: number | undefined;
}

export class CompactCapture {
  /**
   * Derive the span this compaction drops from the branch at proposal
   * time. Boundary rule: the span starts at the previous summary's cut
   * (index of previousSummary.firstKeptEntryId in branchEntries, else 0)
   * and ends at the new cut (index of preparation.firstKeptEntryId in
   * branchEntries, exclusive; else the branch end). prevStubId is the
   * most recent "compaction" entry before the start — the stub that
   * leaves context (referenced by id + constant, never duplicated text).
   */
  deriveDelta(
    branchEntries: readonly BranchEntryView[],
    previousSummary: { firstKeptEntryId?: string } | undefined,
    preparation?: { firstKeptEntryId?: string } | undefined,
  ): CompactDelta {
    let start = 0;
    if (previousSummary?.firstKeptEntryId !== undefined) {
      const i = this.indexOf(branchEntries, previousSummary.firstKeptEntryId);
      start = i < 0 ? 0 : i;
    }
    let end = branchEntries.length;
    if (preparation?.firstKeptEntryId !== undefined) {
      const i = this.indexOf(branchEntries, preparation.firstKeptEntryId);
      if (i >= 0) end = i;
    }
    return this.buildSpan(branchEntries, start, end);
  }

  /**
   * Serialize the capture as JSONL: header, one line per dropped entry
   * (verbatim SessionEntry JSON), an optional compaction-ref line for the
   * prior stub, then the footer. Pure: no I/O. When maxBytes is exceeded
   * the trailing entry records are dropped and an explicit overflow
   * record (with droppedEntries + full byte length) replaces the footer.
   */
  serialize(input: CompactSerializeInput): string {
    const header: Record<string, unknown> = {
      v: 1,
      kind: "pi-cache-compact",
      sessionId: input.sessionId,
      seq: input.seq,
      createdAt: new Date().toISOString(),
      reason: input.reason,
      tokensBefore: input.tokensBefore,
      firstKeptEntryId: input.firstKeptEntryId,
      prevFirstKeptEntryId: input.prevFirstKeptEntryId,
      entryCount: input.entries.length,
    };
    if (input.sessionFile !== undefined) {
      header.sessionFile = input.sessionFile;
    }
    const entryRecords: string[] = [];
    for (const entry of input.entries) {
      if (entry.type === "message") {
        entryRecords.push(
          JSON.stringify({
            t: "entry",
            id: entry.id,
            parentId: entry.parentId ?? "",
            ts: entry.timestamp,
            type: "message",
            entry: JSON.stringify(entry),
          }),
        );
      } else {
        entryRecords.push(JSON.stringify({ t: "unknown", raw: JSON.stringify(entry) }));
      }
    }
    const ref = this.refLine(input.prevStubId);
    // Footer bytes = length of every record up to (not incl.) the footer.
    const base = this.assemble([header, ...entryRecords, ref]);
    const full = `${base}${JSON.stringify({ t: "footer", bytes: base.length })}\n`;
    const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
    if (full.length <= maxBytes) return full;
    // Overflow: keep the largest complete prefix of entry records, then
    // append the explicit overflow record (full length = pre-trim bytes).
    const overflow = (dropped: number) =>
      JSON.stringify({ t: "overflow", droppedEntries: dropped, bytes: full.length });
    for (let kept = entryRecords.length; kept > 0; kept--) {
      const candidate = `${this.assemble([header, ...entryRecords.slice(0, kept)])}${overflow(entryRecords.length - kept)}\n`;
      if (candidate.length <= maxBytes) return candidate;
    }
    return `${JSON.stringify(header)}\n${overflow(entryRecords.length)}\n`;
  }

  /** Join records into one trailing-newline JSONL string. */
  assemble(records: (Record<string, unknown> | string | undefined)[]): string {
    const parts: string[] = [];
    for (const record of records) {
      if (record === undefined) continue;
      parts.push(typeof record === "string" ? record : JSON.stringify(record));
    }
    return `${parts.join("\n")}\n`;
  }

  private refLine(prevStubId: string | undefined): string | undefined {
    if (prevStubId === undefined) return undefined;
    return JSON.stringify({ t: "compaction-ref", prevStubId, stub: FAST_COMPACTION_STUB });
  }

  private indexOf(entries: readonly BranchEntryView[], id: string): number {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].id === id) return i;
    }
    return -1;
  }

  /** Slice the span and locate the previous stub (most recent compaction
   *  entry before `start`); its id and cut become the ref/prev fields. */
  private buildSpan(
    entries: readonly BranchEntryView[],
    start: number,
    end: number,
  ): CompactDelta {
    const compacted = entries.slice(Math.max(0, start), Math.max(start, end));
    let prevStubId: string | undefined;
    let prevFirstKeptEntryId: string | undefined;
    for (let i = Math.max(0, start) - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "compaction") continue;
      if (prevStubId === undefined && typeof entry.id === "string") {
        prevStubId = entry.id;
      }
      if (prevFirstKeptEntryId === undefined && typeof entry.firstKeptEntryId === "string") {
        prevFirstKeptEntryId = entry.firstKeptEntryId;
      }
      break;
    }
    return { entries: compacted, prevFirstKeptEntryId, prevStubId };
  }
}

export interface CompactGCOptions {
  /** Per-session ring: keep the newest N artifacts (footer-valid preferred). */
  ring: number;
  /** Global cap: keep the newest maxArtifacts across all sessions. */
  maxArtifacts: number;
  /** TTL: remove artifacts whose mtime is older than this many ms. */
  ttlMs: number;
}

interface ArtifactInfo {
  file: string;
  seq: number;
  mtime: number;
  footerValid: boolean;
}

interface SessionInfo {
  dir: string;
  artifacts: ArtifactInfo[];
}

export class CompactGC {
  constructor(
    private readonly paths: CompactStorePaths,
    private readonly opts: CompactGCOptions,
  ) {}

  /**
   * Strict, fail-open pruning confined to the owned root. Phases: per-
   * session ring (newest `ring`, footer-valid preferred), global cap
   * (newest `maxArtifacts` by mtime), TTL, then LATEST reconciliation
   * and empty-session-dir removal. Every unlink/rmdir passes a realpath
   * ownership guard; anything outside the root is skipped with a stderr
   * note, never deleted.
   */
  prune(): void {
    try {
      const realRoot = this.realRoot();
      if (realRoot === undefined) return;
      const sessions = this.scanSessions(realRoot);
      for (const session of sessions) {
        this.applyRing(session, realRoot);
      }
      this.applyGlobalCap(sessions, realRoot);
      this.applyTtl(sessions, realRoot);
      this.reconcileLatests(sessions, realRoot);
    } catch (error) {
      console.error(
        `pi-cache: compact GC failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private realRoot(): string | undefined {
    try {
      return realpathSync(this.paths.rootPath);
    } catch {
      /* root not created yet: nothing to prune */
      return undefined;
    }
  }

  /** Non-jsonl files (e.g. LATEST) and dirs outside the root are ignored. */
  private scanSessions(realRoot: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.paths.rootPath);
    } catch {
      return sessions;
    }
    for (const name of names) {
      const dir = join(this.paths.rootPath, name);
      try {
        if (!lstatSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!ensureOwned(dir, realRoot)) continue;
      const artifacts: ArtifactInfo[] = [];
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        /* unreadable session dir: skip */
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const p = join(dir, file);
        const seqMatch = /^(\d+)-/.exec(file);
        let mtime = 0;
        let footerValid = false;
        try {
          mtime = lstatSync(p).mtimeMs;
          footerValid = this.hasFooter(p);
        } catch {
          /* vanished mid-scan: garbage, still removed by caps/TTL */
        }
        artifacts.push({
          file: p,
          seq: seqMatch ? parseInt(seqMatch[1], 10) : -1,
          mtime,
          footerValid,
        });
      }
      sessions.push({ dir, artifacts });
    }
    return sessions;
  }

  /** Footer-valid means the last non-empty line parses as a footer record. */
  private hasFooter(file: string): boolean {
    try {
      const raw = readFileSync(file, "utf8").trimEnd();
      const last = raw.substring(raw.lastIndexOf("\n") + 1).trim();
      if (last === "") return false;
      const parsed = JSON.parse(last) as { t?: unknown };
      return parsed.t === "footer";
    } catch {
      return false;
    }
  }

  /** Keep the newest `ring` artifacts per session, footer-valid preferred. */
  private applyRing(session: SessionInfo, realRoot: string): void {
    if (this.opts.ring < 0) return;
    const sorted = [...session.artifacts].sort((a, b) => b.seq - a.seq);
    let kept = sorted.slice(0, this.opts.ring);
    const removed = sorted.slice(this.opts.ring);
    // Promote a removed footer-valid artifact over a kept footer-less one.
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i].footerValid || removed.length === 0) continue;
        const swap = removed.findIndex((r) => r.footerValid);
        if (swap >= 0) {
          const promoted = removed.splice(swap, 1)[0];
          removed.push(kept[i]);
          kept[i] = promoted;
          changed = true;
          break;
        }
      }
    }
    this.deleteMany(removed.map((r) => r.file), realRoot);
  }

  /** Keep the newest `maxArtifacts` artifacts across all sessions by mtime. */
  private applyGlobalCap(sessions: SessionInfo[], realRoot: string): void {
    if (this.opts.maxArtifacts < 0) return;
    const all: ArtifactInfo[] = [];
    for (const session of sessions) all.push(...session.artifacts);
    all.sort((a, b) => b.mtime - a.mtime);
    const keepSet = new Set(all.slice(0, this.opts.maxArtifacts).map((k) => k.file));
    this.deleteMany(
      all.filter((a) => !keepSet.has(a.file)).map((a) => a.file),
      realRoot,
    );
  }

  /** Remove artifacts whose mtime is older than ttlMs (negative TTL = all). */
  private applyTtl(sessions: SessionInfo[], realRoot: string): void {
    if (!Number.isFinite(this.opts.ttlMs)) return;
    const threshold = Date.now() - this.opts.ttlMs;
    const stale: string[] = [];
    for (const session of sessions) {
      for (const artifact of session.artifacts) {
        if (artifact.mtime < threshold) stale.push(artifact.file);
      }
    }
    this.deleteMany(stale, realRoot);
  }

  /** Drop LATEST pointers whose artifact vanished; remove empty session dirs.
   *  The global pointer is reconciled while its session dir still exists so
   *  the strict ownership guard can resolve a real dirname; session dirs
   *  are removed last. A pointer whose target is gone, or escapes the root,
   *  is dropped — the pointer is ours, the stale target is not. */
  private reconcileLatests(sessions: SessionInfo[], realRoot: string): void {
    for (const session of sessions) {
      const latest = join(session.dir, "LATEST");
      const pointer = this.paths.readLatest(latest);
      if (pointer !== undefined) {
        const target = join(session.dir, pointer.artifact);
        if (!existsSync(target) || !ensureOwned(target, realRoot)) {
          this.deleteOne(latest, realRoot);
        }
      }
    }
    const global = this.paths.globalLatestFile();
    const gpointer = this.paths.readLatest(global);
    if (gpointer !== undefined) {
      const target = join(this.paths.rootPath, gpointer.artifact);
      if (!existsSync(target) || !ensureOwned(target, realRoot)) {
        this.deleteOne(global, realRoot);
      }
    }
    for (const session of sessions) {
      try {
        if (readdirSync(session.dir).length === 0 && ensureOwned(session.dir, realRoot)) {
          rmdirSync(session.dir);
        }
      } catch {
        /* unreadable or vanished dir: skip */
      }
    }
  }

  private deleteMany(files: string[], realRoot: string): void {
    for (const file of files) this.deleteOne(file, realRoot);
  }

  private deleteOne(file: string, realRoot: string): void {
    if (!ensureOwned(file, realRoot)) return;
    try {
      unlinkSync(file);
    } catch {
      /* already gone: fine */
    }
  }
}