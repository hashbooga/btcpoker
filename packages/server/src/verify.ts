import { verifyReveal, revealBytes } from "@btcpoker/rng";
import { deckFromCommitment, dealOrder, type Card } from "@btcpoker/poker-core";
import type { HandRecord } from "./protocol.js";

export const SHUFFLE_ALGORITHM =
  "fisher-yates(standard deck 2c..As rank-major) driven by secureRandomInt over SHA-256(\"btcpoker/deck/v1\"||seed||nonce||u32be ctr) stream; deal: holes 1-at-a-time from left of button x2, burn, flop3, burn, turn, burn, river";

export type VerifyResult = { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] };

/** Independently verify a published hand record. */
export function verifyHandRecord(rec: HandRecord): VerifyResult {
  const checks: VerifyResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push(detail === undefined ? { name, ok } : { name, ok, detail });

  add("reveal matches the pre-hand commitment (SHA-256(seed||nonce))", rec.reveal.commit === rec.commit && verifyReveal(rec.reveal));
  let deck: Card[] = [];
  try {
    const { seed, nonce } = revealBytes(rec.reveal);
    deck = deckFromCommitment(seed, nonce);
    add("deck re-derived from revealed seed equals published deck", JSON.stringify(deck) === JSON.stringify(rec.deck));
  } catch (e) {
    add("deck re-derived from revealed seed equals published deck", false, String(e));
  }
  if (deck.length === 52) {
    const { holes, board } = dealOrder(deck, rec.dealOrderSeats);
    let holesOk = true;
    for (const [seat, cards] of Object.entries(rec.holes)) {
      if (JSON.stringify(holes.get(Number(seat))) !== JSON.stringify(cards)) holesOk = false;
    }
    add("every player's hole cards match the committed deck", holesOk && Object.keys(rec.holes).length === rec.dealOrderSeats.length);
    add("board matches the committed deck", JSON.stringify(board.slice(0, rec.board.length)) === JSON.stringify(rec.board));
  }
  return { ok: checks.every((c) => c.ok), checks };
}
