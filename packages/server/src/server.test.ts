import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { WebSocket } from "ws";
import { startServer } from "./server.js";
import type { HandRecord, ServerMessage, TableState } from "./protocol.js";
import { verifyHandRecord } from "./verify.js";

type Srv = Awaited<ReturnType<typeof startServer>>;

class Client {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  state: TableState | null = null;
  records: HandRecord[] = [];
  errors: string[] = [];
  private waiters: (() => void)[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      this.msgs.push(m);
      if (m.t === "state") this.state = m;
      if (m.t === "handComplete") this.records.push(m.record);
      if (m.t === "error") this.errors.push(m.message);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  open() { return new Promise<void>((ok, err) => { this.ws.once("open", () => ok()); this.ws.once("error", err); }); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async until(pred: () => boolean, ms = 10_000, what = "condition") {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((ok) => { this.waiters.push(ok); setTimeout(ok, 50); });
    }
  }
  close() { this.ws.close(); }
}

const fast = { turnTimeoutMs: 5000, botDelayMs: [5, 15] as [number, number], nextHandDelayMs: 150 };

describe("game server (HTTP + WebSocket)", () => {
  let srv: Srv;
  before(async () => {
    srv = await startServer({
      port: 0, host: "127.0.0.1", log: () => {},
      tableDefaults: fast,
      tables: [
        { id: "t1", name: "Test 6-max", maxSeats: 6, smallBlind: 5, bigBlind: 10 },
        { id: "bots", name: "Bot table", maxSeats: 6, smallBlind: 5, bigBlind: 10 },
      ],
    });
  });
  after(async () => { await srv.close(); });

  it("serves the browser UI and the API", async () => {
    const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
    assert.match(html, /<title>btcpoker/i);
    const js = await fetch(`http://127.0.0.1:${srv.port}/js/app.js`);
    assert.equal(js.status, 200, "client bundle must be built (npm run build)");
    const tables = await (await fetch(`http://127.0.0.1:${srv.port}/api/tables`)).json() as unknown[];
    assert.equal(tables.length, 2);
    const trav = await fetch(`http://127.0.0.1:${srv.port}/..%2f..%2fpackage.json`);
    assert.notEqual(trav.status, 200);
  });

  it("two humans play a full hand to showdown, and the shuffle verifies", async () => {
    const a = new Client(srv.port), b = new Client(srv.port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: "hello", name: "Alice" });
    b.send({ t: "hello", name: "Bob" });
    await a.until(() => a.msgs.some((m) => m.t === "welcome"));
    await b.until(() => b.msgs.some((m) => m.t === "welcome"));
    a.send({ t: "join", tableId: "t1", buyIn: 1000, method: "lightning" });
    b.send({ t: "join", tableId: "t1", buyIn: 1000, method: "cashu" });

    // wait for the hand to start; commitment must be published before showdown
    await a.until(() => a.state?.street === "preflop", 10_000, "hand start");
    const commitAtStart = a.state!.fairness!.commit;
    assert.match(commitAtStart, /^[0-9a-f]{64}$/);
    assert.equal(a.state!.fairness!.reveal, undefined, "seed must not be revealed during the hand");
    // each player sees only their own hole cards
    const mineA = a.state!.seats.find((s) => s && s.seat === a.state!.you.seat)!;
    const otherA = a.state!.seats.find((s) => s && s.seat !== a.state!.you.seat)!;
    assert.equal(mineA.cards?.length, 2);
    assert.equal(otherA.cards, null);
    assert.equal(otherA.cardCount, 2);

    // play passively (call/check) until the hand completes
    const acted = new WeakSet<object>();
    const step = (c: Client) => {
      const st = c.state;
      if (st?.you.legal && !acted.has(st)) {
        acted.add(st);
        const la = st.you.legal;
        c.send({ t: "action", tableId: "t1", action: la.canCheck ? "check" : "call" });
      }
    };
    await a.until(() => {
      step(a); step(b);
      return a.records.length >= 1;
    }, 15_000, "showdown");
    const rec = a.records[0]!;
    assert.equal(rec.commit, commitAtStart, "revealed hand uses the pre-hand commitment");
    assert.equal(rec.board.length, 5, "hand went to the river");
    assert.ok(rec.events.some((e) => (e as { type: string }).type === "show"), "showdown happened");
    const total = rec.players.reduce((s, p) => s + p.endingStack, 0);
    assert.equal(total, 2000, "chips conserved");
    assert.ok(rec.results[0]!.winners.length >= 1, "pot awarded");

    const v = verifyHandRecord(rec);
    assert.equal(v.ok, true, JSON.stringify(v.checks));
    // and via the public API
    const apiV = await (await fetch(`http://127.0.0.1:${srv.port}/api/tables/t1/hands/${rec.handNumber}/verify`)).json() as { ok: boolean };
    assert.equal(apiV.ok, true);
    // tampering is detected
    const tampered = { ...rec, holes: { ...rec.holes, [String(rec.dealOrderSeats[0])]: ["As", "Ah"] } } as HandRecord;
    const swapped = JSON.stringify(rec.holes[String(rec.dealOrderSeats[0])]) === JSON.stringify(["As", "Ah"]);
    if (!swapped) assert.equal(verifyHandRecord(tampered).ok, false);
    assert.equal(verifyHandRecord({ ...rec, reveal: { ...rec.reveal, seed: "00".repeat(32) } }).ok, false);

    // the browser's independent verifier (pure-JS SHA-256 + Fisher-Yates) must agree with the server implementation
    const browserVerifier = (await import(new URL("../../client/public/js/verify.js", import.meta.url).href)) as {
      verifyInBrowser: (r: unknown) => { ok: boolean; checks: { name: string; ok: boolean }[] };
    };
    const bv = browserVerifier.verifyInBrowser(rec);
    assert.equal(bv.ok, true, JSON.stringify(bv.checks));
    assert.equal(browserVerifier.verifyInBrowser({ ...rec, deck: [...rec.deck].reverse() }).ok, false);

    // leave → cash-out recorded in the (stub) ledger
    a.send({ t: "leave", tableId: "t1", method: "lightning", destination: "lnbc-test" });
    await a.until(() => a.msgs.some((m) => m.t === "info"), 10_000, "leave");
    const ledger = await (await fetch(`http://127.0.0.1:${srv.port}/api/ledger`)).json() as { entries: { kind: string; playerId: string }[] };
    assert.ok(ledger.entries.some((e) => e.kind === "cash-out"), "cash-out recorded");
    assert.ok(ledger.entries.filter((e) => e.kind === "buy-in").length >= 2, "buy-ins recorded");
    a.close(); b.close();
  });

  it("rejects illegal and out-of-turn actions", async () => {
    const c = new Client(srv.port);
    await c.open();
    c.send({ t: "hello", name: "Carol" });
    await c.until(() => c.msgs.some((m) => m.t === "welcome"));
    c.send({ t: "action", tableId: "t1", action: "check" });
    await c.until(() => c.errors.length > 0);
    assert.match(c.errors[0]!, /not seated/);
    c.send({ t: "join", tableId: "t1", buyIn: 5, method: "lightning" });
    await c.until(() => c.errors.length > 1);
    assert.match(c.errors[1]!, /buy-in must be between/);
    c.close();
  });

  it("one human can play solo against bots across several hands", async () => {
    const h = new Client(srv.port);
    await h.open();
    h.send({ t: "hello", name: "Solo" });
    await h.until(() => h.msgs.some((m) => m.t === "welcome"));
    h.send({ t: "join", tableId: "bots", buyIn: 1000, method: "mainchain" });
    await h.until(() => h.state?.you.seat !== null && h.state?.you.seat !== undefined, 5000, "seated");
    h.send({ t: "addBot", tableId: "bots" });
    h.send({ t: "addBot", tableId: "bots" });
    const acted = new WeakSet<object>();
    await h.until(() => {
      const st = h.state;
      if (st?.you.legal && !acted.has(st)) {
        acted.add(st);
        const la = st.you.legal;
        h.send({ t: "action", tableId: "bots", action: la.canCheck ? "check" : "call" });
      }
      return h.records.length >= 5;
    }, 30_000, "5 hands with bots");
    for (const rec of h.records) {
      assert.equal(verifyHandRecord(rec).ok, true);
      const start = rec.players.reduce((s, p) => s + p.startingStack, 0);
      const end = rec.players.reduce((s, p) => s + p.endingStack, 0);
      assert.equal(start, end, "chips conserved each hand");
    }
    const bots = h.state!.seats.filter((s) => s?.isBot);
    assert.equal(bots.length, 2);
    assert.equal(new Set(bots.map((b) => b!.name)).size, 2, "bots get distinct names even when added concurrently");
    h.close();
  });
});
