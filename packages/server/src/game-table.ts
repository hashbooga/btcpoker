import { randomUUID } from "node:crypto";
import { commit, reveal, secureRandomInt, type CommitRevealCommitment } from "@btcpoker/rng";
import {
  Table, IllegalActionError, deckFromCommitment,
  type Card, type Hand, type HandEvent, type PlayerAction,
} from "@btcpoker/poker-core";
import type { Cashier, PaymentMethod } from "@btcpoker/payments";
import { chooseBotAction, botName } from "./bot.js";
import type { HandRecord, SeatView, TableState, TableSummary } from "./protocol.js";
import { SHUFFLE_ALGORITHM } from "./verify.js";

export type GameTableOptions = {
  id: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  cashier: Cashier;
  turnTimeoutMs?: number;
  botDelayMs?: [number, number];
  nextHandDelayMs?: number;
  onUpdate?: () => void;
  onHandComplete?: (rec: HandRecord) => void;
};

type Participant = {
  playerId: string;
  name: string;
  isBot: boolean;
  connected: boolean;
  seat: number;
  leaving: { method: PaymentMethod; destination: string } | null;
  method: PaymentMethod;
};

type CurrentHand = {
  commitment: CommitRevealCommitment;
  deck: Card[];
  startedAt: string;
  handNumber: number;
  dealOrderSeats: number[];
};

const BOT_METHOD: PaymentMethod = "lightning";

export class GameTable {
  readonly id: string;
  readonly name: string;
  readonly table: Table;
  readonly minBuyIn: number;
  readonly maxBuyIn: number;
  readonly participants = new Map<string, Participant>();
  readonly history: HandRecord[] = [];
  log: string[] = [];
  private current: CurrentHand | null = null;
  private lastRecord: HandRecord | null = null;
  private timer: NodeJS.Timeout | null = null;
  private turnDeadline: number | null = null;
  private reserved = new Set<number>();
  private pendingBotNames = new Set<string>();
  private closed = false;
  private readonly opts: Required<Omit<GameTableOptions, "onUpdate" | "onHandComplete">> & Pick<GameTableOptions, "onUpdate" | "onHandComplete">;

  constructor(opts: GameTableOptions) {
    this.opts = {
      minBuyIn: opts.bigBlind * 20,
      maxBuyIn: opts.bigBlind * 200,
      turnTimeoutMs: 30_000,
      botDelayMs: [700, 1600],
      nextHandDelayMs: 3500,
      ...opts,
    };
    this.id = opts.id;
    this.name = opts.name;
    this.minBuyIn = this.opts.minBuyIn;
    this.maxBuyIn = this.opts.maxBuyIn;
    this.table = new Table({ maxSeats: opts.maxSeats, smallBlind: opts.smallBlind, bigBlind: opts.bigBlind });
  }

  // ------------------------------------------------------------------ queries
  summary(): TableSummary {
    return {
      id: this.id, name: this.name, maxSeats: this.table.config.maxSeats,
      smallBlind: this.table.config.smallBlind, bigBlind: this.table.config.bigBlind,
      minBuyIn: this.minBuyIn, maxBuyIn: this.maxBuyIn,
      players: this.table.seats.filter(Boolean).length, handNumber: this.table.handNumber,
    };
  }

  private get hand(): Hand | null {
    return this.table.hand;
  }
  private handInProgress(): boolean {
    return !!this.hand && !this.hand.isComplete;
  }
  private participantAtSeat(seat: number): Participant | undefined {
    for (const p of this.participants.values()) if (p.seat === seat) return p;
    return undefined;
  }
  private nameOf(seat: number): string {
    return this.table.seats[seat]?.name ?? this.participantAtSeat(seat)?.name ?? `Seat ${seat + 1}`;
  }
  private addLog(line: string) {
    this.log.push(line);
    if (this.log.length > 60) this.log = this.log.slice(-60);
  }
  private changed() {
    this.opts.onUpdate?.();
  }

