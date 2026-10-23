import type { Card } from "./cards.js";
import { evaluateHand, type HandValue } from "./evaluator.js";

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";

/** For bet/raise, `amount` is the TOTAL the player will have in front of them this street ("raise to"). */
export type PlayerAction = { type: ActionType; amount?: number };

export type HandPlayerInput = { seat: number; id: string; name: string; stack: number };

export type HandPlayer = {
  seat: number;
  id: string;
  name: string;
  hole: Card[];
  startingStack: number;
  stack: number;
  /** Chips committed on the current street. */
  streetBet: number;
  /** Chips committed over the whole hand (incl. blinds). */
  totalBet: number;
  folded: boolean;
  allIn: boolean;
  /** The table's current bet when this player last voluntarily acted this street (null = not yet acted). */
  actedAtBet: number | null;
};

export type LegalActions = {
  seat: number;
  toCall: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** True when currentBet == 0 and a bet is possible. */
  canBet: boolean;
  /** True when facing a bet and a (re-)raise is permitted. */
  canRaise: boolean;
  /** Minimum legal "to" amount for bet/raise (or the all-in amount if the stack is short). */
  minTo: number;
  /** Maximum "to" amount (= all-in). */
  maxTo: number;
};

export type Pot = { amount: number; eligible: number[] /* seats */ };

export type PotResult = {
  amount: number;
  eligible: number[];
  winners: { seat: number; amount: number }[];
  /** Hand description of the winning hand (undefined when uncontested). */
  winningHand?: string;
};

export type HandEvent =
  | { type: "post"; seat: number; blind: "small" | "big"; amount: number; allIn: boolean }
  | { type: "deal"; street: Street; board: Card[] }
  | { type: "action"; seat: number; action: ActionType; amount: number; to: number; allIn: boolean }
  | { type: "uncalled"; seat: number; amount: number }
  | { type: "show"; seat: number; hole: Card[]; hand: string }
  | { type: "win"; seat: number; amount: number; potIndex: number; hand?: string };

export type HandConfig = {
  players: HandPlayerInput[];
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  /** Already-shuffled deck. Dealing order is deterministic (see `dealOrder`). */
  deck: Card[];
};

export class IllegalActionError extends Error {}

/**
 * Deterministic deal from a shuffled deck: hole cards one at a time starting
 * left of the button (two passes), then burn+3 flop, burn+1 turn, burn+1 river.
 * Shared by the engine and the fairness verifier.
 */
export function dealOrder(deck: readonly Card[], seatsFromSbInOrder: readonly number[]) {
  const n = seatsFromSbInOrder.length;
  if (deck.length < n * 2 + 8) throw new Error("deck too small");
  const holes = new Map<number, Card[]>();
  let i = 0;
  for (let round = 0; round < 2; round++)
    for (const seat of seatsFromSbInOrder) {
      const arr = holes.get(seat) ?? [];
      arr.push(deck[i++]!);
      holes.set(seat, arr);
    }
  i++; // burn
  const flop = deck.slice(i, i + 3); i += 3;
  i++; // burn
  const turn = deck[i++]!;
  i++; // burn
  const river = deck[i++]!;
  return { holes, board: [...flop, turn, river] as Card[] };
}

export class Hand {
  readonly players: HandPlayer[]; // in seat order
  readonly buttonSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly sbSeat: number;
  readonly bbSeat: number;
  readonly events: HandEvent[] = [];
  street: Street = "preflop";
  board: Card[] = [];
  currentBet = 0;
  /** Size of the last full bet/raise increment (min-raise step). */
  minRaise: number;
  /** Seat whose turn it is, or null when no action is pending. */
  toAct: number | null = null;
  results: PotResult[] = [];
  showdownHands = new Map<number, HandValue>();

  private readonly fullBoard: Card[];

