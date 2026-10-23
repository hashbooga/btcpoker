import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card } from "./cards.js";
import { evaluateHand, compareHands } from "./evaluator.js";

const h = (s: string) => s.split(" ") as Card[];

describe("hand evaluator: categories", () => {
  const cases: [string, string][] = [
    ["Ah Kh Qh Jh Th 2c 3d", "Straight Flush"],
    ["5s 4s 3s 2s As Kd Kc", "Straight Flush"],
    ["9c 9d 9h 9s 2c 3d 4h", "Four of a Kind"],
    ["Kc Kd Kh 7s 7c 2d 3h", "Full House"],
    ["Kc Kd Kh 7s 7c 7d 3h", "Full House"],
    ["2h 7h 9h Jh Kh Ac Ad", "Flush"],
    ["5c 6d 7h 8s 9c Kd Kh", "Straight"],
    ["Ac 2d 3h 4s 5c Kd Qh", "Straight"],
    ["Qc Qd Qh 7s 2c 3d 9h", "Three of a Kind"],
    ["Qc Qd 7h 7s 2c 3d 9h", "Two Pair"],
    ["Qc Qd 7h 6s 2c 3d 9h", "Pair"],
    ["Ac Qd 7h 6s 2c 3d 9h", "High Card"],
  ];
  for (const [cards, cat] of cases) {
    it(`${cards} => ${cat}`, () => assert.equal(evaluateHand(h(cards)).category, cat));
  }

  it("names a royal flush", () => {
    assert.equal(evaluateHand(h("Ah Kh Qh Jh Th 2c 3d")).description, "Royal Flush");
  });

  it("category ordering is strict", () => {
    const order = [
      "Ac Qd 7h 6s 2c 3d 9h", "Qc Qd 7h 6s 2c 3d 9h", "Qc Qd 7h 7s 2c 3d 9h", "Qc Qd Qh 7s 2c 3d 9h",
      "5c 6d 7h 8s 9c Kd Kh", "2h 7h 9h Jh Kh Ac Ad", "Kc Kd Kh 7s 7c 2d 3h", "9c 9d 9h 9s 2c 3d 4h",
      "Ah Kh Qh Jh Th 2c 3d",
    ];
    for (let i = 1; i < order.length; i++) assert.equal(compareHands(h(order[i]!), h(order[i - 1]!)), 1);
  });
});

describe("hand evaluator: tie-breaking", () => {
  it("wheel loses to six-high straight", () => {
    assert.equal(compareHands(h("Ac 2d 3h 4s 5c"), h("2d 3h 4s 5c 6d")), -1);
  });
  it("steel wheel is a straight flush, 5 high, loses to 6-high SF", () => {
    assert.equal(compareHands(h("As 2s 3s 4s 5s"), h("2h 3h 4h 5h 6h")), -1);
  });
  it("broadway beats king-high straight", () => {
    assert.equal(compareHands(h("Ac Kd Qh Js Tc"), h("Kd Qh Js Tc 9c")), 1);
  });
  it("pair kickers matter", () => {
    assert.equal(compareHands(h("Ac Ad Kh 7s 3c"), h("Ah As Qh Js Tc")), 1);
    assert.equal(compareHands(h("Ac Ad Kh 7s 4c"), h("Ah As Kd 7c 3c")), 1);
  });
  it("two pair: top pair, then second pair, then kicker", () => {
    assert.equal(compareHands(h("Kc Kd 2h 2s Ac"), h("Qc Qd Jh Js Ac")), 1);
    assert.equal(compareHands(h("Kc Kd 3h 3s 2c"), h("Kh Ks 2h 2s Ac")), 1);
    assert.equal(compareHands(h("Kc Kd 3h 3s 5c"), h("Kh Ks 3d 3c 4c")), 1);
  });
  it("best two pair chosen from three pairs", () => {
    // board has three pairs; kicker can be the third pair's card
    const v = evaluateHand(h("Kc Kd Qh Qs 2c 2d 3h"));
    assert.equal(v.description, "Two Pair, Kings and Queens");
    assert.equal(compareHands(h("Kc Kd Qh Qs 2c 2d 3h"), h("Kc Kd Qh Qs 2c 2d Ah")), -1);
  });
  it("full house: trips rank first", () => {
    assert.equal(compareHands(h("3c 3d 3h 2s 2c"), h("2d 2h 2s Ac Ad")), 1);
    // two sets on board: best full house is higher trips full of the lower
    assert.equal(evaluateHand(h("9c 9d 9h 5s 5c 5d Kh")).description, "Full House, Nines full of Fives");
  });
  it("quads kicker", () => {
    assert.equal(compareHands(h("9c 9d 9h 9s Ac"), h("9c 9d 9h 9s Kc")), 1);
  });
  it("flush compares all five cards", () => {
    assert.equal(compareHands(h("Ah Jh 9h 6h 3h"), h("Ad Jd 9d 6d 2d")), 1);
  });
  it("high card compares all five cards", () => {
    assert.equal(compareHands(h("Ac Qd 9h 7s 4c"), h("Ad Qh 9c 7d 3c")), 1);
  });
  it("exact ties (board plays) split", () => {
    const board = "Ac Kd Qh Js Tc";
    assert.equal(compareHands(h(`${board} 2c 3d`), h(`${board} 4h 5h`)), 0);
  });
  it("suits never break ties", () => {
    assert.equal(compareHands(h("Ac Kc Qc Jc 9d"), h("Ad Kd Qd Jd 9c")), 0);
  });
  it("7-card picks the flush over a straight", () => {
    assert.equal(evaluateHand(h("4h 5h 6h 7c 8h Kh 2d")).category, "Flush");
  });
  it("ordered cards show the wheel ace-low", () => {
    assert.deepEqual(evaluateHand(h("Ac 2d 3h 4s 5c Kd 9h")).cards, h("5c 4s 3h 2d Ac"));
  });
  it("rejects duplicates", () => {
    assert.throws(() => evaluateHand(h("Ac Ac 3h 4s 5c")));
  });
});
