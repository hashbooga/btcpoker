import type { ActionType, Card, LegalActions, Street } from "@btcpoker/poker-core";
import type { CommitRevealReveal } from "@btcpoker/rng";
import type { PaymentMethod } from "@btcpoker/payments";

// ---------- client -> server ----------
export type ClientMessage =
  | { t: "hello"; name: string; playerId?: string; token?: string }
  | { t: "join"; tableId: string; seat?: number; buyIn: number; method: PaymentMethod }
  | { t: "action"; tableId: string; action: ActionType; amount?: number }
  | { t: "leave"; tableId: string; method?: PaymentMethod; destination?: string }
  | { t: "rebuy"; tableId: string; amount: number; method: PaymentMethod }
  | { t: "sitOut"; tableId: string; value: boolean }
  | { t: "addBot"; tableId: string }
  | { t: "removeBot"; tableId: string }
  | { t: "watch"; tableId: string }
  | { t: "lobby" };

// ---------- server -> client ----------
export type TableSummary = {
  id: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  players: number;
  handNumber: number;
};

export type SeatView = {
  seat: number;
  name: string;
  playerId: string;
  stack: number;
  isBot: boolean;
  sittingOut: boolean;
  connected: boolean;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  streetBet: number;
  /** Visible hole cards (your own, or everyone's at showdown). */
  cards: Card[] | null;
  cardCount: number;
  lastAction: string | null;
  isWinner: boolean;
  handDescription: string | null;
};

export type FairnessView = {
  handNumber: number;
  commit: string;
  /** Only present after the hand completes. */
  reveal?: CommitRevealReveal;
};

export type TableState = {
  t: "state";
  table: TableSummary;
  seats: (SeatView | null)[];
  buttonSeat: number;
  sbSeat: number | null;
  bbSeat: number | null;
  street: Street | "waiting";
  board: Card[];
  pot: number;
  pots: { amount: number; eligible: number[] }[];
  toAct: number | null;
  turnDeadline: number | null;
  you: { playerId: string; seat: number | null; legal: LegalActions | null; stack: number };
  fairness: FairnessView | null;
  lastHand: FairnessView | null;
  winners: { seat: number; amount: number; hand?: string }[];
  log: string[];
  paymentMethods: { id: PaymentMethod; label: string; isStub: boolean }[];
};

export type ServerMessage =
  | { t: "welcome"; playerId: string; token: string; name: string }
  | { t: "lobby"; tables: TableSummary[]; paymentMethods: { id: PaymentMethod; label: string; isStub: boolean }[] }
  | TableState
  | { t: "error"; message: string }
  | { t: "info"; message: string }
  | { t: "handComplete"; tableId: string; record: HandRecord };

/** Full public record of a finished hand, enough to independently verify the shuffle. */
export type HandRecord = {
  tableId: string;
  handNumber: number;
  startedAt: string;
  endedAt: string;
  smallBlind: number;
  bigBlind: number;
  buttonSeat: number;
  players: { seat: number; name: string; startingStack: number; endingStack: number }[];
  /** Seats in the order cards were dealt (first seat left of the button). */
  dealOrderSeats: number[];
  /** Commitment published before any card was dealt. */
  commit: string;
  /** Revealed preimage (hex). */
  reveal: CommitRevealReveal;
  /** Full deck order produced by the shuffle (revealed after the hand). */
  deck: Card[];
  holes: Record<string, Card[]>;
  /** Board cards actually dealt in this hand (0, 3, 4 or 5). */
  board: Card[];
  events: unknown[];
  results: { amount: number; eligible: number[]; winners: { seat: number; amount: number }[]; winningHand?: string }[];
  /** Algorithm identifier so verifiers know how to replay. */
  shuffleAlgorithm: string;
};