  constructor(cfg: HandConfig) {
    const { players, buttonSeat, smallBlind, bigBlind, deck } = cfg;
    if (players.length < 2) throw new Error("need at least 2 players");
    if (!(smallBlind > 0 && bigBlind >= smallBlind)) throw new Error("bad blinds");
    if (new Set(deck).size !== deck.length) throw new Error("deck has duplicates");
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    if (!sorted.some((p) => p.seat === buttonSeat)) throw new Error("button must be an active seat");
    for (const p of sorted) if (!(p.stack > 0 && Number.isInteger(p.stack))) throw new Error("stacks must be positive integers");
    this.players = sorted.map((p) => ({
      seat: p.seat, id: p.id, name: p.name, hole: [], startingStack: p.stack, stack: p.stack,
      streetBet: 0, totalBet: 0, folded: false, allIn: false, actedAtBet: null,
    }));
    this.buttonSeat = buttonSeat;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.minRaise = bigBlind;

    const headsUp = this.players.length === 2;
    this.sbSeat = headsUp ? buttonSeat : this.nextSeat(buttonSeat);
    this.bbSeat = this.nextSeat(this.sbSeat);

    // deal
    const order = this.seatsFrom(this.nextSeat(buttonSeat));
    const { holes, board } = dealOrder(deck, order);
    for (const p of this.players) p.hole = holes.get(p.seat)!;
    this.fullBoard = board;

    // blinds
    this.post(this.sbSeat, smallBlind, "small");
    this.post(this.bbSeat, bigBlind, "big");
    this.currentBet = bigBlind;

    const first = headsUp ? this.sbSeat : this.nextSeat(this.bbSeat);
    this.toAct = this.findToAct(first, true);
    if (this.toAct === null) this.closeBettingRound();
  }

  // ---------- helpers ----------
  player(seat: number): HandPlayer {
    const p = this.players.find((x) => x.seat === seat);
    if (!p) throw new Error(`no player in seat ${seat}`);
    return p;
  }
  /** Next seat (clockwise) among hand participants. */
  private nextSeat(seat: number): number {
    const after = this.players.find((p) => p.seat > seat);
    return (after ?? this.players[0]!).seat;
  }
  /** All participating seats starting at `seat`, clockwise. */
  private seatsFrom(seat: number): number[] {
    const idx = this.players.findIndex((p) => p.seat === seat);
    return this.players.map((_, i) => this.players[(idx + i) % this.players.length]!.seat);
  }
  private post(seat: number, amount: number, blind: "small" | "big") {
    const p = this.player(seat);
    const a = Math.min(amount, p.stack);
    this.commit(p, a);
    this.events.push({ type: "post", seat, blind, amount: a, allIn: p.allIn });
  }
  private commit(p: HandPlayer, amount: number) {
    p.stack -= amount;
    p.streetBet += amount;
    p.totalBet += amount;
    if (p.stack === 0) p.allIn = true;
  }
  private canActCount(): number {
    return this.players.filter((p) => !p.folded && !p.allIn).length;
  }
  private needsToAct(p: HandPlayer): boolean {
    if (p.folded || p.allIn) return false;
    if (p.streetBet < this.currentBet) return true;
    if (p.actedAtBet !== null) return false;
    // hasn't acted but already matched: only needs to act if someone else could still respond
    return this.players.some((o) => o !== p && !o.folded && !o.allIn);
  }
  private findToAct(fromSeat: number, inclusive: boolean): number | null {
    const seats = this.seatsFrom(fromSeat);
    const list = inclusive ? seats : [...seats.slice(1), seats[0]!];
    for (const s of list) if (this.needsToAct(this.player(s))) return s;
    return null;
  }

  get isComplete(): boolean {
    return this.street === "complete";
  }
  /** Chips in the middle including current street bets. */
  get potTotal(): number {
    return this.players.reduce((s, p) => s + p.totalBet, 0);
  }

  // ---------- actions ----------
  legalActions(): LegalActions | null {
    if (this.toAct === null) return null;
    const p = this.player(this.toAct);
    const toCall = Math.max(0, Math.min(this.currentBet - p.streetBet, p.stack));
    const maxTo = p.streetBet + p.stack;
    const othersCanRespond = this.players.some((o) => o !== p && !o.folded && !o.allIn);
    // TDA rule: a player who already acted may re-raise only if the action has since been raised by at least a full raise.
    const reopened = p.actedAtBet === null || this.currentBet - p.actedAtBet >= this.minRaise;
    const canAggress = othersCanRespond && reopened && maxTo > this.currentBet;
    const canBet = this.currentBet === 0 && canAggress;
    const canRaise = this.currentBet > 0 && canAggress;
    const fullMin = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.minRaise;
    return {
      seat: p.seat,
      toCall,
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canBet,
      canRaise,
      minTo: Math.min(fullMin, maxTo),
      maxTo,
    };
  }

