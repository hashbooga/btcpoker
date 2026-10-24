import type { ActionType, HandRecord, PaymentMethodInfo, ServerMessage, TableState, TableSummary } from "./types.js";
import { verifyInBrowser } from "./verify.js";
import { CAMERA_VIEWS, VIEW_STORAGE_KEY, nextView, parseView, seatRadii, viewForKey, type CameraView } from "./view.js";

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SUIT: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
function cardEl(card: string | null, small = false, animate = false): HTMLElement {
  if (!card) return el("div", `card back${small ? " small" : ""}`);
  const r = card[0] === "T" ? "10" : card[0]!;
  const s = card[1]!;
  return el("div", `card${small ? " small" : ""}${s === "h" || s === "d" ? " red" : ""}${animate ? " deal" : ""}`, `<span class="r">${r}</span><span class="s">${SUIT[s]}</span>`);
}

// ------------------------------------------------------------------ session state (per tab)
const store = sessionStorage;
let playerId = store.getItem("bp.playerId") ?? undefined;
let token = store.getItem("bp.token") ?? undefined;
let myName = localStorage.getItem("bp.name") ?? "";
let ws: WebSocket | null = null;
let state: TableState | null = null;
let tables: TableSummary[] = [];
let paymentMethods: PaymentMethodInfo[] = [];
let currentTableId: string | null = null;
let lastBoardLen = 0;
let sliderKey = "";
let pendingAfterJoin: (() => void) | null = null;
let view: CameraView = parseView(localStorage.getItem(VIEW_STORAGE_KEY));

($("name") as HTMLInputElement).value = myName;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $("conn").textContent = "online";
    $("conn").className = "conn on";
    send({ t: "hello", name: myName || "Player", ...(playerId ? { playerId } : {}), ...(token ? { token } : {}) });
  };
  ws.onclose = () => {
    $("conn").textContent = "offline — reconnecting…";
    $("conn").className = "conn off";
    setTimeout(connect, 1200);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)) as ServerMessage);
}
function send(m: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

let toastTimer: number | undefined;
function toast(msg: string, kind: "error" | "info" = "error") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add("hidden"), 3500);
}

function onMessage(m: ServerMessage) {
  switch (m.t) {
    case "welcome":
      playerId = m.playerId; token = m.token;
      store.setItem("bp.playerId", m.playerId); store.setItem("bp.token", m.token);
      $("whoami").textContent = m.name;
      break;
    case "lobby":
      tables = m.tables; paymentMethods = m.paymentMethods;
      if (!currentTableId) showLobby();
      renderLobby();
      break;
    case "state":
      if (currentTableId && m.table.id !== currentTableId) return;
      state = m; paymentMethods = m.paymentMethods; currentTableId = m.table.id;
      showGame();
      renderTable();
      if (pendingAfterJoin && m.you.seat !== null) { const f = pendingAfterJoin; pendingAfterJoin = null; f(); }
      break;
    case "error": toast(m.message); break;
    case "info": toast(m.message, "info"); break;
    case "handComplete": break;
  }
}

// ------------------------------------------------------------------ lobby
function showLobby() {
  $("lobby").classList.remove("hidden");
  $("game").classList.add("hidden");
  $("btn-lobby").classList.add("hidden");
}
function showGame() {
  $("lobby").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("btn-lobby").classList.remove("hidden");
}
function renderLobby() {
  const box = $("tables");
  box.innerHTML = "";
  for (const t of tables) {
    const c = el("div", "tcard");
    c.innerHTML = `<h3>${esc(t.name)}</h3>
      <div class="muted">Blinds ${t.smallBlind}/${t.bigBlind} · ${t.players}/${t.maxSeats} seated · buy-in ${t.minBuyIn}–${t.maxBuyIn}</div>
      <div class="muted small">${t.handNumber} hands played</div>`;
    const row = el("div", "row");
    const watch = el("button", "", "Watch");
    watch.onclick = () => { currentTableId = t.id; send({ t: "watch", tableId: t.id }); };
    const join = el("button", "primary", "Join");
    join.onclick = () => openJoin(t);
    row.append(watch, join);
    c.append(row);
    box.append(c);
  }
}
function saveName() {
  myName = ($("name") as HTMLInputElement).value.trim().slice(0, 24) || myName || "Player";
  localStorage.setItem("bp.name", myName);
  send({ t: "hello", name: myName, ...(playerId ? { playerId } : {}), ...(token ? { token } : {}) });
}
$("name").addEventListener("change", saveName);

