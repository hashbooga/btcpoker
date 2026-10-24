# btcpoker

Playable no-limit Texas hold'em in the browser: a real-time WebSocket game server, a provably-fair (commit–reveal) shuffle, simple bot opponents, and a payment layer for Bitcoin (mainchain, Lightning, Cashu). The payment layer currently runs as **play-money stubs**.

> ⚠ **Play money only.** The payment adapters are stubs. Invoices settle instantly, and no bitcoin is moved on-chain, over Lightning, or through a Cashu mint. The buy-in and cash-out flow still goes through the `PaymentAdapter` interface, so real backends can be dropped in later.

## Priority

Auditable open-source CSPRNG for card dealing. See [docs/rng.md](docs/rng.md).

**Never use `Math.random`.** A test (`packages/rng/src/audit.test.ts`) enforces this across all package sources.

## Quick start

Requires Node ≥ 20.

```bash
npm install
npm start          # builds everything, then serves http://localhost:3000
```

`npm run dev` does the same thing. To use a different port, run `PORT=8080 npm start`.

Then:

- **Solo:** enter a name and click **Quick play vs bots**. You'll be seated with 3 bots.
- **Multiplayer:** open the page in more browser tabs. Each tab is a separate player (identity is per-tab in `sessionStorage`). Join the same table, or click an empty seat.
- Add or remove bots, sit out, add chips, or leave and cash out from the **Cashier** tab.
- After any hand, open **Fairness → Verify last hand in this browser** to check the shuffle yourself.

Keyboard shortcuts: **F** fold, **C** check/call, **R** bet/raise (uses the slider amount).

### Camera angles

The table has three switchable camera angles. Use the **Standard / Overhead / POV** toggle above the table, or press **1**, **2**, **3** (**V** cycles). Your choice is saved in `localStorage` and survives reloads.

1. **Standard**: the default view, with the felt tilted slightly away from you and the player plates standing up off the rail.
2. **Overhead**: a flat, top-down bird's-eye view of the whole table, with a rounder felt and larger community cards so every seat, bet and pot is visible at once.
3. **POV**: a first-person view from your seat. The felt recedes in front of you with the opponents and board across the table, and your two hole cards are drawn large in the foreground.

The angles are pure CSS 3D transforms (`perspective` and `rotateX` on the felt, with counter-rotated seat "billboards"). There's no 3D engine or extra dependency. Gameplay, the Log, Fairness and Cashier tabs work the same in every view, and opponents' hole cards stay hidden until showdown (the server never sends them).

## Scripts

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Build all packages and start the server (`PORT`, `HOST` env vars) |
| `npm run build` | `tsc -b` over all packages (project references) |
| `npm run typecheck` | Forced full rebuild/type-check of every package |
| `npm test` | Build, then run every package's tests (unit + server/WebSocket integration) |
| `npm run test:rng` | RNG package tests only |
| `npm run verify-hand -- <url-or-file>` | Independently verify a finished hand, e.g. `npm run verify-hand -- http://localhost:3000/api/tables/satoshi/hands/1` |
| `npm run clean` | Remove build output |

## Packages

| Package | Role |
|---------|------|
| `@btcpoker/rng` | CSPRNG (`crypto.randomFillSync`), rejection-sampled `secureRandomInt`, Fisher–Yates, commit–reveal, and `SeededStreamRng` (a deterministic SHA-256 stream from a committed seed, which makes shuffles replayable) |
| `@btcpoker/poker-core` | Full NLHE rules: `Table` (seating, button rotation, busted/sitting-out handling) and `Hand` (blinds incl. heads-up, preflop→river betting, fold/check/call/bet/raise/all-in, min-raise and the TDA "short all-in doesn't reopen" rule, uncalled-bet return, side pots, showdown, split pots, odd chip), plus a 7-card hand evaluator with full tie-breaking |
| `@btcpoker/payments` | `PaymentAdapter` interface (invoice, status, payout), play-money stubs for mainchain, Lightning and Cashu, and a `Cashier` that converts payments ↔ chips and keeps a ledger |
| `@btcpoker/server` | HTTP + WebSocket server (`ws`). Hosts several tables and runs the turn timers, bots and hand history. Every deal is commit–reveal. Also serves the client |
| `@btcpoker/client` | Browser UI (plain TS compiled to ES modules, no bundler): lobby, table with three camera angles (standard / overhead / POV), cards, chips, pot, action buttons, bet slider with presets, log, fairness verifier, cashier |

