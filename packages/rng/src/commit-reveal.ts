import { createHash } from "node:crypto";
import type { Rng } from "./types.js";
import { defaultRng } from "./node-crypto-rng.js";
import type { CommitRevealCommitment, CommitRevealReveal } from "./types.js";

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function sha256Hex(parts: Uint8Array[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/**
 * Provably-fair commit–reveal (pokerproof-style sketch).
 * Dealer commits to H(seed || nonce) before the hand; reveals seed+nonce after.
 */
export function commit(rng: Rng = defaultRng, seedLen = 32, nonceLen = 16): CommitRevealCommitment {
  const seed = new Uint8Array(seedLen);
  const nonce = new Uint8Array(nonceLen);
  rng.fill(seed);
  rng.fill(nonce);
  const commitHash = sha256Hex([seed, nonce]);
  return { commit: commitHash, seed, nonce };
}

export function reveal(c: CommitRevealCommitment): CommitRevealReveal {
  return {
    seed: toHex(c.seed),
    nonce: toHex(c.nonce),
    commit: c.commit,
  };
}

export function verifyReveal(revealed: CommitRevealReveal): boolean {
  const seed = fromHex(revealed.seed);
  const nonce = fromHex(revealed.nonce);
  return sha256Hex([seed, nonce]) === revealed.commit.toLowerCase();
}

/** Decode a published reveal back into raw seed/nonce bytes (for replaying a shuffle). */
export function revealBytes(revealed: CommitRevealReveal): { seed: Uint8Array; nonce: Uint8Array } {
  return { seed: fromHex(revealed.seed), nonce: fromHex(revealed.nonce) };
}
