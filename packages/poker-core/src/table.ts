import type { Card } from "./cards.js";
import { Hand, type HandConfig } from "./hand.js";

export type SeatedPlayer = {
  id: string;
  name: string;
  stack: number;
  sittingOut: boolean;
  isBot: boolean;
};

export type TableConfig = { maxSeats: number; smallBlind: number; bigBlind: number };

/**
 * Seats + button rotation. A `Table` runs one `Hand` at a time; the shuffled
 * deck is supplied by the caller (the server derives it from a commit–reveal seed).
 */
export class Table {
  readonly seats: (SeatedPlayer | null)[];
  buttonSeat = -1;
  hand: Hand | null = null;
  handNumber = 0;

  constructor(readonly config: TableConfig) {
    if (config.maxSeats < 2 || config.maxSeats > 10) throw new RangeError("maxSeats must be 2..10");
    this.seats = Array.from({ length: config.maxSeats }, () => null);
  }

  sit(seat: number, player: SeatedPlayer): void {
    if (seat < 0 || seat >= this.seats.length) throw new RangeError("bad seat");
    if (this.seats[seat]) throw new Error("seat taken");
    if (this.seats.some((s) => s?.id === player.id)) throw new Error("already seated");
    this.seats[seat] = player;
  }

  /** Remove a player. Must not be in a hand in progress (caller folds them first and waits). */
  stand(seat: number): SeatedPlayer | null {
    if (this.hand && !this.hand.isComplete && this.hand.players.some((p) => p.seat === seat)) {
      throw new Error("player is in a hand in progress");
    }
    const p = this.seats[seat] ?? null;
    this.seats[seat] = null;
    return p;
  }

  firstEmptySeat(): number {
    return this.seats.findIndex((s) => s === null);
  }

  /** Seats that will be dealt in to the next hand. */
  eligibleSeats(): number[] {
    const out: number[] = [];
    this.seats.forEach((s, i) => {
      if (s && !s.sittingOut && s.stack > 0) out.push(i);
    });
    return out;
  }

  canStartHand(): boolean {
    return (!this.hand || this.hand.isComplete) && this.eligibleSeats().length >= 2;
  }

  /** Next button position: next eligible seat clockwise from the previous button. */
  nextButton(): number {
    const elig = this.eligibleSeats();
    if (elig.length === 0) throw new Error("no eligible seats");
    return elig.find((s) => s > this.buttonSeat) ?? elig[0]!;
  }

  startHand(deck: Card[]): Hand {
    if (!this.canStartHand()) throw new Error("cannot start hand");
    this.buttonSeat = this.nextButton();
    const players = this.eligibleSeats().map((seat) => {
      const s = this.seats[seat]!;
      return { seat, id: s.id, name: s.name, stack: s.stack };
    });
    const cfg: HandConfig = {
      players,
      buttonSeat: this.buttonSeat,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      deck,
    };
    this.hand = new Hand(cfg);
    this.handNumber++;
    return this.hand;
  }

  /** Copy final stacks back to seats once the hand is complete. */
  settleHand(): void {
    const h = this.hand;
    if (!h || !h.isComplete) throw new Error("no completed hand");
    for (const p of h.players) {
      const s = this.seats[p.seat];
      if (s && s.id === p.id) s.stack = p.stack;
    }
  }
}