$("btn-solo").onclick = () => {
  saveName();
  const t = tables.find((x) => x.maxSeats >= 6 && x.players === 0) ?? tables.find((x) => x.players < x.maxSeats);
  if (!t) return toast("All tables are full");
  currentTableId = t.id;
  const buyIn = Math.min(t.maxBuyIn, t.bigBlind * 100);
  pendingAfterJoin = () => { for (let i = 0; i < 3; i++) send({ t: "addBot", tableId: t.id }); };
  send({ t: "join", tableId: t.id, buyIn, method: paymentMethods[0]?.id ?? "lightning" });
};
$("btn-lobby").onclick = () => { currentTableId = null; state = null; send({ t: "lobby" }); showLobby(); };

// ------------------------------------------------------------------ join dialog
let joinTarget: { table: TableSummary; seat?: number } | null = null;
function fillMethods(sel: HTMLSelectElement) {
  sel.innerHTML = paymentMethods.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
}
function openJoin(table: TableSummary, seat?: number) {
  saveName();
  joinTarget = seat === undefined ? { table } : { table, seat };
  $("join-title").textContent = `Join ${table.name}${seat !== undefined ? ` — seat ${seat + 1}` : ""}`;
  const amt = $("join-amount") as HTMLInputElement;
  amt.min = String(table.minBuyIn); amt.max = String(table.maxBuyIn);
  amt.value = String(Math.min(table.maxBuyIn, table.bigBlind * 100));
  fillMethods($("join-method") as HTMLSelectElement);
  ($("join-dialog") as HTMLDialogElement).showModal();
}
$("join-form").addEventListener("submit", (ev) => {
  const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok" || !joinTarget) return;
  const { table, seat } = joinTarget;
  currentTableId = table.id;
  send({ t: "join", tableId: table.id, buyIn: Number(($("join-amount") as HTMLInputElement).value), method: ($("join-method") as HTMLSelectElement).value, ...(seat !== undefined ? { seat } : {}) });
});

// ------------------------------------------------------------------ camera angles
function buildViewSwitch() {
  const box = $("view-switch");
  box.innerHTML = "";
  for (const v of CAMERA_VIEWS) {
    const b = el("button", "vbtn", `${v.label} <kbd>${v.key}</kbd>`);
    b.dataset.view = v.id;
    b.title = `${v.title} (${v.key})`;
    b.setAttribute("role", "radio");
    b.onclick = () => setView(v.id);
    box.append(b);
  }
}
function applyView() {
  const stage = $("stage");
  for (const v of CAMERA_VIEWS) stage.classList.toggle(`view-${v.id}`, v.id === view);
  $("game").dataset.view = view;
  for (const b of $("view-switch").querySelectorAll<HTMLButtonElement>(".vbtn")) {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  }
}
function setView(v: CameraView) {
  if (v === view) return;
  view = v;
  localStorage.setItem(VIEW_STORAGE_KEY, v);
  applyView();
  if (state) renderTable();
}
buildViewSwitch();
applyView();
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA" || (tgt.tagName === "INPUT" && (tgt as HTMLInputElement).type !== "range" && (tgt as HTMLInputElement).type !== "checkbox")) return;
  if ($("game").classList.contains("hidden") || ($("join-dialog") as HTMLDialogElement).open) return;
  const v = e.key.toLowerCase() === "v" ? nextView(view) : viewForKey(e.key);
  if (v) { e.preventDefault(); setView(v); }
});