  act(seat: number, action: PlayerAction): void {
    if (this.isComplete) throw new IllegalActionError("hand is complete");
    if (this.toAct !== seat) throw new IllegalActionError(`not seat ${seat}'s turn`);
    const la = this.legalActions()!;
    const p = this.player(seat);
    let type = action.type;
    let to = action.amount ?? 0;

    if (type === "allin") {
      if (la.maxTo <= this.currentBet || !(la.canBet || la.canRaise)) {
        if (la.canCall) type = "call";
        else throw new IllegalActionError("cannot go all-in here (raising not allowed); call or fold");
      } else {
        type = la.canBet ? "bet" : "raise";
        to = la.maxTo;
      }
    }

    switch (type) {
      case "fold":
        p.folded = true;
        p.actedAtBet = this.currentBet;
        this.events.push({ type: "action", seat, action: "fold", amount: 0, to: p.streetBet, allIn: false });
        break;
      case "check":
        if (!la.canCheck) throw new IllegalActionError("cannot check facing a bet");
        p.actedAtBet = this.currentBet;
        this.events.push({ type: "action", seat, action: "check", amount: 0, to: p.streetBet, allIn: false });
        break;
      case "call": {
        if (!la.canCall) throw new IllegalActionError("nothing to call");
        this.commit(p, la.toCall);
        p.actedAtBet = this.currentBet;
        this.events.push({ type: "action", seat, action: "call", amount: la.toCall, to: p.streetBet, allIn: p.allIn });
        break;
      }
      case "bet":
      case "raise": {
        if (type === "bet" && !la.canBet) throw new IllegalActionError(this.currentBet > 0 ? "facing a bet: raise instead" : "betting not allowed");
        if (type === "raise" && !la.canRaise) throw new IllegalActionError(this.currentBet === 0 ? "no bet to raise: bet instead" : "raising not allowed");
        if (!Number.isInteger(to)) throw new IllegalActionError("amount must be an integer");
        if (to > la.maxTo) throw new IllegalActionError(`max is ${la.maxTo}`);
        const isAllIn = to === la.maxTo;
        if (to < la.minTo && !isAllIn) throw new IllegalActionError(`minimum ${type} is to ${la.minTo}`);
        if (to <= this.currentBet) throw new IllegalActionError("must exceed current bet");
        const increment = to - this.currentBet;
        if (increment >= this.minRaise || (this.currentBet === 0 && increment >= this.bigBlind)) {
          this.minRaise = Math.max(increment, this.bigBlind); // full bet/raise: sets new min-raise step
        }
        // short all-in (increment < minRaise) does not change minRaise and does not reopen for those who acted
        const amount = to - p.streetBet;
        this.commit(p, amount);
        this.currentBet = to;
        p.actedAtBet = to;
        this.events.push({ type: "action", seat, action: type, amount, to, allIn: p.allIn });
        break;
      }
      default:
        throw new IllegalActionError(`unknown action ${String(type)}`);
    }

    this.advance(seat);
  }

  private advance(fromSeat: number) {
    const live = this.players.filter((p) => !p.folded);
    if (live.length === 1) {
      this.returnUncalled();
      this.awardUncontested(live[0]!);
      return;
    }
    const next = this.findToAct(fromSeat, false);
    if (next !== null) {
      this.toAct = next;
      return;
    }
    this.closeBettingRound();
  }

