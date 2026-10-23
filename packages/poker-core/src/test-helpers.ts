import { standardDeck, type Card } from "./cards.js";

/**
 * Build a stacked deck (TESTS ONLY) so that, with the engine's deal order,
 * seats receive `holes` (listed in deal order: first seat left of the button first)
 * and the board comes out as `board` (5 cards).
 */
export function stackedDeck(holesInDealOrder: string[], board: string): Card[] {
  const holes = holesInDealOrder.map((h) => h.split(" ") as Card[]);
  const b = board.split(" ") as Card[];
  const used = new Set<Card>([...holes.flat(), ...b]);
  const rest = standardDeck().filter((c) => !used.has(c));
  const take = () => rest.shift()!;
  const deck: Card[] = [];
  for (let r = 0; r < 2; r++) for (const h of holes) deck.push(h[r]!);
  deck.push(take(), b[0]!, b[1]!, b[2]!, take(), b[3]!, take(), b[4]!);
  return [...deck, ...rest];
}
