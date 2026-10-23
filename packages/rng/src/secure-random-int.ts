import type { Rng } from "./types.js";
import { defaultRng } from "./node-crypto-rng.js";

/**
 * Uniform integer in [0, maxExclusive) via rejection sampling.
 * Avoids modulo bias. maxExclusive must be a positive integer <= 2^32.
 *
 * Pattern aligned with agentcasino-style secureRandomInt.
 */
export function secureRandomInt(
  maxExclusive: number,
  rng: Rng = defaultRng,
): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive must be a positive integer");
  }
  if (maxExclusive > 0x1_0000_0000) {
    throw new RangeError("maxExclusive must be <= 2^32");
  }
  if (maxExclusive === 1) return 0;

  // Largest multiple of maxExclusive that fits in 32 bits
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);

  for (;;) {
    rng.fill(buf);
    const x = view.getUint32(0, false);
    if (x < limit) {
      return x % maxExclusive;
    }
  }
}