// ------------------------------------------------------------------ table rendering
function seatPos(seat: number, n: number, mySeat: number | null, rx: number, ry: number) {
  const k = (seat - (mySeat ?? 0) + n) % n;
  const a = (Math.PI / 2) + (k * 2 * Math.PI) / n;
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

function renderTable() {
  const s = state!;
  const n = s.table.maxSeats;
  const me = s.you.seat;
  const radii = seatRadii(view);
  $("table-name").textContent = s.table.name;
  $("blinds").textContent = `Blinds ${s.table.smallBlind}/${s.table.bigBlind}`;
  $("handno").textContent = s.table.handNumber ? `Hand #${s.table.handNumber}` : "";

  // board
  const board = $("board");
  board.innerHTML = "";
  s.board.forEach((c, i) => board.append(cardEl(c, false, i >= lastBoardLen)));
  lastBoardLen = s.board.length;
  if (s.street === "waiting" || s.street === "complete" || s.street === "showdown") lastBoardLen = s.board.length;
  if (s.street === "preflop") lastBoardLen = 0;

  const potTxt = s.pot > 0 ? `Pot ${s.pot}` : s.pots.length ? `Pot ${s.pots.reduce((a, p) => a + p.amount, 0)}${s.pots.length > 1 ? ` (${s.pots.length - 1} side pot${s.pots.length > 2 ? "s" : ""})` : ""}` : "";
  $("pot").textContent = potTxt;
  const seated = s.seats.filter(Boolean).length;
  let banner = "";
  if (s.winners.length) {
    banner = s.winners.map((w) => `${esc(s.seats[w.seat]?.name ?? "?")} wins ${w.amount}${w.hand ? ` — ${esc(w.hand)}` : ""}`).join("<br>");
  } else if (s.street === "waiting" && seated < 2) banner = "Waiting for players… add a bot from the Cashier tab or open another tab";
  $("banner").innerHTML = banner;

  // seats
  const seats = $("seats");
  seats.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const v = s.seats[i];
    const p = seatPos(i, n, me, ...radii.seat);
    const d = el("div", "seat");
    d.style.left = `${p.x}%`; d.style.top = `${p.y}%`;
    if (!v) {
      d.classList.add("empty");
      const plate = el("div", "plate", me === null ? "Sit here" : "Empty");
      if (me === null) plate.onclick = () => openJoin(s.table, i);
      d.append(el("div", "cards"), plate);
      seats.append(d);
      continue;
    }
    if (i === me) d.classList.add("me");
    if (s.toAct === i) d.classList.add("turn");
    if (v.folded) d.classList.add("folded");
    if (v.isWinner) d.classList.add("winner");
    if (v.sittingOut || (!v.connected && !v.isBot)) d.classList.add("out");
    const cards = el("div", "cards");
    if (v.cards) v.cards.forEach((c) => cards.append(cardEl(c, true)));
    else for (let k = 0; k < v.cardCount; k++) cards.append(cardEl(null, true));
    const plate = el("div", "plate");
    const tag = v.allIn ? "ALL-IN" : v.lastAction ?? (v.sittingOut ? "sitting out" : "");
    plate.innerHTML = `<div class="name">${esc(v.name)}</div><div class="stack">${v.stack}</div><div class="tag">${esc(tag)}</div>${v.handDescription ? `<div class="handdesc">${esc(v.handDescription)}</div>` : ""}`;
    if (s.toAct === i && s.turnDeadline) {
      const bar = el("div", "timer");
      bar.dataset.deadline = String(s.turnDeadline);
      plate.append(bar);
    }
    d.append(cards, plate);
    seats.append(d);

    if (v.streetBet > 0) {
      const bp = seatPos(i, n, me, ...radii.bet);
      const b = el("div", "bet", `<span class="chip"></span>${v.streetBet}`);
      b.style.left = `${bp.x}%`; b.style.top = `${bp.y}%`;
      seats.append(b);
    }
    if (i === s.buttonSeat && s.table.handNumber > 0) {
      const dp = seatPos(i, n, me, ...radii.dealer);
      const btn = el("div", "dealer", "D");
      btn.style.left = `${dp.x + 4}%`; btn.style.top = `${dp.y}%`;
      seats.append(btn);
    }
  }

  renderPovHand();
  renderActions();
  renderLog();
  renderFairness();
  renderCashier();
}

