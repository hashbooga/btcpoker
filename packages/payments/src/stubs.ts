import type { Money, PaymentAdapter, PaymentMethod, PaymentStatus } from "./types.js";

/**
 * PLAY-MONEY STUBS. These adapters never touch the Bitcoin network, a Lightning
 * node, or a Cashu mint. Invoices "settle" instantly so the buy-in / cash-out
 * flow can be exercised end-to-end. Replace with real adapters implementing
 * `PaymentAdapter` (same interface) to go live.
 */
function stub(id: PaymentMethod, label: string): PaymentAdapter {
  let counter = 0;
  const invoices = new Map<string, PaymentStatus>();
  return {
    id,
    label: `${label} (play-money stub)`,
    isStub: true,
    async createInvoice(amount: Money, memo?: string) {
      const paymentId = `${id}-stub-${++counter}-${amount.amountSats}`;
      invoices.set(paymentId, "settled"); // play money: auto-settle
      return {
        paymentId,
        payload: JSON.stringify({ id, amountSats: amount.amountSats.toString(), memo: memo ?? null, stub: true }),
      };
    },
    async getStatus(paymentId: string) {
      return invoices.get(paymentId) ?? "failed";
    },
    async payout(amount: Money, destination: string) {
      return {
        payoutId: `${id}-stub-payout-${++counter}`,
        status: "settled" as const,
        payload: JSON.stringify({ id, amountSats: amount.amountSats.toString(), destination, stub: true }),
      };
    },
  };
}

export const mainchainStub = stub("mainchain", "Bitcoin on-chain");
export const lightningStub = stub("lightning", "Lightning");
export const cashuStub = stub("cashu", "Cashu ecash");
