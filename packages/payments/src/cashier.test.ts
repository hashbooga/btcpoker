import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cashier } from "./cashier.js";
import { cashuStub, lightningStub, mainchainStub } from "./stubs.js";
import type { PaymentAdapter } from "./types.js";

describe("cashier with play-money stubs", () => {
  it("buy-in and cash-out go through the adapter and are recorded", async () => {
    const c = new Cashier({ adapters: [mainchainStub, lightningStub, cashuStub] });
    assert.deepEqual(c.methods().map((m) => m.id), ["mainchain", "lightning", "cashu"]);
    assert.ok(c.methods().every((m) => m.isStub), "all stubs");
    const r = await c.buyIn("alice", 1000, "lightning");
    assert.equal(r.chips, 1000);
    const out = await c.cashOut("alice", 1234, "cashu", "ecash");
    assert.equal(out.sats, 1234n);
    assert.equal(c.ledger.length, 2);
    assert.equal(c.ledger[0]!.stub, true);
  });

  it("rejects bad amounts and unknown methods", async () => {
    const c = new Cashier({ adapters: [lightningStub] });
    await assert.rejects(c.buyIn("a", 0, "lightning"));
    await assert.rejects(c.buyIn("a", 10, "mainchain"), /not available/);
  });

  it("waits for a pending invoice and fails on expiry (pluggable backend)", async () => {
    let polls = 0;
    const slow: PaymentAdapter = {
      id: "lightning", label: "test", isStub: false,
      async createInvoice() { return { paymentId: "x", payload: "lnbc..." }; },
      async getStatus() { return ++polls < 3 ? "pending" : "settled"; },
      async payout() { return { payoutId: "p", status: "settled" }; },
    };
    const c = new Cashier({ adapters: [slow], pollMs: 1 });
    await c.buyIn("a", 10, "lightning");
    assert.equal(polls, 3);
    const dead: PaymentAdapter = { ...slow, async getStatus() { return "expired"; } };
    await assert.rejects(new Cashier({ adapters: [dead], pollMs: 1 }).buyIn("a", 10, "lightning"), /expired/);
  });
});
