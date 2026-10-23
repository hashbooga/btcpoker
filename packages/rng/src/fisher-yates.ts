import type { Rng } from "./types.js";
import { defaultRng } from "./node-crypto-rng.js";
import { secureRandomInt } from "./secure-random-int.js";

/**
 * In-place Fisher–Yates shuffle using injectable CSPRNG + rejection sampling.
 */
export function shuffleInPlace<T>(items: T[], rng: Rng = defaultRng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1, rng);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/** Returns a new shuffled array; does not mutate input. */
export function shuffled<T>(items: readonly T[], rng: Rng = defaultRng): T[] {
  return shuffleInPlace([...items], rng);
}
