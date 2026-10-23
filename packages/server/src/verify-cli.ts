/**
 * Independently verify a finished hand:
 *   npm run verify-hand -- http://localhost:3000/api/tables/satoshi/hands/3
 *   npm run verify-hand -- ./hand.json
 */
import { readFile } from "node:fs/promises";
import { verifyHandRecord } from "./verify.js";
import type { HandRecord } from "./protocol.js";

const src = process.argv[2];
if (!src) {
  console.error("usage: verify-hand <url-or-file-of-hand-record>");
  process.exit(2);
}
const text = /^https?:/.test(src) ? await (await fetch(src)).text() : await readFile(src, "utf8");
const rec = JSON.parse(text) as HandRecord;
const res = verifyHandRecord(rec);
console.log(`Hand #${rec.handNumber} on table ${rec.tableId}`);
console.log(`commit: ${rec.commit}`);
for (const c of res.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
console.log(res.ok ? "VERIFIED: the dealt cards follow from the pre-committed seed." : "VERIFICATION FAILED");
process.exit(res.ok ? 0 : 1);
