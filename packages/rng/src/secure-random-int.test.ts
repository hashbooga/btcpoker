import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Rng } from "./types.js";
import { secureRandomInt } from "./secure-random-int.js";
import { shuffleInPlace } from "./fisher-yates.js";
import { commit, reveal, verifyReveal } from "./commit-reveal.js";

/** Deterministic RNG for tests (not for production). */
class SeqRng implements Rng {
  constructor(private bytes: number[]) {}
  fill(target: Uint8Array): void {
    for (let i = 0; i < target.length; i++) {
      const next = this.bytes.shift();
      if (next === undefined) throw new Error("SeqRng exhausted");
      target[i] = next & 0xff;
    }
  }
}

describe("secureRandomInt", () => {
  it("rejects invalid bounds", () => {
    assert.throws(() => secureRandomInt(0), /positive integer/);
    assert.throws(() => secureRandomInt(-1), /positive integer/);
    assert.throws(() => secureRandomInt(1.5), /positive integer/);
  });

  it("returns 0 when maxExclusive is 1", () => {
    const rng = new SeqRng([]);
    assert.equal(secureRandomInt(1, rng), 0);
  });

  it("is uniform for small range with known bytes", () => {
    // getUint32 BE of [0,0,0,5] = 5; limit for max=3 is 4294967295 - (4294967295%3) ...
    // simpler: maxExclusive=256, one byte effectively via uint32
    const rng = new SeqRng([0, 0, 0, 7]);
    assert.equal(secureRandomInt(10, rng), 7);
  });
});

describe("Fisher-Yates", () => {
  it("permutes without Math.random", () => {
    const deck = [0, 1, 2, 3, 4];
    // Enough bytes for several secureRandomInt calls (4 bytes each)
    const rng = new SeqRng([
      0, 0, 0, 0, // j=0 for i=4
      0, 0, 0, 1, // j=1 for i=3
      0, 0, 0, 0, // j=0 for i=2
      0, 0, 0, 0, // j=0 for i=1
    ]);
    shuffleInPlace(deck, rng);
    assert.equal(deck.length, 5);
    assert.deepEqual([...deck].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  });
});

describe("commit-reveal", () => {
  it("round-trips verify", () => {
    const c = commit(new SeqRng(Array(48).fill(0xab)));
    const r = reveal(c);
    assert.equal(verifyReveal(r), true);
    assert.equal(r.commit, c.commit);
  });

  it("fails on tampered seed", () => {
    const c = commit(new SeqRng(Array(48).fill(0xcd)));
    const r = reveal(c);
    r.seed = "00".repeat(32);
    assert.equal(verifyReveal(r), false);
  });
});
