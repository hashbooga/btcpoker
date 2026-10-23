import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Audit-checklist item automated: no Math.random *calls* in any package source. */
describe("rng audit", () => {
  it("no package source calls Math.random", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const pattern = new RegExp(["Math", "random"].join("\\.") + "\\s*\\(");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === "js") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js|mjs|html)$/.test(name) && pattern.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    for (const pkg of readdirSync(root)) walk(join(root, pkg));
    assert.deepEqual(offenders, []);
  });
});