  // ------------------------------------------------------------------ seating / payments
  async join(playerId: string, name: string, buyIn: number, method: PaymentMethod, seat?: number): Promise<number> {
    if (this.participants.has(playerId)) throw new Error("already seated at this table");
    if (!Number.isInteger(buyIn) || buyIn < this.minBuyIn || buyIn > this.maxBuyIn) {
      throw new Error(`buy-in must be between ${this.minBuyIn} and ${this.maxBuyIn}`);
    }
    const target = seat ?? this.freeSeat();
    if (target < 0 || target >= this.table.seats.length) throw new Error("table is full");
    if (this.table.seats[target] || this.reserved.has(target)) throw new Error("seat taken");
    this.reserved.add(target);
    try {
      const { chips } = await this.opts.cashier.buyIn(playerId, buyIn, method, `${this.name} buy-in`);
      this.table.sit(target, { id: playerId, name: name.slice(0, 24) || "Player", stack: chips, sittingOut: false, isBot: false });
      this.participants.set(playerId, { playerId, name, isBot: false, connected: true, seat: target, leaving: null, method });
      this.addLog(`${name} sits in seat ${target + 1} with ${chips} chips (${method} play-money buy-in)`);
    } finally {
      this.reserved.delete(target);
    }
    this.schedule();
    this.changed();
    return target;
  }

  private freeSeat(): number {
    return this.table.seats.findIndex((s, i) => s === null && !this.reserved.has(i));
  }

  async addBot(): Promise<void> {
    const seat = this.freeSeat();
    if (seat < 0) throw new Error("table is full");
    const taken = new Set([...this.participants.values()].map((p) => p.name).concat([...this.pendingBotNames]));
    const name = botName(taken);
    const playerId = `bot-${randomUUID()}`;
    this.reserved.add(seat);
    this.pendingBotNames.add(name);
    try {
      const buyIn = Math.min(this.maxBuyIn, this.table.config.bigBlind * 100);
      const { chips } = await this.opts.cashier.buyIn(playerId, buyIn, BOT_METHOD, "bot buy-in");
      this.table.sit(seat, { id: playerId, name, stack: chips, sittingOut: false, isBot: true });
      this.participants.set(playerId, { playerId, name, isBot: true, connected: true, seat, leaving: null, method: BOT_METHOD });
      this.addLog(`${name} joins seat ${seat + 1}`);
    } finally {
      this.reserved.delete(seat);
      this.pendingBotNames.delete(name);
    }
    this.schedule();
    this.changed();
  }

  async removeBot(): Promise<void> {
    const bots = [...this.participants.values()].filter((p) => p.isBot && !p.leaving);
    const bot = bots[bots.length - 1];
    if (!bot) throw new Error("no bots to remove");
    await this.leave(bot.playerId, BOT_METHOD, "bot-bank");
  }

  /** Leave the table and cash out. If in a hand, the player is folded when their turn comes and removed after the hand. */
  async leave(playerId: string, method?: PaymentMethod, destination?: string): Promise<void> {
    const p = this.participants.get(playerId);
    if (!p) throw new Error("not seated");
    p.leaving = { method: method ?? p.method, destination: destination ?? "play-money-wallet" };
    const inHand = this.handInProgress() && this.hand!.players.some((hp) => hp.seat === p.seat && !hp.folded);
    if (inHand) {
      this.addLog(`${p.name} will leave after this hand`);
      this.schedule();
      this.changed();
      return;
    }
    await this.removeParticipant(p);
    this.schedule();
    this.changed();
  }

  private async removeParticipant(p: Participant) {
    const seated = this.table.seats[p.seat];
    const chips = seated?.stack ?? 0;
    if (this.handInProgress() && this.hand!.players.some((hp) => hp.seat === p.seat)) {
      // folded but hand still running: defer until settle
      return;
    }
    this.table.stand(p.seat);
    this.participants.delete(p.playerId);
    const dest = p.leaving ?? { method: p.method, destination: "play-money-wallet" };
    try {
      const entry = await this.opts.cashier.cashOut(p.playerId, chips, dest.method, dest.destination);
      this.addLog(`${p.name} leaves and cashes out ${chips} chips via ${dest.method}${entry.stub ? " (play-money stub, no BTC moved)" : ""}`);
    } catch (e) {
      this.addLog(`${p.name} cash-out failed: ${String(e)}`);
    }
    this.changed();
  }

