// Runs every test suite against simulated Bunny storage and the website's database (no accounts or keys
// needed): npm test. Each suite runs in its own process.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const here = new URL(".", import.meta.url).pathname;
fs.mkdirSync(`${here}.build`, { recursive: true });
for (const [entry, out] of [["src/app.ts", "app.mjs"], ["src/server.ts", "server.mjs"], ["test/internals.ts", "internals.mjs"]]) {
  await esbuild.build({ entryPoints: [new URL(`../${entry}`, import.meta.url).pathname], outfile: `${here}.build/${out}`, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "error" });
}

const suites = ["units.mjs", "api.mjs", "server.mjs", "ui.mjs"];
let passed = 0, failed = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", `${here}${s}`], { encoding: "utf8", timeout: 300_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const p = (out.match(/^PASS/gm) || []).length, f = (out.match(/^FAIL/gm) || []).length;
  passed += p; failed += f;
  const broke = r.status !== 0 && !f;
  console.log(`${f || broke ? "✗" : "✓"} ${s}: ${p} passed${f ? `, ${f} failed` : ""}${broke ? " (stopped with an error)" : ""}`);
  if (f || broke) console.log(out.split("\n").filter((l) => /^FAIL|Error|error/.test(l)).slice(0, 20).join("\n"));
  if (broke) failed++;
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
