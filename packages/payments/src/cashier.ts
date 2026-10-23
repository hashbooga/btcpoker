import type { PaymentAdapter, PaymentMethod } from "./types.js";

export type LedgerEntry = {
  at: string;
  playerId: string;
  kind: "buy-in" | "cash-out";
  method: PaymentMethod;
  chips: number;
  sats: bigint;
  reference: string;
  stub: boolean;
};

export type CashierOptions = {
  adapters: PaymentAdapter[];
  /** Satoshis per chip (1 chip = 1 sat by default). */
  satsPerChip?: bigint;
  /** How long to wait for a buy-in invoice to settle. */
  settleTimeoutMs?: number;
  pollMs?: number;
};

/**
 * Converts between payments and table chips through the `PaymentAdapter` interface.
 * The game server only ever talks to the cashier, so swapping stub adapters for
 * real mainchain / Lightning / Cashu backends requires no game-server changes.
 */
export class Cashier {
  private readonly adapters = new Map<PaymentMethod, PaymentAdapter>();
  readonly ledger: LedgerEntry[] = [];
  readonly satsPerChip: bigint;
  private readonly settleTimeoutMs: number;
  private readonly pollMs: number;

  constructor(opts: CashierOptions) {
    for (const a of opts.adapters) this.adapters.set(a.id, a);
    this.satsPerChip = opts.satsPerChip ?? 1n;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 60_000;
    this.pollMs = opts.pollMs ?? 250;
  }

  methods(): { id: PaymentMethod; label: string; isStub: boolean }[] {
    return [...this.adapters.values()].map((a) => ({ id: a.id, label: a.label, isStub: a.isStub }));
  }

  private adapter(method: PaymentMethod): PaymentAdapter {
    const a = this.adapters.get(method);
    if (!a) throw new Error(`payment method ${method} not available`);
    return a;
  }

  /** Create an invoice for `chips`, wait for settlement, and return the chips to credit. */
  async buyIn(playerId: string, chips: number, method: PaymentMethod, memo = "table buy-in"): Promise<{ chips: number; entry: LedgerEntry }> {
    if (!Number.isInteger(chips) || chips <= 0) throw new Error("buy-in must be a positive integer");
    const a = this.adapter(method);
    const sats = BigInt(chips) * this.satsPerChip;
    const inv = await a.createInvoice({ amountSats: sats, asset: "btc" }, memo);
    const deadline = Date.now() + this.settleTimeoutMs;
    for (;;) {
      const st = await a.getStatus(inv.paymentId);
      if (st === "settled") break;
      if (st === "expired" || st === "failed") throw new Error(`payment ${st}`);
      if (Date.now() > deadline) throw new Error("payment not settled in time");
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    const entry: LedgerEntry = { at: new Date().toISOString(), playerId, kind: "buy-in", method, chips, sats, reference: inv.paymentId, stub: a.isStub };
    this.ledger.push(entry);
    return { chips, entry };
  }

  /** Convert chips back to sats and pay out to `destination`. */
  async cashOut(playerId: string, chips: number, method: PaymentMethod, destination: string): Promise<LedgerEntry> {
    if (!Number.isInteger(chips) || chips < 0) throw new Error("bad chip amount");
    const a = this.adapter(method);
    const sats = BigInt(chips) * this.satsPerChip;
    const res = chips === 0 ? { payoutId: "none", status: "settled" as const } : await a.payout({ amountSats: sats, asset: "btc" }, destination);
    if (res.status === "failed" || res.status === "expired") throw new Error(`payout ${res.status}`);
    const entry: LedgerEntry = { at: new Date().toISOString(), playerId, kind: "cash-out", method, chips, sats, reference: res.payoutId, stub: a.isStub };
    this.ledger.push(entry);
    return entry;
  }
}