/** POV foreground: your own hole cards, large and close, plus your stack. */
function renderPovHand() {
  const box = $("pov-hand");
  const s = state!;
  if (view !== "pov") { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = "";
  const me = s.you.seat;
  const v = me !== null ? s.seats[me] : null;
  if (!v) {
    box.append(el("div", "pov-note", "You're watching — this is the view from seat 1. Sit down to see your own cards up close."));
    return;
  }
  box.classList.toggle("turn", s.toAct === me);
  box.classList.toggle("folded", v.folded);
  box.classList.toggle("winner", !!v.isWinner);
  const cards = el("div", "pov-cards");
  if (v.cards) v.cards.forEach((c, k) => { const ce = cardEl(c); ce.classList.add("big", k === 0 ? "l" : "r"); cards.append(ce); });
  else for (let k = 0; k < v.cardCount; k++) { const ce = cardEl(null); ce.classList.add("big", k === 0 ? "l" : "r"); cards.append(ce); }
  const tag = v.allIn ? "ALL-IN" : v.lastAction ?? (v.sittingOut ? "sitting out" : "");
  const info = el("div", "pov-info", `<div class="name">${esc(v.name)}</div><div class="stack">${v.stack}</div><div class="tag">${esc(tag)}</div>${v.handDescription ? `<div class="handdesc">${esc(v.handDescription)}</div>` : ""}`);
  if (s.toAct === me && s.turnDeadline) {
    const bar = el("div", "timer");
    bar.dataset.deadline = String(s.turnDeadline);
    info.append(bar);
  }
  box.append(cards, info);
}

function renderLog() {
  const box = $("log");
  const atBottom = box.parentElement!.scrollTop + box.parentElement!.clientHeight >= box.parentElement!.scrollHeight - 30;
  box.innerHTML = state!.log.map((l) => `<div class="${l.startsWith("---") || l.startsWith("***") ? "hdr" : ""}">${esc(l)}</div>`).join("");
  if (atBottom) box.parentElement!.scrollTop = box.parentElement!.scrollHeight;
}

// ------------------------------------------------------------------ actions
const slider = $("slider") as HTMLInputElement;
const amount = $("amount") as HTMLInputElement;

function myStreetBet(): number {
  const s = state!;
  return s.you.seat !== null ? (s.seats[s.you.seat]?.streetBet ?? 0) : 0;
}

function renderActions() {
  const s = state!;
  const la = s.you.legal;
  const btns = $("actions").querySelector(".action-buttons") as HTMLElement;
  const sizing = $("actions").querySelector(".sizing") as HTMLElement;
  const waiting = $("waiting");
  if (!la) {
    btns.classList.add("hidden"); sizing.classList.add("hidden");
    let msg = "";
    if (s.you.seat === null) msg = "You are watching. Click an empty seat to sit down.";
    else {
      const meSeat = s.seats[s.you.seat];
      if (meSeat && meSeat.stack === 0 && !meSeat.inHand) msg = "You're out of chips — add chips in the Cashier tab.";
      else if (meSeat?.sittingOut) msg = "You're sitting out. Uncheck “Sit out” in the Cashier tab to play.";
      else if (s.toAct !== null) msg = `Waiting for ${s.seats[s.toAct]?.name ?? "…"}`;
      else msg = s.street === "waiting" ? "Waiting for the next hand…" : "Next hand starting soon…";
    }
    waiting.textContent = msg;
    waiting.classList.remove("hidden");
    return;
  }
  waiting.classList.add("hidden");
  btns.classList.remove("hidden");
  ($("act-check") as HTMLButtonElement).innerHTML = la.canCheck ? "Check <kbd>C</kbd>" : `Call ${la.toCall} <kbd>C</kbd>`;
  const aggress = la.canBet || la.canRaise;
  ($("act-raise") as HTMLButtonElement).disabled = !aggress;
  ($("act-allin") as HTMLButtonElement).disabled = !(aggress || la.canCall);
  sizing.classList.toggle("hidden", !aggress);
  const key = `${s.table.handNumber}:${s.street}:${la.minTo}:${la.maxTo}`;
  slider.min = String(la.minTo); slider.max = String(la.maxTo);
  amount.min = String(la.minTo); amount.max = String(la.maxTo);
  if (key !== sliderKey) {
    sliderKey = key;
    slider.value = String(la.minTo);
    amount.value = String(la.minTo);
  }
  updateRaiseLabel();
}
function updateRaiseLabel() {
  const la = state?.you.legal;
  if (!la) return;
  const v = clampAmount(Number(amount.value));
  const verb = la.canBet ? "Bet" : "Raise to";
  ($("act-raise") as HTMLButtonElement).innerHTML = `${v >= la.maxTo ? "All-in" : verb} ${v} <kbd>R</kbd>`;
}
function clampAmount(v: number) {
  const la = state!.you.legal!;
  if (!Number.isFinite(v)) return la.minTo;
  return Math.max(la.minTo, Math.min(la.maxTo, Math.round(v)));
}
slider.oninput = () => { amount.value = slider.value; updateRaiseLabel(); };
amount.oninput = () => { slider.value = amount.value; updateRaiseLabel(); };
for (const b of document.querySelectorAll<HTMLButtonElement>(".presets button")) {
  b.onclick = () => {
    const s = state; const la = s?.you.legal;
    if (!s || !la) return;
    const frac = b.dataset.frac!;
    const currentBet = myStreetBet() + la.toCall;
    const to = frac === "min" ? la.minTo : currentBet + Number(frac) * (s.pot + la.toCall);
    amount.value = String(clampAmount(to));
    slider.value = amount.value;
    updateRaiseLabel();
  };
}
function act(action: ActionType, amt?: number) {
  if (!state?.you.legal || !currentTableId) return;
  send({ t: "action", tableId: currentTableId, action, ...(amt !== undefined ? { amount: amt } : {}) });
}
$("act-fold").onclick = () => act("fold");
$("act-check").onclick = () => { const la = state?.you.legal; if (la) act(la.canCheck ? "check" : "call"); };
$("act-raise").onclick = () => { const la = state?.you.legal; if (la) act(la.canBet ? "bet" : "raise", clampAmount(Number(amount.value))); };
$("act-allin").onclick = () => act("allin");
document.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === "INPUT" && (tgt as HTMLInputElement).type !== "range") return;
  if (!state?.you.legal) return;
  const k = e.key.toLowerCase();
  if (k === "f") $("act-fold").click();
  else if (k === "c") $("act-check").click();
  else if (k === "r" && !($("act-raise") as HTMLButtonElement).disabled) $("act-raise").click();
});

