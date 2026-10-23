import { createHash } from "node:crypto";
import type { Rng } from "./types.js";

/** Domain-separation tag for the deck-shuffle byte stream. Bump on any algorithm change. */
export const DECK_STREAM_TAG = "btcpoker/deck/v1";

/**
 * Deterministic byte stream derived from a committed secret (seed || nonce):
 *
 *   block_i = SHA-256( utf8(DECK_STREAM_TAG) || seed || nonce || uint32be(i) ),  i = 0, 1, 2, ...
 *
 * The seed/nonce themselves come from the CSPRNG (`commit()` with `defaultRng`),
 * so the stream is unpredictable before reveal. After reveal, anyone can
 * re-derive the exact same stream and therefore the exact same Fisher–Yates
 * shuffle — this is what makes a dealt hand verifiable.
 *
 * NOT a general-purpose RNG. Use only for replayable, committed shuffles.
 */
export class SeededStreamRng implements Rng {
  private counter = 0;
  private buffer = new Uint8Array(0);
  private offset = 0;

  constructor(
    private readonly seed: Uint8Array,
    private readonly nonce: Uint8Array,
    private readonly tag: string = DECK_STREAM_TAG,
  ) {
    if (seed.length < 16) throw new RangeError("seed must be at least 16 bytes");
  }

  private refill(): void {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, this.counter++, false);
    const h = createHash("sha256");
    h.update(Buffer.from(this.tag, "utf8"));
    h.update(this.seed);
    h.update(this.nonce);
    h.update(ctr);
    this.buffer = new Uint8Array(h.digest());
    this.offset = 0;
  }

  fill(target: Uint8Array): void {
    for (let i = 0; i < target.length; i++) {
      if (this.offset >= this.buffer.length) this.refill();
      target[i] = this.buffer[this.offset++]!;
    }
  }
}
