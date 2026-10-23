# RNG design (btcpoker)

Highest-priority module: an **auditable, open-source CSPRNG** for dealing cards.

## Hard rules

- **Never** use `Math.random` (or any non-crypto PRNG) for dealing, seat assignment, or fairness-sensitive picks.
- Production entropy comes from `crypto.randomFillSync` via `NodeCryptoRng` (injectable `Rng` interface).
- Uniform integers use **rejection sampling** (`secureRandomInt`) to avoid modulo bias.
- Deck order uses **Fisher–Yates** driven by `secureRandomInt`.

## Injectable RNG

```ts
interface Rng {
  fill(target: Uint8Array): void;
}
```

Tests inject a deterministic `Rng`. Production uses `defaultRng` (`NodeCryptoRng`).

## Commit–reveal (provably fair sketch)

1. Before the hand: `commit()` → publish `commit = SHA-256(seed || nonce)`.
2. After the hand: `reveal()` → publish `seed` and `nonce`.
3. Anyone: `verifyReveal()` recomputes the hash.

This is a dealer-side commitment (pokerproof-inspired). Multi-party or threshold schemes can wrap the same `Rng` later.

### Binding the shuffle to the commitment

A commitment only helps if the deck is a deterministic function of the committed secret. The game server therefore:

1. calls `commit()` with the production CSPRNG (`defaultRng`), producing a fresh 32-byte `seed` and 16-byte `nonce`, and publishes `commit` to all players **before** dealing;
2. builds the deck with `deckFromCommitment(seed, nonce)` (in `@btcpoker/poker-core`), which is
   `shuffled(standardDeck(), new SeededStreamRng(seed, nonce))`;
3. `SeededStreamRng` emits the byte stream `SHA-256("btcpoker/deck/v1" || seed || nonce || uint32be(i))` for `i = 0, 1, 2, …`. `secureRandomInt` rejection-samples from it, and Fisher–Yates consumes those draws exactly as in production;
4. deals in a fixed, documented order (`dealOrder`), so the hole and board cards are a pure function of the deck;
5. publishes `reveal()` and the full hand record when the hand ends.

The standard deck order is rank-major: `2c 2d 2h 2s 3c … As`. A known-answer test pins the stream (`seeded-rng.test.ts`), and the server's integration test checks that the browser's independent pure-JS verifier agrees with the Node implementation.

Verifiers: `verifyHandRecord()` (server, `GET /api/tables/:id/hands/:n/verify`), `npm run verify-hand -- <url|file>` (CLI), and the in-browser **Fairness → Verify** button (it recomputes everything client-side).

**Caveats:** the dealer still knows the deck during the hand and picks the seed alone. Commit–reveal stops it from changing the deck *after* the commitment, but it doesn't keep the cards hidden from the dealer. Adding player-contributed entropy or mental-poker protocols are possible next steps.

## Prior art reviewed

- agentcasino — `secureRandomInt`-style API
- pavelnikolov/deck — deck shuffle patterns
- pairjacks/poker-cards — card representation
- pokerproof — commit–reveal fairness

## Package

Implementation: `@btcpoker/rng` under `packages/rng`.

```bash
npm run test:rng
```

## Audit checklist

- [x] No `Math.random` in fairness paths (`rg 'Math\\.random' packages`). Enforced by `packages/rng/src/audit.test.ts`
- [x] Dealt deck is a deterministic function of the committed seed (`SeededStreamRng` + `deckFromCommitment`)
- [ ] Rejection sampling covers full 32-bit space correctly
- [ ] Commit–reveal uses SHA-256 over seed\|\|nonce; lengths documented
- [x] Injectable `Rng` used everywhere dealing happens
