import { RANKS, type Card } from "./cards.js";

export const HAND_CATEGORIES = [
  "High Card",
  "Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

export type HandValue = {
  /** Comparable score: higher is better; equal scores tie exactly. */
  score: number;
  category: HandCategory;
  /** The best 5 cards (ordered by significance). */
  cards: Card[];
  /** Human readable, e.g. "Full House, Kings full of Sevens". */
  description: string;
};

const RANK_NAMES = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
const plural = (r: number) => (r === 4 ? "Sixes" : `${RANK_NAMES[r]}s`);

/** Rank index 0..12 (2..A). */
export function rankOf(card: Card): number {
  const idx = RANKS.indexOf(card[0] as (typeof RANKS)[number]);
  if (idx < 0) throw new Error(`bad card ${card}`);
  return idx;
}
export function suitOf(card: Card): string {
  return card[1]!;
}

function encode(category: number, kickers: number[]): number {
  // category in base-16 most significant digit, then up to 5 rank digits (0..12)
  let s = category;
  for (let i = 0; i < 5; i++) s = s * 16 + (kickers[i] ?? 0);
  return s;
}

/** Evaluate exactly 5 cards. */
export function evaluate5(cards: readonly Card[]): { score: number; category: number; kickers: number[]; ordered: Card[] } {
  if (cards.length !== 5) throw new Error("evaluate5 needs 5 cards");
  const ranks = cards.map(rankOf);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  // count ranks
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // groups sorted by count desc, then rank desc
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniq = [...counts.keys()].sort((a, b) => b - a);
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (uniq[0]! - uniq[4]! === 4) straightHigh = uniq[0]!;
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[4] === 0) straightHigh = 3; // wheel A-2-3-4-5
  }

  let category: number;
  let kickers: number[];
  if (straightHigh >= 0 && flush) {
    category = 8;
    kickers = [straightHigh];
  } else if (groups[0]![1] === 4) {
    category = 7;
    kickers = [groups[0]![0], groups[1]![0]];
  } else if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    category = 6;
    kickers = [groups[0]![0], groups[1]![0]];
  } else if (flush) {
    category = 5;
    kickers = uniq;
  } else if (straightHigh >= 0) {
    category = 4;
    kickers = [straightHigh];
  } else if (groups[0]![1] === 3) {
    category = 3;
    kickers = groups.map((g) => g[0]);
  } else if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    category = 2;
    kickers = groups.map((g) => g[0]);
  } else if (groups[0]![1] === 2) {
    category = 1;
    kickers = groups.map((g) => g[0]);
  } else {
    category = 0;
    kickers = uniq;
  }

  // order the cards by significance for display
  const ordered = [...cards].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    const ca = counts.get(ra)!, cb = counts.get(rb)!;
    if (ca !== cb) return cb - ca;
    if (straightHigh === 3 && (category === 4 || category === 8)) {
      // wheel: ace plays low
      const la = ra === 12 ? -1 : ra, lb = rb === 12 ? -1 : rb;
      return lb - la;
    }
    return rb - ra;
  });
  return { score: encode(category, kickers), category, kickers, ordered };
}

function describe(category: number, k: number[]): string {
  const n = (r: number) => RANK_NAMES[r]!;
  switch (category) {
    case 8: return k[0] === 12 ? "Royal Flush" : `Straight Flush, ${n(k[0]!)} high`;
    case 7: return `Four of a Kind, ${plural(k[0]!)}`;
    case 6: return `Full House, ${plural(k[0]!)} full of ${plural(k[1]!)}`;
    case 5: return `Flush, ${n(k[0]!)} high`;
    case 4: return `Straight, ${n(k[0]!)} high`;
    case 3: return `Three of a Kind, ${plural(k[0]!)}`;
    case 2: return `Two Pair, ${plural(k[0]!)} and ${plural(k[1]!)}`;
    case 1: return `Pair of ${plural(k[0]!)}`;
    default: return `High Card, ${n(k[0]!)}`;
  }
}

/** Best 5-card hand out of 5..7 cards (exhaustive over all 5-card subsets; max 21). */
export function evaluateHand(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error("evaluateHand needs 5..7 cards");
  if (new Set(cards).size !== cards.length) throw new Error("duplicate cards");
  let best: ReturnType<typeof evaluate5> | undefined;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const v = evaluate5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || v.score > best.score) best = v;
          }
  const b = best!;
  return {
    score: b.score,
    category: HAND_CATEGORIES[b.category]!,
    cards: b.ordered,
    description: describe(b.category, b.kickers),
  };
}

/** Compare two hands: >0 if a wins, <0 if b wins, 0 on exact tie. */
export function compareHands(a: readonly Card[], b: readonly Card[]): number {
  return Math.sign(evaluateHand(a).score - evaluateHand(b).score);
}
