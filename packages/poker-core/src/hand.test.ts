import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secureRandomInt } from "@btcpoker/rng";
import { Hand, IllegalActionError } from "./hand.js";
import { Table } from "./table.js";
import { shuffledDeck } from "./deal.js";
import { stackedDeck } from "./test-helpers.js";

const P = (seat: number, stack: number) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack });
const total = (h: Hand) => h.players.reduce((s, p) => s + p.stack, 0);

describe("blinds and action order", () => {
  it("3-handed: SB/BB left of button, UTG (button) acts first preflop", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    assert.equal(h.sbSeat, 1);
    assert.equal(h.bbSeat, 2);
    assert.equal(h.player(1).streetBet, 5);
    assert.equal(h.player(2).streetBet, 10);
    assert.equal(h.toAct, 0);
    assert.equal(h.potTotal, 15);
    for (const p of h.players) assert.equal(p.hole.length, 2);
  });

  it("heads-up: button posts SB and acts first preflop, last postflop", () => {
    const h = new Hand({ players: [P(2, 1000), P(5, 1000)], buttonSeat: 5, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    assert.equal(h.sbSeat, 5);
    assert.equal(h.bbSeat, 2);
    assert.equal(h.toAct, 5);
    h.act(5, { type: "call" });
    assert.equal(h.toAct, 2, "BB has the option");
    const la = h.legalActions()!;
    assert.equal(la.canCheck, true);
    assert.equal(la.canRaise, true);
    h.act(2, { type: "check" });
    assert.equal(h.street, "flop");
    assert.equal(h.board.length, 3);
    assert.equal(h.toAct, 2, "BB (non-button) acts first postflop");
  });

  it("BB option: limpers, BB may raise and action reopens", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    h.act(0, { type: "call" });
    h.act(1, { type: "call" });
    assert.equal(h.toAct, 2);
    h.act(2, { type: "raise", amount: 40 });
    assert.equal(h.toAct, 0);
    assert.equal(h.legalActions()!.toCall, 30);
  });

  it("rejects out-of-turn and illegal actions", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    assert.throws(() => h.act(1, { type: "call" }), IllegalActionError);
    assert.throws(() => h.act(0, { type: "check" }), /cannot check/);
    assert.throws(() => h.act(0, { type: "bet", amount: 50 }), /raise instead/);
  });

  it("everyone folds to the BB: BB wins blinds, uncalled returned", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    h.act(0, { type: "fold" });
    h.act(1, { type: "fold" });
    assert.equal(h.isComplete, true);
    assert.equal(h.player(2).stack, 1005);
    assert.equal(h.player(1).stack, 995);
    assert.equal(total(h), 3000);
  });
});

describe("min-raise rules", () => {
  it("raise must be at least the previous raise increment", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    let la = h.legalActions()!;
    assert.equal(la.minTo, 20);
    assert.throws(() => h.act(0, { type: "raise", amount: 15 }), /minimum raise is to 20/);
    h.act(0, { type: "raise", amount: 35 }); // +25
    la = h.legalActions()!;
    assert.equal(la.minTo, 60);
    assert.throws(() => h.act(1, { type: "raise", amount: 55 }), /minimum/);
    h.act(1, { type: "raise", amount: 60 });
    assert.equal(h.legalActions()!.minTo, 85);
  });

  it("postflop min bet is the big blind; min-raise resets each street", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    h.act(0, { type: "raise", amount: 100 });
    h.act(1, { type: "call" });
    assert.equal(h.street, "flop");
    const la = h.legalActions()!;
    assert.equal(la.canBet, true);
    assert.equal(la.minTo, 10);
    assert.throws(() => h.act(1, { type: "bet", amount: 5 }), /minimum bet/);
    h.act(1, { type: "bet", amount: 10 });
    assert.equal(h.legalActions()!.minTo, 20);
  });

  it("short all-in raise does not reopen betting for players who already acted", () => {
    // seats: 0 button, 1 SB, 2 BB, 3 UTG. Flop: 1 bets 100, 2 shoves 150 (short), 3 calls, 1 may only call/fold.
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 160), P(3, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    h.act(3, { type: "call" });
    h.act(0, { type: "fold" });
    h.act(1, { type: "call" });
    h.act(2, { type: "check" });
    assert.equal(h.street, "flop");
    assert.equal(h.toAct, 1);
    h.act(1, { type: "bet", amount: 100 });
    h.act(2, { type: "allin" }); // to 150: only +50, less than a full raise
    assert.equal(h.player(2).allIn, true);
    assert.equal(h.currentBet, 150);
    const la3 = h.legalActions()!;
    assert.equal(la3.seat, 3);
    assert.equal(la3.canRaise, true, "player 3 has not acted yet and may raise");
    assert.equal(la3.minTo, 250, "min-raise still based on the last full raise (100)");
    h.act(3, { type: "call" });
    const la1 = h.legalActions()!;
    assert.equal(la1.seat, 1);
    assert.equal(la1.canRaise, false, "betting not reopened for the original bettor");
    assert.equal(la1.toCall, 50);
    assert.throws(() => h.act(1, { type: "raise", amount: 400 }), /raising not allowed/);
    h.act(1, { type: "call" });
    assert.equal(h.street, "turn");
  });

  it("multiple short all-ins that add up to a full raise do reopen", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 160), P(3, 220)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    h.act(3, { type: "call" });
    h.act(0, { type: "call" });
    h.act(1, { type: "call" });
    h.act(2, { type: "check" });
    h.act(1, { type: "bet", amount: 100 }); // flop: 1 bets 100
    h.act(2, { type: "allin" }); // to 150 (short)
    h.act(3, { type: "allin" }); // to 210 (short, but cumulatively +110 >= 100 vs player 1)
    const la0 = h.legalActions()!;
    assert.equal(la0.seat, 0);
    assert.equal(la0.canRaise, true);
    h.act(0, { type: "call" });
    const la1 = h.legalActions()!;
    assert.equal(la1.seat, 1);
    assert.equal(la1.canRaise, true, "reopened: total raise since player 1 acted is a full raise");
  });

  it("BB short all-in: callers still owe the full big blind", () => {
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 4)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: shuffledDeck() });
    assert.equal(h.player(2).allIn, true);
    assert.equal(h.legalActions()!.toCall, 10);
  });
});

