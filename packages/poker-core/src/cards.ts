export const SUITS = ["c", "d", "h", "s"] as const;
export const RANKS = [
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
export type Card = `${Rank}${Suit}`;

export function standardDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}
