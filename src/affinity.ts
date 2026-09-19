/**
 * pi-cache — session-affinity observer.
 *
 * One responsibility: watch the provider-request headers for the
 * session-affinity token (x-session-id / session_id) and report whether
 * it stays stable across requests within a pi process. OpenRouter keys
 * sticky routing to a stable identity hash AND a stable session id;
 * a rotating value silently cold-caches the provider KV — the single
 * most expensive churn class a client can emit. Observational only.
 */

export class AffinityObserver {
  private lastId: string | undefined;
  private changes: number = 0;
  private seenRequests: number = 0;

  /** Record one request's headers; extracts the first session-affinity key. */
  note(headers: Record<string, string>): void {
    this.seenRequests++;
    if (!headers || typeof headers !== "object") return;
    const key = Object.keys(headers).find((k) => /session/i.test(k));
    if (!key) return;
    const value = headers[key];
    if (this.lastId === undefined) {
      this.lastId = value;
    } else if (value !== this.lastId) {
      this.changes++;
      this.lastId = value;
    }
  }

  /** Whether the session-affinity header rotated at least once. */
  rotated(): boolean {
    return this.changes > 0;
  }

  /** One-line status for /cache-stats. */
  status(): string {
    if (this.seenRequests === 0) return "affinity n/a";
    const id = this.lastId ?? "absent";
    return `affinity ${this.changes > 0 ? `changed ${this.changes}x` : "stable"} (${id === "absent" ? "no header" : "id set"})`;
  }
}