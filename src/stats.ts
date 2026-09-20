/**
 * pi-cache — /cache-stats presenter.
 *
 * One responsibility: render the global and session cache scopes plus the
 * live session signals (compaction pressure, churn, affinity, compaction
 * counts) into the two-line /cache-stats text. Owns no state; the caller
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
  affinity: string;
  compactions: number;
  fastCompactions: number;
  fastEnabled: boolean;
  /** Present only when the session had a usable context sample. */
  pressure?: CacheStatsPressure;
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
    signals.push(input.affinity);
    signals.push(
      `compactions ${input.compactions} ` +
        `(fast ${input.fastCompactions}, fast ${input.fastEnabled ? "on" : "off"})`,
    );
    return ", " + signals.join(", ");
  }
}