describe("side pots and showdown", () => {
  it("three-way all-in builds main + side pot and refunds the uncalled excess", () => {
    // button 0, SB 1, BB 2. Deal order: 1, 2, 0
    const deck = stackedDeck(["Ac Ad", "Kc Kd", "Qc Qd"], "2s 7h 9d Jc 3s");
    const h = new Hand({ players: [P(0, 500), P(1, 100), P(2, 300)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    h.act(0, { type: "allin" });
    h.act(1, { type: "allin" });
    h.act(2, { type: "allin" });
    assert.equal(h.isComplete, true);
    assert.equal(h.board.length, 5);
    // seat1 (AA) wins main 300; seat2 (KK) wins side 400; seat0 (QQ) gets 200 uncalled back
    assert.deepEqual(h.results.map((r) => r.amount), [300, 400]);
    assert.equal(h.player(1).stack, 300);
    assert.equal(h.player(2).stack, 400);
    assert.equal(h.player(0).stack, 200);
    assert.ok(h.events.some((e) => e.type === "uncalled" && e.seat === 0 && e.amount === 200), "uncalled event");
    assert.equal(total(h), 900);
  });

  it("folded players' chips stay in the pot but they are not eligible", () => {
    const deck = stackedDeck(["Ac Ad", "Kc Kd", "7c 2d"], "2s 7h 9d Jc 3s");
    const h = new Hand({ players: [P(0, 500), P(1, 100), P(2, 300)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    h.act(0, { type: "raise", amount: 50 });
    h.act(1, { type: "allin" }); // 100
    h.act(2, { type: "allin" }); // 300
    h.act(0, { type: "fold" });
    assert.equal(h.isComplete, true);
    // main: 100*2 + 50 (folded) = 250 → seat1; side: 200 from seat2 uncalled → refund
    assert.equal(h.player(1).stack, 250);
    assert.equal(h.player(2).stack, 200);
    assert.equal(h.player(0).stack, 450);
    assert.equal(total(h), 900);
  });

  it("split pot with odd chip goes to first seat left of the button", () => {
    // board plays (broadway); both tie
    const deck = stackedDeck(["2c 3d", "4h 2d", "5c 3h"], "Ac Kd Qh Js Tc");
    const h = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    h.act(0, { type: "fold" }); // folds 0 chips; pot = 15 → force odd amounts below
    h.act(1, { type: "raise", amount: 21 });
    h.act(2, { type: "call" });
    // flop/turn/river: check down
    while (!h.isComplete) h.act(h.toAct!, { type: "check" });
    assert.equal(h.potTotal, 42);
    assert.equal(h.player(1).stack, 1000);
    assert.equal(h.player(2).stack, 1000);
    // now an odd pot
    const deck2 = stackedDeck(["2c 3d", "4h 2d", "5c 3h"], "Ac Kd Qh Js Tc");
    const h2 = new Hand({ players: [P(0, 1000), P(1, 1000), P(2, 1000)], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: deck2 });
    h2.act(0, { type: "call" });
    h2.act(1, { type: "fold" }); // 5 dead chips → pot 25 between seat 2 and 0
    h2.act(2, { type: "check" });
    while (!h2.isComplete) h2.act(h2.toAct!, { type: "check" });
    // first seat left of button among winners is seat 2 → gets 13, seat 0 gets 12
    assert.equal(h2.player(2).stack, 1003);
    assert.equal(h2.player(0).stack, 1002);
    assert.equal(total(h2), 3000);
  });

  it("best hand wins at showdown and shows hand descriptions", () => {
    const deck = stackedDeck(["Ah Kh", "Qs Qd"], "Qh Jh Th 2c 3d");
    const h = new Hand({ players: [P(0, 1000), P(1, 1000)], buttonSeat: 1, smallBlind: 5, bigBlind: 10, deck });
    // heads-up: deal order starts left of button = seat 0
    h.act(1, { type: "call" });
    h.act(0, { type: "check" });
    while (!h.isComplete) h.act(h.toAct!, { type: "check" });
    assert.equal(h.results[0]!.winningHand, "Royal Flush");
    assert.equal(h.player(0).stack, 1010);
  });
});

describe("fuzz: random legal play conserves chips and terminates", () => {
  it("plays 400 random hands on a 6-max table (busted players rebuy)", () => {
    const t = new Table({ maxSeats: 6, smallBlind: 1, bigBlind: 2 });
    for (let s = 0; s < 6; s++) t.sit(s, { id: `p${s}`, name: `P${s}`, stack: 50 + secureRandomInt(300), sittingOut: false, isBot: true });
    const chips = () => t.seats.reduce((a, s) => a + (s?.stack ?? 0), 0);
    let expected = chips();
    let showdowns = 0;
    for (let i = 0; i < 400; i++) {
      for (const s of t.seats) if (s && s.stack === 0) { s.stack = 100; expected += 100; }
      const h = t.startHand(shuffledDeck());
      let guard = 0;
      while (!h.isComplete) {
        assert.ok(guard++ < 500, "hand did not terminate");
        const la = h.legalActions()!;
        const r = secureRandomInt(10);
        if (r === 0) h.act(la.seat, { type: "fold" });
        else if (r < 3 && (la.canBet || la.canRaise)) {
          const to = la.minTo + secureRandomInt(la.maxTo - la.minTo + 1);
          h.act(la.seat, { type: la.canBet ? "bet" : "raise", amount: to });
        } else if (r === 3) {
          try { h.act(la.seat, { type: "allin" }); } catch { h.act(la.seat, { type: "fold" }); }
        } else h.act(la.seat, { type: la.canCheck ? "check" : "call" });
      }
      if (h.showdownHands.size > 0) showdowns++;
      for (const p of h.players) assert.ok(p.stack >= 0, `negative stack seat ${p.seat}`);
      t.settleHand();
      assert.equal(chips(), expected, `chip conservation failed on hand ${i}`);
    }
    assert.ok(showdowns > 0, "expected at least one showdown");
  });
});

describe("table", () => {
  it("rotates the button and skips busted/sitting-out players", () => {
    const t = new Table({ maxSeats: 6, smallBlind: 5, bigBlind: 10 });
    t.sit(1, { id: "a", name: "A", stack: 100, sittingOut: false, isBot: false });
    t.sit(3, { id: "b", name: "B", stack: 100, sittingOut: false, isBot: false });
    t.sit(4, { id: "c", name: "C", stack: 0, sittingOut: false, isBot: false });
    t.sit(5, { id: "d", name: "D", stack: 100, sittingOut: true, isBot: false });
    const fold = () => { const h = t.hand!; while (!h.isComplete) h.act(h.toAct!, { type: "fold" }); t.settleHand(); };
    t.startHand(shuffledDeck());
    assert.equal(t.buttonSeat, 1);
    assert.deepEqual(t.hand!.players.map((p) => p.seat), [1, 3]);
    fold();
    t.startHand(shuffledDeck());
    assert.equal(t.buttonSeat, 3);
    fold();
    t.startHand(shuffledDeck());
    assert.equal(t.buttonSeat, 1);
    assert.throws(() => t.sit(1, { id: "z", name: "Z", stack: 1, sittingOut: false, isBot: false }), /seat taken/);
  });
});
