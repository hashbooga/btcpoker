import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Cashier, cashuStub, lightningStub, mainchainStub, type PaymentAdapter } from "@btcpoker/payments";
import { IllegalActionError } from "@btcpoker/poker-core";
import { GameTable, type GameTableOptions } from "./game-table.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { verifyHandRecord } from "./verify.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATIC_DIR = resolve(here, "../../client/public");

export type ServerOptions = {
  port?: number;
  host?: string;
  staticDir?: string;
  adapters?: PaymentAdapter[];
  tables?: Omit<GameTableOptions, "cashier" | "onUpdate" | "onHandComplete">[];
  tableDefaults?: Partial<Pick<GameTableOptions, "turnTimeoutMs" | "botDelayMs" | "nextHandDelayMs">>;
  log?: (msg: string) => void;
};

export const DEFAULT_TABLES: NonNullable<ServerOptions["tables"]> = [
  { id: "satoshi", name: "Satoshi's Table (6-max)", maxSeats: 6, smallBlind: 5, bigBlind: 10 },
  { id: "hal", name: "Hal's Heads-Up", maxSeats: 2, smallBlind: 10, bigBlind: 20 },
  { id: "genesis", name: "Genesis Block (9-max)", maxSeats: 9, smallBlind: 25, bigBlind: 50 },
];

type Session = { playerId: string; token: string; name: string; sockets: Set<WebSocket>; watching: string | null };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".map": "application/json",
};

export async function startServer(opts: ServerOptions = {}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  const staticDir = opts.staticDir ?? DEFAULT_STATIC_DIR;
  const cashier = new Cashier({ adapters: opts.adapters ?? [lightningStub, cashuStub, mainchainStub] });
  const paymentMethods = cashier.methods();
  const sessions = new Map<string, Session>();
  const tables = new Map<string, GameTable>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  const lobbyMsg = (): ServerMessage => ({ t: "lobby", tables: [...tables.values()].map((t) => t.summary()), paymentMethods });

  const broadcastTable = (table: GameTable) => {
    for (const s of sessions.values()) {
      if (s.watching !== table.id) continue;
      const view = table.viewFor(s.playerId, paymentMethods);
      for (const ws of s.sockets) send(ws, view);
    }
    for (const s of sessions.values()) if (s.watching === null) for (const ws of s.sockets) send(ws, lobbyMsg());
  };

  for (const cfg of opts.tables ?? DEFAULT_TABLES) {
    const t: GameTable = new GameTable({
      ...opts.tableDefaults,
      ...cfg,
      cashier,
      onUpdate: () => broadcastTable(t),
      onHandComplete: (rec) => {
        for (const s of sessions.values()) if (s.watching === t.id) for (const ws of s.sockets) send(ws, { t: "handComplete", tableId: t.id, record: rec });
      },
    });
    tables.set(t.id, t);
  }

  // ------------------------------------------------------------- HTTP
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  };

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/api/health") return json(res, 200, { ok: true });
    if (path === "/api/tables") return json(res, 200, [...tables.values()].map((t) => t.summary()));
    const m = path.match(/^\/api\/tables\/([\w-]+)\/hands(?:\/(\d+))?(\/verify)?$/);
    if (m) {
      const t = tables.get(m[1]!);
      if (!t) return json(res, 404, { error: "no such table" });
      if (!m[2]) return json(res, 200, t.history.map((h) => ({ handNumber: h.handNumber, commit: h.commit, endedAt: h.endedAt })));
      const rec = t.history.find((h) => h.handNumber === Number(m[2]));
      if (!rec) return json(res, 404, { error: "hand not found (only completed hands are published)" });
      if (m[3]) return json(res, 200, verifyHandRecord(rec));
      return json(res, 200, rec);
    }
    if (path === "/api/ledger") return json(res, 200, { note: "PLAY MONEY ONLY: stub adapters, no bitcoin moves", entries: cashier.ledger });
    if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });

    // static files
    const rel = path === "/" ? "/index.html" : path;
    const file = normalize(join(staticDir, rel));
    if (!file.startsWith(staticDir)) return json(res, 403, { error: "forbidden" });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not file");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }

  const http = createHttpServer((req, res) => {
    handleHttp(req, res).catch((e) => json(res, 500, { error: String(e) }));
  });

  // ------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws) => {
    let session: Session | null = null;
    const err = (message: string) => send(ws, { t: "error", message });

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return err("bad json");
      }
      void handle(msg).catch((e) => err(e instanceof Error ? e.message : String(e)));
    });

    ws.on("close", () => {
      if (!session) return;
      session.sockets.delete(ws);
      if (session.sockets.size === 0) for (const t of tables.values()) t.setConnected(session.playerId, false);
    });

    async function handle(msg: ClientMessage) {
      if (msg.t === "hello") {
        const name = String(msg.name ?? "").trim().slice(0, 24) || "Player";
        const existing = msg.playerId ? sessions.get(msg.playerId) : undefined;
        if (existing && msg.token && safeEq(existing.token, msg.token)) {
          session = existing;
          session.name = name;
        } else {
          session = { playerId: randomUUID(), token: randomUUID(), name, sockets: new Set(), watching: null };
          sessions.set(session.playerId, session);
        }
        session.sockets.add(ws);
        for (const t of tables.values()) t.setConnected(session.playerId, true);
        send(ws, { t: "welcome", playerId: session.playerId, token: session.token, name: session.name });
        // resume the table you're seated at
        const seatedAt = [...tables.values()].find((t) => t.participants.has(session!.playerId));
        if (seatedAt) session.watching = seatedAt.id;
        if (session.watching) send(ws, tables.get(session.watching)!.viewFor(session.playerId, paymentMethods));
        else send(ws, lobbyMsg());
        return;
      }
      if (!session) return err("say hello first");
      const s = session;
      if (msg.t === "lobby") {
        s.watching = null;
        return send(ws, lobbyMsg());
      }
      const table = tables.get((msg as { tableId: string }).tableId);
      if (!table) return err("no such table");
      switch (msg.t) {
        case "watch":
          s.watching = table.id;
          return send(ws, table.viewFor(s.playerId, paymentMethods));
        case "join":
          s.watching = table.id;
          await table.join(s.playerId, s.name, Number(msg.buyIn), msg.method, msg.seat);
          return;
        case "action":
          try {
            table.act(s.playerId, { type: msg.action, ...(msg.amount !== undefined ? { amount: Number(msg.amount) } : {}) });
          } catch (e) {
            if (e instanceof IllegalActionError) return err(e.message);
            throw e;
          }
          return;
        case "leave":
          await table.leave(s.playerId, msg.method, msg.destination);
          return send(ws, { t: "info", message: "You left the table. Chips cashed out (play-money stub)." });
        case "rebuy":
          return table.rebuy(s.playerId, Number(msg.amount), msg.method);
        case "sitOut":
          return table.setSitOut(s.playerId, !!msg.value);
        case "addBot":
          s.watching = table.id;
          return table.addBot();
        case "removeBot":
          return table.removeBot();
        default:
          return err("unknown message");
      }
    }
  });

  await new Promise<void>((ok) => http.listen(opts.port ?? 3000, opts.host ?? "0.0.0.0", ok));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 3000);
  log(`btcpoker server listening on http://localhost:${port}  (PLAY MONEY — payment adapters are stubs)`);

  return {
    port,
    tables,
    cashier,
    async close() {
      for (const t of tables.values()) t.close();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((ok) => wss.close(() => ok()));
      await new Promise<void>((ok) => http.close(() => ok()));
    },
  };
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