## How a hand is dealt (provably fair)

1. Before dealing, the server draws a fresh 32-byte seed and 16-byte nonce from the CSPRNG and publishes `commit = SHA-256(seed‖nonce)` to every client.
2. The deck is a Fisher–Yates shuffle driven by `SHA-256("btcpoker/deck/v1"‖seed‖nonce‖counter)`, with rejection sampling so there's no modulo bias.
3. Cards are dealt in a fixed order: one at a time from left of the button (two passes), then burn, flop, burn, turn, burn, river.
4. When the hand ends, the seed and nonce are revealed. The full hand record is at `GET /api/tables/:id/hands/:n`.
5. Anyone can recompute the commitment, the deck and every hole/board card. You can do this with the in-browser verifier (an independent pure-JS SHA-256), the CLI (`npm run verify-hand`), or `GET /api/tables/:id/hands/:n/verify`.

Details and caveats are in [docs/rng.md](docs/rng.md).

## HTTP / WebSocket API

- `GET /api/tables`: table summaries
- `GET /api/tables/:id/hands`: completed hands (number and commit)
- `GET /api/tables/:id/hands/:n`: full public hand record (reveal, deck, holes, board, events, results)
- `GET /api/tables/:id/hands/:n/verify`: server-side verification result
- `GET /api/ledger`: stub payment ledger (buy-ins and cash-outs)
- `WS /ws`: JSON messages (`hello`, `join`, `action`, `leave`, `rebuy`, `sitOut`, `addBot`, `removeBot`, `watch`, `lobby`). The server pushes a personalised `state` (you only see your own hole cards until showdown) and a `handComplete` record. Types are in `packages/server/src/protocol.ts`.

## Plugging in real payments

Implement `PaymentAdapter` (`packages/payments/src/types.ts`):

```ts
interface PaymentAdapter {
  id: "mainchain" | "lightning" | "cashu"; label: string; isStub: boolean;
  createInvoice(amount, memo?): Promise<{ paymentId; payload }>; // e.g. BOLT11, address, mint quote
  getStatus(paymentId): Promise<"pending" | "settled" | "expired" | "failed">;
  payout(amount, destination): Promise<{ payoutId; status; payload? }>;
}
```

Then pass it to `startServer({ adapters: [...] })`. The `Cashier` already polls `getStatus` until settlement before crediting chips, and it records every buy-in and cash-out in its ledger. Before real money goes in, the client still needs a step that displays the invoice (`payload`) for a pending payment, because the stubs settle instantly.

## Known limitations

- Payments are stubs: no real BTC, no persistence of balances. Server state is in memory and is lost on restart.
- Fairness is a **dealer-side** commitment. The server can't change the deck after committing, but it still knows every card during the hand, and players don't contribute entropy yet. Multi-party seeds or mental poker can wrap the same `Rng` later. Hand records reveal every dealt hole card after the hand, including folded hands.
- At showdown all live hands are shown (no mucking or show order). The button simply moves to the next eligible seat (no dead-button rule), and new players are dealt in right away without posting.
- No accounts or auth beyond a per-tab session token. No chat, no tournaments, no rake.
- Bots use a simple strength-based heuristic.

## Repo target

Intended source of truth: Origin at `https://cursor.com/codebase/btcpoker` (not GitHub).

## License

TBD
