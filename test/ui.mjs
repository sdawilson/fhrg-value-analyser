// The page itself, in a simulated browser: it starts, its scoring is right, and files survive being read and written.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { failures, test, va2 } from "./sim.mjs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
const dom = new JSDOM(html, { url: "https://value-analyser.fhrg.co.uk/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
await new Promise((r) => setTimeout(r, 400));
const VA = w.eval("VA");

await test("the page in the repository runs on sample data until the server turns it live", () => {
  assert.ok(html.includes("const LIVE = false;"));
  assert.equal(w.eval("LIVE"), false);
});
await test("the page starts without an error", () => {
  assert.deepEqual(errors.filter((e) => !/Not implemented/.test(e)), []);
  assert.ok(w.document.querySelector("main, #main, #app"));
  assert.ok(w.document.body.textContent.length > 100);
});
await test("no words about the old edge script are left on the page", () => {
  assert.ok(!/edge script/i.test(html));
});
await test("a link can't swap someone's sign-in for another account's", () => {
  assert.ok(!/takeSso|sso=/.test(html));
});
await test("a file is read and written back the same", () => {
  const t = va2([[101, "Economy", "Unit costs – £"], [201, "Efficiency", "Process time"]]);
  const { doc } = VA.parse(t, "sample.va2");
  assert.equal(doc.rows.length, 2);
  const back = VA.parse(VA.write(doc, {}), "again.va2").doc;
  assert.deepEqual(back.rows.map((r) => r.name ?? r.factor), doc.rows.map((r) => r.name ?? r.factor));
});
await test("scoring follows the workbook's formulas, with an override taking the answer's place", () => {
  const { doc } = VA.parse(va2(), "sample.va2");
  const [a, b] = doc.rows;
  a.weight = 75; a.score = "Good [80]";
  b.weight = 25; b.score = "Poor [10]"; b.scoreOv = 40;
  const c = VA.calculate(doc);
  assert.equal(Math.round(c.totals.score * 1000) / 1000, 70); // 0.75 × 80 + 0.25 × 40
  assert.deepEqual([...c.dims].map((d) => [d.name, d.score]), [["Economy", 80], ["Efficiency", 40]]);
});
await test("a weighted factor with no answer counts as zero, as in the workbook", () => {
  const { doc } = VA.parse(va2(), "sample.va2");
  doc.rows[0].weight = 50; doc.rows[0].score = "Fair [60]";
  doc.rows[1].weight = 50;
  assert.equal(Math.round(VA.calculate(doc).totals.score), 30);
});
dom.window.close();
process.exit(failures ? 1 : 0);