  async rebuy(playerId: string, amount: number, method: PaymentMethod): Promise<void> {
    const p = this.participants.get(playerId);
    if (!p) throw new Error("not seated");
    const inHand = this.handInProgress() && this.hand!.players.some((hp) => hp.seat === p.seat);
    if (inHand) throw new Error("wait until the current hand is over to rebuy");
    const seat = this.table.seats[p.seat]!;
    if (seat.stack + amount > this.maxBuyIn) throw new Error(`stack would exceed max buy-in ${this.maxBuyIn}`);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("bad amount");
    const { chips } = await this.opts.cashier.buyIn(playerId, amount, method, `${this.name} rebuy`);
    seat.stack += chips;
    seat.sittingOut = false;
    this.addLog(`${p.name} adds ${chips} chips`);
    this.schedule();
    this.changed();
  }

  setSitOut(playerId: string, value: boolean) {
    const p = this.participants.get(playerId);
    if (!p) throw new Error("not seated");
    this.table.seats[p.seat]!.sittingOut = value;
    this.addLog(`${p.name} ${value ? "sits out" : "is back"}`);
    this.schedule();
    this.changed();
  }

  setConnected(playerId: string, connected: boolean) {
    const p = this.participants.get(playerId);
    if (!p || p.isBot) return;
    p.connected = connected;
    this.schedule();
    this.changed();
  }

  // ------------------------------------------------------------------ game flow
  act(playerId: string, action: PlayerAction) {
    const p = this.participants.get(playerId);
    if (!p) throw new Error("not seated");
    const hand = this.hand;
    if (!hand || hand.isComplete) throw new Error("no hand in progress");
    if (hand.toAct !== p.seat) throw new Error("not your turn");
    this.applyAction(p.seat, action);
  }

  private applyAction(seat: number, action: PlayerAction) {
    const hand = this.hand!;
    const before = hand.events.length;
    hand.act(seat, action);
    this.describeEvents(hand.events.slice(before));
    if (hand.isComplete) this.completeHand();
    this.schedule();
    this.changed();
  }

