/**
 * Injectable entropy source. Implementations must be cryptographically secure
 * for production dealing. Never use Math.random.
 */
export interface Rng {
  /** Fill `target` with cryptographically secure random bytes. */
  fill(target: Uint8Array): void;
}

export type CommitRevealCommitment = {
  /** Hex-encoded SHA-256 of `seed || nonce`. */
  commit: string;
  /** Opaque handle; reveal returns the preimage parts. */
  seed: Uint8Array;
  nonce: Uint8Array;
};

export type CommitRevealReveal = {
  seed: string;
  nonce: string;
  commit: string;
};