// turn timer bars
setInterval(() => {
  for (const bar of document.querySelectorAll<HTMLElement>(".timer")) {
    const left = Math.max(0, Number(bar.dataset.deadline) - Date.now());
    bar.style.width = `${Math.min(100, (left / 30000) * 100)}%`;
  }
}, 200);

// ------------------------------------------------------------------ side panel tabs
for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  t.onclick = () => {
    for (const x of document.querySelectorAll(".tab")) x.classList.toggle("active", x === t);
    for (const id of ["log", "fair", "cashier"]) $(`tab-${id}`).classList.toggle("hidden", id !== t.dataset.tab);
  };
}

// ------------------------------------------------------------------ fairness
function renderFairness() {
  const s = state!;
  const f = s.fairness;
  $("fair-current").innerHTML = f
    ? `Hand #${f.handNumber}<br>commit = SHA-256(seed‖nonce):<br><b>${f.commit}</b><br>${f.reveal ? `seed: ${f.reveal.seed}<br>nonce: ${f.reveal.nonce}` : "<i>seed hidden until the hand ends</i>"}`
    : "No hand yet.";
  const l = s.lastHand;
  $("fair-last").innerHTML = l?.reveal ? `Hand #${l.handNumber}<br>commit: ${l.commit}<br>seed: ${l.reveal.seed}<br>nonce: ${l.reveal.nonce}<br><a href="/api/tables/${s.table.id}/hands/${l.handNumber}" target="_blank">raw hand record (JSON)</a>` : "None yet.";
  ($("btn-verify") as HTMLButtonElement).disabled = !l;
}
$("btn-verify").onclick = async () => {
  const s = state;
  if (!s?.lastHand) return;
  const out = $("verify-out");
  out.textContent = "Verifying…";
  try {
    const rec = (await (await fetch(`/api/tables/${s.table.id}/hands/${s.lastHand.handNumber}`)).json()) as HandRecord;
    const res = verifyInBrowser(rec);
    out.innerHTML = `<h3>Hand #${rec.handNumber}: ${res.ok ? '<span class="check-ok">VERIFIED ✔</span>' : '<span class="check-bad">FAILED ✘</span>'}</h3>` +
      res.checks.map((c) => `<div class="${c.ok ? "check-ok" : "check-bad"}">${c.ok ? "✔" : "✘"} ${esc(c.name)}</div>`).join("") +
      `<div class="small muted" style="margin-top:6px">Board: ${rec.board.join(" ") || "(none dealt)"} · Holes: ${Object.entries(rec.holes).map(([seat, h]) => `${esc(rec.players.find((p) => p.seat === Number(seat))?.name ?? seat)} ${h.join(" ")}`).join(", ")}</div>`;
  } catch (e) {
    out.textContent = `Error: ${String(e)}`;
  }
};

