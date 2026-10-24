import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAMERA_VIEWS, DEFAULT_VIEW, nextView, parseView, seatRadii, viewForKey } from "./view.js";

describe("camera views", () => {
  it("has exactly standard, overhead and pov on keys 1/2/3", () => {
    assert.deepEqual(CAMERA_VIEWS.map((v) => [v.id, v.key]), [["standard", "1"], ["overhead", "2"], ["pov", "3"]]);
    assert.equal(viewForKey("1"), "standard");
    assert.equal(viewForKey("2"), "overhead");
    assert.equal(viewForKey("3"), "pov");
    assert.equal(viewForKey("4"), null);
    assert.equal(viewForKey("f"), null);
  });
  it("parses persisted values and falls back to the default", () => {
    assert.equal(parseView("pov"), "pov");
    assert.equal(parseView("overhead"), "overhead");
    assert.equal(parseView(null), DEFAULT_VIEW);
    assert.equal(parseView("isometric"), DEFAULT_VIEW);
  });
  it("cycles through all views", () => {
    assert.equal(nextView("standard"), "overhead");
    assert.equal(nextView("overhead"), "pov");
    assert.equal(nextView("pov"), "standard");
  });
  it("keeps every seat ring inside the felt", () => {
    for (const v of CAMERA_VIEWS) {
      const r = seatRadii(v.id);
      for (const [rx, ry] of [r.seat, r.bet, r.dealer]) { assert.ok(rx <= 50 && ry <= 60); }
    }
  });
});
