/**
 * pi-cache — /cache-stats presenter.
 *
 * One responsibility: render the global and session cache scopes plus the
 * live session signals (compaction pressure, churn, compaction counts)
 * into the two-line /cache-stats text. Owns no state; the caller
 * gathers the numbers from their owners and the ledger/pressure classes
 * remain the single source of each value.
 */

export interface CacheStatsScope {
  n: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The last pressure sample: raw pressure and its Bernoulli probability. */
export interface CacheStatsPressure {
  pressure: number;
  probability: number;
}

export interface CacheStatsInput {
  global: CacheStatsScope;
  session: CacheStatsScope;
  churn: number;
  compactions: number;
  fastCompactions: number;
  fastEnabled: boolean;
  branchEnabled: boolean;
  /** Present only when the session had a usable context sample. */
  pressure?: CacheStatsPressure;
  /** Miss-type diagnosis for the session, when any miss was observed. */
  misses?: CacheStatsMisses;
}

/** Miss-type counts from the miss classifier (named categories only; the
 *  residual full-miss bucket is reported by the advisory path). */
export interface CacheStatsMisses {
  coldStart: number;
  idleExpiry: number;
  replicaFlap: number;
  partialMiss: number;
}

export class CacheStatsPresenter {
  render(input: CacheStatsInput): string {
    return [
      this.scopeLine("global", input.global),
      this.scopeLine("session", input.session) + this.sessionSignals(input),
    ].join("\n");
  }

  /** One usage line in the ledger's established wording. */
  private scopeLine(scope: "global" | "session", s: CacheStatsScope): string {
    if (s.n === 0) return `pi-cache ${scope}: no usage recorded yet`;
    const denom = s.input + s.cacheRead;
    const ratio = denom > 0 ? s.cacheRead / denom : 0;
    return (
      `pi-cache ${scope}: ${s.n} req, ` +
      `read ${s.cacheRead.toLocaleString()} / in ${s.input.toLocaleString()} ` +
      `(${(ratio * 100).toFixed(1)}%), writes ${s.cacheWrite.toLocaleString()}`
    );
  }

  /** Live session signals appended to the session usage line. */
  private sessionSignals(input: CacheStatsInput): string {
    const signals: string[] = [];
    if (input.pressure) {
      signals.push(
        `pressure ${input.pressure.pressure.toFixed(2)} ` +
          `(p ${(input.pressure.probability * 100).toFixed(0)}%)`,
      );
    }
    if (input.churn > 0) signals.push(`head churn ${input.churn}`);
    const misses = input.misses ? this.missSignal(input.misses) : undefined;
    if (misses) signals.push(misses);
    signals.push(
      `compactions ${input.compactions} ` +
        `(fast ${input.fastCompactions}, compaction ${input.fastEnabled ? "on" : "off"}, ` +
        `branch ${input.branchEnabled ? "on" : "off"})`,
    );
    return ", " + signals.join(", ");
  }

  /** One miss-type signal, naming only the observed categories. */
  private missSignal(m: CacheStatsMisses): string | undefined {
    const parts: string[] = [];
    if (m.coldStart > 0) parts.push(`cold-start ${m.coldStart}`);
    if (m.idleExpiry > 0) parts.push(`idle-expiry ${m.idleExpiry}`);
    if (m.replicaFlap > 0) parts.push(`replica-flap ${m.replicaFlap}`);
    if (m.partialMiss > 0) parts.push(`partial ${m.partialMiss}`);
    return parts.length > 0 ? `misses ${parts.join(", ")}` : undefined;
  }
}
