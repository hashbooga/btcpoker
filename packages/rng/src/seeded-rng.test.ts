import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SeededStreamRng } from "./seeded-rng.js";
import { shuffled } from "./fisher-yates.js";
import { commit } from "./commit-reveal.js";

describe("SeededStreamRng", () => {
  it("is deterministic for the same seed/nonce", () => {
    const seed = new Uint8Array(32).fill(1);
    const nonce = new Uint8Array(16).fill(2);
    const a = new Uint8Array(100);
    const b = new Uint8Array(100);
    new SeededStreamRng(seed, nonce).fill(a);
    new SeededStreamRng(seed, nonce).fill(b);
    assert.deepEqual(a, b);
  });

  it("differs for different nonces", () => {
    const seed = new Uint8Array(32).fill(1);
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    new SeededStreamRng(seed, new Uint8Array(16).fill(2)).fill(a);
    new SeededStreamRng(seed, new Uint8Array(16).fill(3)).fill(b);
    assert.notDeepEqual(a, b);
  });

  it("produces replayable shuffles from a commitment", () => {
    const c = commit();
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const s1 = shuffled(deck, new SeededStreamRng(c.seed, c.nonce));
    const s2 = shuffled(deck, new SeededStreamRng(c.seed, c.nonce));
    assert.deepEqual(s1, s2);
    assert.deepEqual([...s1].sort((x, y) => x - y), deck);
  });

  it("rejects short seeds", () => {
    assert.throws(() => new SeededStreamRng(new Uint8Array(8), new Uint8Array(16)));
  });

  it("matches a fixed known-answer vector (cross-implementation check)", () => {
    const out = new Uint8Array(4);
    new SeededStreamRng(new Uint8Array(32), new Uint8Array(16)).fill(out);
    // First 4 bytes of SHA-256("btcpoker/deck/v1" || 0x00*48 || 00000000); pinned so browser verifier stays in sync.
    assert.equal(Buffer.from(out).toString("hex"), KAT);
  });
});

const KAT = "6a3e922e";