  private describeEvents(events: HandEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case "post": this.addLog(`${this.nameOf(e.seat)} posts ${e.blind} blind ${e.amount}${e.allIn ? " (all-in)" : ""}`); break;
        case "action": {
          const n = this.nameOf(e.seat);
          const txt = e.action === "fold" ? "folds" : e.action === "check" ? "checks" : e.action === "call" ? `calls ${e.amount}` : e.action === "bet" ? `bets ${e.to}` : `raises to ${e.to}`;
          this.addLog(`${n} ${txt}${e.allIn ? " (all-in)" : ""}`);
          break;
        }
        case "deal": this.addLog(`*** ${e.street.toUpperCase()} *** [${e.board.join(" ")}]`); break;
        case "uncalled": this.addLog(`Uncalled ${e.amount} returned to ${this.nameOf(e.seat)}`); break;
        case "show": this.addLog(`${this.nameOf(e.seat)} shows [${e.hole.join(" ")}] (${e.hand})`); break;
        case "win": this.addLog(`${this.nameOf(e.seat)} wins ${e.amount}${e.potIndex > 0 ? ` from side pot ${e.potIndex}` : ""}${e.hand ? ` with ${e.hand}` : ""}`); break;
      }
    }
  }

  private startHand() {
    if (!this.table.canStartHand()) return;
    // Commit FIRST (fresh CSPRNG seed+nonce), then derive the deck from it.
    const commitment = commit();
    const deck = deckFromCommitment(commitment.seed, commitment.nonce);
    const hand = this.table.startHand(deck);
    const order = hand.players.map((p) => p.seat);
    const startIdx = order.findIndex((s) => s > hand.buttonSeat);
    const dealOrderSeats = startIdx < 0 ? order : [...order.slice(startIdx), ...order.slice(0, startIdx)];
    this.current = { commitment, deck, startedAt: new Date().toISOString(), handNumber: this.table.handNumber, dealOrderSeats };
    this.addLog(`--- Hand #${this.table.handNumber} — commitment ${commitment.commit.slice(0, 16)}… ---`);
    this.describeEvents(hand.events);
    if (hand.isComplete) this.completeHand();
  }

  private completeHand() {
    const hand = this.hand!;
    const cur = this.current!;
    const rec: HandRecord = {
      tableId: this.id,
      handNumber: cur.handNumber,
      startedAt: cur.startedAt,
      endedAt: new Date().toISOString(),
      smallBlind: hand.smallBlind,
      bigBlind: hand.bigBlind,
      buttonSeat: hand.buttonSeat,
      players: hand.players.map((p) => ({ seat: p.seat, name: p.name, startingStack: p.startingStack, endingStack: p.stack })),
      dealOrderSeats: cur.dealOrderSeats,
      commit: cur.commitment.commit,
      reveal: reveal(cur.commitment),
      deck: cur.deck,
      holes: Object.fromEntries(hand.players.map((p) => [String(p.seat), p.hole])),
      board: [...hand.board],
      events: hand.events,
      results: hand.results,
      shuffleAlgorithm: SHUFFLE_ALGORITHM,
    };
    this.history.push(rec);
    if (this.history.length > 100) this.history.shift();
    this.lastRecord = rec;
    this.table.settleHand();
    this.addLog(`Hand #${cur.handNumber} complete. Seed revealed: ${rec.reveal.seed.slice(0, 16)}… (verify in the Fairness panel)`);
    this.opts.onHandComplete?.(rec);
    void this.afterHand();
  }

  private async afterHand() {
    for (const p of [...this.participants.values()]) {
      const seat = this.table.seats[p.seat];
      if (!seat) continue;
      if (!p.isBot && !p.connected && seat.sittingOut && !p.leaving) {
        // abandoned seat (tab closed and timed out): cash out to the stub wallet and free the seat
        p.leaving = { method: p.method, destination: "play-money-wallet" };
      }
      if (p.leaving) await this.removeParticipant(p);
      else if (p.isBot && seat.stack === 0) {
        const buyIn = Math.min(this.maxBuyIn, this.table.config.bigBlind * 100);
        const { chips } = await this.opts.cashier.buyIn(p.playerId, buyIn, BOT_METHOD, "bot rebuy");
        seat.stack = chips;
        this.addLog(`${p.name} rebuys for ${chips}`);
      } else if (!p.isBot && seat.stack === 0) {
        seat.sittingOut = true;
      }
    }
    this.schedule();
    this.changed();
  }

  /** (Re)arm the single timer that drives bots, turn timeouts and the next deal. */
  private schedule() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.turnDeadline = null;
    const hand = this.hand;
    if (hand && !hand.isComplete && hand.toAct !== null) {
      const seat = hand.toAct;
      const p = this.participantAtSeat(seat);
      const seated = this.table.seats[seat];
      const handNo = this.table.handNumber;
      const run = (fn: () => void, ms: number) => {
        this.timer = setTimeout(() => {
          if (this.table.handNumber !== handNo || this.hand?.toAct !== seat || this.hand.isComplete) return;
          try { fn(); } catch (e) { this.addLog(`auto-action error: ${String(e)}`); }
        }, ms);
      };
      if (!p || p.leaving || seated?.sittingOut) {
        run(() => this.autoAct(seat, true), 400);
      } else if (p.isBot) {
        const [lo, hi] = this.opts.botDelayMs;
        // bot "thinking" jitter also uses the CSPRNG helper (project rule: no non-crypto PRNG anywhere)
        const delay = lo + (hi > lo ? secureRandomInt(hi - lo) : 0);
        run(() => {
          const la = this.hand!.legalActions()!;
          let a = chooseBotAction(this.hand!, seat, la);
          try { this.applyAction(seat, a); } catch (e) {
            if (!(e instanceof IllegalActionError)) throw e;
            a = la.canCheck ? { type: "check" } : { type: "fold" };
            this.applyAction(seat, a);
          }
        }, delay);
      } else {
        const ms = p.connected ? this.opts.turnTimeoutMs : Math.min(this.opts.turnTimeoutMs, 5000);
        this.turnDeadline = Date.now() + ms;
        run(() => {
          this.addLog(`${p.name} timed out`);
          this.table.seats[seat]!.sittingOut = true;
          this.autoAct(seat, false);
        }, ms);
      }
      return;
    }
    if (this.table.canStartHand()) {
      const delay = this.lastRecord ? this.opts.nextHandDelayMs : 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.table.canStartHand()) return;
        this.startHand();
        this.schedule();
        this.changed();
      }, delay);
    }
  }

  private autoAct(seat: number, _quiet: boolean) {
    const la = this.hand!.legalActions()!;
    this.applyAction(seat, la.canCheck ? { type: "check" } : { type: "fold" });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  // ------------------------------------------------------------------ views
  viewFor(playerId: string | null, paymentMethods: TableState["paymentMethods"]): TableState {
    const hand = this.hand;
    const inProgress = this.handInProgress();
    const me = playerId ? this.participants.get(playerId) : undefined;
    const showdown = !!hand && hand.isComplete && hand.showdownHands.size > 0;
    const winners = hand && hand.isComplete ? hand.results.flatMap((r) => r.winners.map((w) => ({ seat: w.seat, amount: w.amount, ...(r.winningHand ? { hand: r.winningHand } : {}) }))) : [];
    const lastActions = new Map<number, string>();
    if (hand) {
      for (const e of hand.events) {
        if (e.type === "deal") lastActions.clear();
        if (e.type === "action") lastActions.set(e.seat, e.action === "bet" || e.action === "raise" ? `${e.action} ${e.to}` : e.action === "call" ? `call ${e.amount}` : e.action);
        if (e.type === "post") lastActions.set(e.seat, `${e.blind === "small" ? "SB" : "BB"} ${e.amount}`);
      }
    }
    const seats: (SeatView | null)[] = this.table.seats.map((s, i) => {
      if (!s) return null;
      const hp = hand?.players.find((x) => x.seat === i && x.id === s.id);
      const part = this.participants.get(s.id);
      const isMe = !!me && me.seat === i;
      const shown = showdown && hp && !hp.folded;
      return {
        seat: i,
        name: s.name,
        playerId: s.isBot ? s.id : s.id.slice(0, 8),
        stack: hp && inProgress ? hp.stack : s.stack,
        isBot: s.isBot,
        sittingOut: s.sittingOut,
        connected: part?.connected ?? false,
        inHand: !!hp && inProgress,
        folded: !!hp?.folded,
        allIn: !!hp?.allIn && inProgress,
        streetBet: hp && inProgress ? hp.streetBet : 0,
        cards: hp && (isMe || shown) ? hp.hole : null,
        cardCount: hp && !hp.folded ? hp.hole.length : 0,
        lastAction: hp ? (lastActions.get(i) ?? null) : null,
        isWinner: winners.some((w) => w.seat === i),
        handDescription: shown ? (hand!.showdownHands.get(i)?.description ?? null) : null,
      };
    });
    const legal = inProgress && me && hand!.toAct === me.seat ? hand!.legalActions() : null;
    return {
      t: "state",
      table: this.summary(),
      seats,
      buttonSeat: this.table.buttonSeat,
      sbSeat: hand ? hand.sbSeat : null,
      bbSeat: hand ? hand.bbSeat : null,
      street: hand ? hand.street : "waiting",
      board: hand ? hand.board : [],
      pot: hand ? (inProgress ? hand.potTotal : 0) : 0,
      pots: hand && hand.isComplete ? hand.results.map((r) => ({ amount: r.amount, eligible: r.eligible })) : [],
      toAct: inProgress ? hand!.toAct : null,
      turnDeadline: this.turnDeadline,
      you: { playerId: playerId ?? "", seat: me ? me.seat : null, legal, stack: me ? (this.table.seats[me.seat]?.stack ?? 0) : 0 },
      fairness: this.current ? { handNumber: this.current.handNumber, commit: this.current.commitment.commit, ...(inProgress ? {} : { reveal: reveal(this.current.commitment) }) } : null,
      lastHand: this.lastRecord ? { handNumber: this.lastRecord.handNumber, commit: this.lastRecord.commit, reveal: this.lastRecord.reveal } : null,
      winners,
      log: this.log.slice(-40),
      paymentMethods,
    };
  }
}