// ------------------------------------------------------------------ cashier
function renderCashier() {
  const s = state!;
  const seated = s.you.seat !== null;
  for (const id of ["rebuy-method", "cashout-method"]) {
    const sel = $(id) as HTMLSelectElement;
    if (sel.options.length !== paymentMethods.length) fillMethods(sel);
  }
  ($("btn-leave") as HTMLButtonElement).disabled = !seated;
  ($("btn-rebuy") as HTMLButtonElement).disabled = !seated;
  ($("sitout") as HTMLInputElement).disabled = !seated;
  ($("sitout") as HTMLInputElement).checked = seated && !!s.seats[s.you.seat!]?.sittingOut;
  const rb = $("rebuy-amt") as HTMLInputElement;
  if (!rb.value) rb.value = String(s.table.bigBlind * 100);
}
$("btn-addbot").onclick = () => currentTableId && send({ t: "addBot", tableId: currentTableId });
$("btn-rmbot").onclick = () => currentTableId && send({ t: "removeBot", tableId: currentTableId });
$("sitout").onchange = () => currentTableId && send({ t: "sitOut", tableId: currentTableId, value: ($("sitout") as HTMLInputElement).checked });
$("btn-rebuy").onclick = () => currentTableId && send({ t: "rebuy", tableId: currentTableId, amount: Number(($("rebuy-amt") as HTMLInputElement).value), method: ($("rebuy-method") as HTMLSelectElement).value });
$("btn-leave").onclick = () => {
  if (!currentTableId) return;
  send({ t: "leave", tableId: currentTableId, method: ($("cashout-method") as HTMLSelectElement).value, destination: ($("cashout-dest") as HTMLInputElement).value || "play-money-wallet" });
};

connect();
