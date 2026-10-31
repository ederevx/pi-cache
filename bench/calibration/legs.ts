/**
 * pi-cache — calibration legs.
 *
 * One responsibility: given a fixture and its history, produce the exact
 * message list each leg sends. The full leg sends the whole history; the
 * digest leg replaces the span pi-cache would drop with the digest that
 * span produces, keeping the same tail. The only difference between the
 * legs is that replacement.
 */

import { SpanDigest } from "../../src/digest.ts";
import type { CalMessage } from "./history.ts";
import type { Leg } from "./protocol.ts";

/** The line that introduces a digest in place of a dropped span. */
export const DIGEST_PREAMBLE =
  "Earlier history was compacted by pi-cache. This digest is all that remains of it.";

/** Builds and sends the two legs of a paired comparison. */
export class LegBuilder {
  private readonly digest: SpanDigest;

  constructor(digest: SpanDigest = new SpanDigest()) {
    this.digest = digest;
  }

  /** The digest text a dropped span produces, markers included. */
  digestText(messages: readonly CalMessage[], fileOps: {
    read: Set<string>;
    edited: Set<string>;
    written: Set<string>;
  }): string {
    return this.digest.compose(undefined, this.digest.build(messages, [], fileOps));
  }

  /** The messages for one leg. */
  leg(
    history: { dropped: CalMessage[]; tail: CalMessage[]; full: CalMessage[]; fileOps: {
      read: Set<string>;
      edited: Set<string>;
      written: Set<string>;
    } },
    leg: Leg,
  ): CalMessage[] {
    if (leg === "full") return history.full;
    const text = this.digestText(history.dropped, history.fileOps);
    return [
      {
        role: "user",
        content: [{ type: "text", text: `${DIGEST_PREAMBLE}\n\n${text}` }],
      },
      ...history.tail,
    ];
  }
}
