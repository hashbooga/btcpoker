import { shuffled, type Rng, defaultRng, SeededStreamRng } from "@btcpoker/rng";
import { standardDeck, type Card } from "./cards.js";

export function shuffledDeck(rng: Rng = defaultRng): Card[] {
  return shuffled(standardDeck(), rng);
}

export function dealHole(
  playerCount: number,
  rng: Rng = defaultRng,
): { holes: Card[][]; remaining: Card[] } {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 10) {
    throw new RangeError("playerCount must be 2..10");
  }
  const deck = shuffledDeck(rng);
  const holes: Card[][] = Array.from({ length: playerCount }, () => []);
  for (let round = 0; round < 2; round++) {
    for (let p = 0; p < playerCount; p++) {
      holes[p]!.push(deck.shift()!);
    }
  }
  return { holes, remaining: deck };
}

/**
 * The verifiable deck for a hand: Fisher–Yates over the standard deck, driven by
 * the deterministic SHA-256 stream of the committed (seed, nonce). Replaying this
 * after the reveal must reproduce the dealt cards exactly.
 */
export function deckFromCommitment(seed: Uint8Array, nonce: Uint8Array): Card[] {
  return shuffled(standardDeck(), new SeededStreamRng(seed, nonce));
}
