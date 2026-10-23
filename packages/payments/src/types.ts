export type Money = { amountSats: bigint; asset: "btc" };

export type PaymentMethod = "mainchain" | "lightning" | "cashu";
export type PaymentStatus = "pending" | "settled" | "expired" | "failed";

export interface PaymentAdapter {
  readonly id: PaymentMethod;
  /** Human-readable label for UIs. */
  readonly label: string;
  /** True for play-money stubs that never move real bitcoin. */
  readonly isStub: boolean;
  /** Create an invoice / payment request for a table buy-in or transfer. */
  createInvoice(amount: Money, memo?: string): Promise<{ paymentId: string; payload: string }>;
  /** Check whether a payment settled. */
  getStatus(paymentId: string): Promise<PaymentStatus>;
  /**
   * Pay out (cash-out) to a destination: on-chain address, BOLT11 invoice / LN address,
   * or (for Cashu) return an ecash token in `payload`.
   */
  payout(amount: Money, destination: string): Promise<{ payoutId: string; status: PaymentStatus; payload?: string }>;
}