  private closeBettingRound() {
    this.toAct = null;
    for (;;) {
      for (const p of this.players) {
        p.streetBet = 0;
        p.actedAtBet = null;
      }
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      if (this.street === "river") {
        this.returnUncalled();
        this.showdown();
        return;
      }
      this.dealNextStreet();
      if (this.canActCount() >= 2) {
        const first = this.findToAct(this.nextSeat(this.buttonSeat), true);
        if (first !== null) {
          this.toAct = first;
          return;
        }
      } else {
        this.returnUncalled(); // all-in: run it out
      }
    }
  }

  private dealNextStreet() {
    if (this.street === "preflop") {
      this.street = "flop";
      this.board = this.fullBoard.slice(0, 3);
    } else if (this.street === "flop") {
      this.street = "turn";
      this.board = this.fullBoard.slice(0, 4);
    } else if (this.street === "turn") {
      this.street = "river";
      this.board = this.fullBoard.slice(0, 5);
    }
    this.events.push({ type: "deal", street: this.street, board: [...this.board] });
  }

  /** Return the portion of the largest commitment that nobody else matched. */
  private returnUncalled() {
    const sorted = [...this.players].sort((a, b) => b.totalBet - a.totalBet);
    const top = sorted[0]!;
    const second = sorted[1]!;
    const diff = top.totalBet - second.totalBet;
    if (diff > 0) {
      top.totalBet -= diff;
      top.streetBet = Math.max(0, top.streetBet - diff);
      top.stack += diff;
      if (top.stack > 0) top.allIn = false;
      this.events.push({ type: "uncalled", seat: top.seat, amount: diff });
    }
  }

  /** Main pot + side pots from total commitments. */
  computePots(): Pot[] {
    const levels = [...new Set(this.players.filter((p) => !p.folded).map((p) => p.totalBet))]
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    const pots: Pot[] = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of this.players) amount += Math.max(0, Math.min(p.totalBet, level) - prev);
      const eligible = this.players.filter((p) => !p.folded && p.totalBet >= level).map((p) => p.seat);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // any dead money above the highest live level (shouldn't happen after returnUncalled) goes to the last pot
    let dead = 0;
    for (const p of this.players) dead += Math.max(0, p.totalBet - prev);
    if (dead > 0 && pots.length) pots[pots.length - 1]!.amount += dead;
    return pots;
  }

  private awardUncontested(winner: HandPlayer) {
    const amount = this.potTotal;
    winner.stack += amount;
    this.results = [{ amount, eligible: [winner.seat], winners: [{ seat: winner.seat, amount }] }];
    this.events.push({ type: "win", seat: winner.seat, amount, potIndex: 0 });
    this.finish();
  }

  private showdown() {
    this.street = "showdown";
    const live = this.players.filter((p) => !p.folded);
    for (const p of live) {
      const v = evaluateHand([...p.hole, ...this.board]);
      this.showdownHands.set(p.seat, v);
      this.events.push({ type: "show", seat: p.seat, hole: [...p.hole], hand: v.description });
    }
    const pots = this.computePots();
    // odd-chip order: first seat left of the button
    const oddOrder = this.seatsFrom(this.nextSeat(this.buttonSeat));
    pots.forEach((pot, potIndex) => {
      let best = -1;
      let winners: number[] = [];
      for (const s of pot.eligible) {
        const sc = this.showdownHands.get(s)!.score;
        if (sc > best) { best = sc; winners = [s]; }
        else if (sc === best) winners.push(s);
      }
      winners.sort((a, b) => oddOrder.indexOf(a) - oddOrder.indexOf(b));
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      const res: PotResult = { amount: pot.amount, eligible: pot.eligible, winners: [], winningHand: this.showdownHands.get(winners[0]!)!.description };
      for (const s of winners) {
        const amt = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        this.player(s).stack += amt;
        res.winners.push({ seat: s, amount: amt });
        this.events.push({ type: "win", seat: s, amount: amt, potIndex, hand: res.winningHand! });
      }
      this.results.push(res);
    });
    this.finish();
  }

  private finish() {
    this.street = "complete";
    this.toAct = null;
    for (const p of this.players) p.streetBet = 0;
  }

  /** Final stacks by seat (valid once complete). */
  finalStacks(): Map<number, number> {
    return new Map(this.players.map((p) => [p.seat, p.stack]));
  }
}
