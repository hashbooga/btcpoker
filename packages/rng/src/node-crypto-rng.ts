import { randomFillSync } from "node:crypto";
import type { Rng } from "./types.js";

/**
 * Default production RNG: Node `crypto.randomFillSync` (CSPRNG).
 * Do not substitute Math.random or insecure PRNGs.
 */
export class NodeCryptoRng implements Rng {
  fill(target: Uint8Array): void {
    randomFillSync(target);
  }
}

export const defaultRng: Rng = new NodeCryptoRng();
