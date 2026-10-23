/**
 * In-browser, server-independent verification of a finished hand.
 * Re-implements (in plain TS) exactly what @btcpoker/rng + poker-core do:
 *   commit = SHA-256(seed || nonce)
 *   stream = SHA-256("btcpoker/deck/v1" || seed || nonce || u32be(counter)) blocks
 *   deck   = Fisher–Yates(standard deck) using rejection-sampled uint32s from the stream
 *   deal   = holes one at a time from left of the button (2 passes), burn, flop, burn, turn, burn, river
 */
import type { HandRecord } from "./types.js";

// ---- minimal SHA-256 (FIPS 180-4) ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padLen = (((data.length + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(padLen);
  buf.set(data);
  buf[data.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]!, false);
  return out;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const TAG = new TextEncoder().encode("btcpoker/deck/v1");

export function deckFromSeed(seed: Uint8Array, nonce: Uint8Array): string[] {
  let counter = 0, off = 0;
  let buf: Uint8Array = new Uint8Array(0);
  const byte = () => {
    if (off >= buf.length) {
      const ctr = new Uint8Array(4);
      new DataView(ctr.buffer).setUint32(0, counter++, false);
      buf = sha256(concat(TAG, seed, nonce, ctr));
      off = 0;
    }
    return buf[off++]!;
  };
  const randInt = (n: number) => {
    if (n === 1) return 0;
    const limit = 0x100000000 - (0x100000000 % n);
    for (;;) {
      const x = ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
      if (x < limit) return x % n;
    }
  };
  const deck: string[] = [];
  for (const r of "23456789TJQKA") for (const s of "cdhs") deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = deck[i]!; deck[i] = deck[j]!; deck[j] = t;
  }
  return deck;
}

export type Check = { name: string; ok: boolean };

export function verifyInBrowser(rec: HandRecord): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const seed = unhex(rec.reveal.seed), nonce = unhex(rec.reveal.nonce);
  checks.push({ name: "SHA-256(seed‖nonce) equals the commitment published before the deal", ok: hex(sha256(concat(seed, nonce))) === rec.commit && rec.reveal.commit === rec.commit });
  const deck = deckFromSeed(seed, nonce);
  checks.push({ name: "Deck re-shuffled from the revealed seed matches the server's deck", ok: deck.join() === rec.deck.join() });
  const order = rec.dealOrderSeats;
  let i = 0;
  const holes = new Map<number, string[]>();
  for (let r = 0; r < 2; r++) for (const s of order) holes.set(s, [...(holes.get(s) ?? []), deck[i++]!]);
  i++;
  const board = [deck[i]!, deck[i + 1]!, deck[i + 2]!, deck[i + 4]!, deck[i + 6]!];
  checks.push({ name: "Every player's hole cards follow from the committed deck", ok: order.every((s) => (holes.get(s) ?? []).join() === (rec.holes[String(s)] ?? []).join()) });
  checks.push({ name: "Board cards follow from the committed deck", ok: board.slice(0, rec.board.length).join() === rec.board.join() });
  return { ok: checks.every((c) => c.ok), checks };
}
