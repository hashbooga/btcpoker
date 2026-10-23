import { secureRandomInt } from "@btcpoker/rng";
import { evaluateHand, rankOf, suitOf, type Card, type Hand, type LegalActions, type PlayerAction } from "@btcpoker/poker-core";

/** Rough preflop strength 0..1 (simplified Chen-style). */
export function preflopStrength(hole: Card[]): number {
  const [a, b] = hole as [Card, Card];
  const ra = rankOf(a), rb = rankOf(b);
  const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  let s = (hi + 2) / 14 * 0.5; // high card value
  if (ra === rb) s = 0.55 + (ra / 12) * 0.45;
  else {
    if (suitOf(a) === suitOf(b)) s += 0.08;
    const gap = hi - lo;
    if (gap === 1) s += 0.07;
    else if (gap === 2) s += 0.04;
    else if (gap >= 4) s -= 0.06;
    if (lo >= 8) s += 0.12; // both broadway
  }
  return Math.max(0, Math.min(1, s));
}

/** Rough postflop strength 0..1 from made-hand category, discounted when the board plays. */
export function postflopStrength(hole: Card[], board: Card[]): number {
  const mine = evaluateHand([...hole, ...board]);
  const cats = ["High Card", "Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", "Straight Flush"];
  let cat = cats.indexOf(mine.category);
  if (board.length >= 5) {
    const boardOnly = evaluateHand(board);
    if (boardOnly.score === mine.score) cat = Math.max(0, cat - 2); // playing the board
  }
  if (mine.category === "Pair") {
    // top pair-ish bonus
    const pairRank = rankOf(mine.cards[0]!);
    const boardHigh = Math.max(...board.map(rankOf));
    const usesHole = hole.some((c) => rankOf(c) === pairRank);
    if (!usesHole) return 0.2;
    return pairRank >= boardHigh ? 0.55 : 0.4;
  }
  return [0.15, 0.4, 0.7, 0.8, 0.85, 0.88, 0.95, 0.99, 1][cat]!;
}

const pct = () => secureRandomInt(100); // fairness-grade randomness everywhere, per project rules

/** Choose a legal action for the bot in `seat`. Simple, loose-aggressive-ish, never illegal. */
export function chooseBotAction(hand: Hand, seat: number, la: LegalActions): PlayerAction {
  const me = hand.player(seat);
  const strength = hand.street === "preflop" ? preflopStrength(me.hole) : postflopStrength(me.hole, hand.board);
  const pot = hand.potTotal;
  const potOdds = la.toCall / Math.max(1, pot + la.toCall);
  const canAggress = la.canBet || la.canRaise;

  const sizeTo = (fractionOfPot: number) => {
    const target = hand.currentBet + Math.round((pot + la.toCall) * fractionOfPot);
    return Math.max(la.minTo, Math.min(la.maxTo, target));
  };
  const aggress = (frac: number): PlayerAction => ({ type: la.canBet ? "bet" : "raise", amount: sizeTo(frac) });
  const passive = (): PlayerAction => (la.canCheck ? { type: "check" } : { type: "call" });

  if (strength >= 0.85) {
    if (canAggress && pct() < 80) return pct() < 15 ? { type: "allin" } : aggress(0.75);
    return passive();
  }
  if (strength >= 0.6) {
    if (canAggress && pct() < 45) return aggress(0.6);
    if (la.canCheck) return { type: "check" };
    return potOdds < 0.45 ? { type: "call" } : pct() < 40 ? { type: "call" } : { type: "fold" };
  }
  if (strength >= 0.4) {
    if (la.canCheck) return canAggress && pct() < 15 ? aggress(0.5) : { type: "check" };
    return potOdds < 0.3 ? { type: "call" } : { type: "fold" };
  }
  // weak
  if (la.canCheck) return canAggress && pct() < 8 ? aggress(0.5) : { type: "check" };
  if (potOdds < 0.12 && pct() < 60) return { type: "call" };
  return { type: "fold" };
}

const BOT_NAMES = ["Hal", "Nakamoto Bot", "Szabo", "Finney", "Back", "Wuille", "Maxwell", "Todd", "Poon", "Dryja"];
export function botName(taken: Set<string>): string {
  for (const n of BOT_NAMES) if (!taken.has(`🤖 ${n}`)) return `🤖 ${n}`;
  return `🤖 Bot ${taken.size + 1}`;
}
