// Wire types mirrored from @btcpoker/server/src/protocol.ts (kept dependency-free for the browser build).
export type Card = string;
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";
export type PaymentMethod = "mainchain" | "lightning" | "cashu";
export type LegalActions = {
  seat: number; toCall: number; canFold: boolean; canCheck: boolean; canCall: boolean;
  canBet: boolean; canRaise: boolean; minTo: number; maxTo: number;
};
export type TableSummary = {
  id: string; name: string; maxSeats: number; smallBlind: number; bigBlind: number;
  minBuyIn: number; maxBuyIn: number; players: number; handNumber: number;
};
export type SeatView = {
  seat: number; name: string; playerId: string; stack: number; isBot: boolean; sittingOut: boolean;
  connected: boolean; inHand: boolean; folded: boolean; allIn: boolean; streetBet: number;
  cards: Card[] | null; cardCount: number; lastAction: string | null; isWinner: boolean; handDescription: string | null;
};
export type Reveal = { seed: string; nonce: string; commit: string };
export type FairnessView = { handNumber: number; commit: string; reveal?: Reveal };
export type PaymentMethodInfo = { id: PaymentMethod; label: string; isStub: boolean };
export type TableState = {
  t: "state"; table: TableSummary; seats: (SeatView | null)[]; buttonSeat: number;
  sbSeat: number | null; bbSeat: number | null; street: string; board: Card[]; pot: number;
  pots: { amount: number; eligible: number[] }[]; toAct: number | null; turnDeadline: number | null;
  you: { playerId: string; seat: number | null; legal: LegalActions | null; stack: number };
  fairness: FairnessView | null; lastHand: FairnessView | null;
  winners: { seat: number; amount: number; hand?: string }[]; log: string[];
  paymentMethods: PaymentMethodInfo[];
};
export type HandRecord = {
  tableId: string; handNumber: number; buttonSeat: number; dealOrderSeats: number[];
  commit: string; reveal: Reveal; deck: Card[]; holes: Record<string, Card[]>; board: Card[];
  players: { seat: number; name: string; startingStack: number; endingStack: number }[];
  shuffleAlgorithm: string;
};
export type ServerMessage =
  | { t: "welcome"; playerId: string; token: string; name: string }
  | { t: "lobby"; tables: TableSummary[]; paymentMethods: PaymentMethodInfo[] }
  | TableState
  | { t: "error"; message: string }
  | { t: "info"; message: string }
  | { t: "handComplete"; tableId: string; record: HandRecord };
