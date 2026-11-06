// The parts with no storage or network: the file format, names, averages and settings.
import assert from "node:assert/strict";
import { env, test, va2, failures } from "./sim.mjs";
import * as X from "./.build/internals.mjs";

await test("Windows-1252 round trip keeps £, €, curly quotes and dashes", () => {
  const text = "£10 – €20 ‘quoted’ “more” é …";
  const bytes = X.encodeCp1252(text);
  assert.equal(bytes.length, text.length);
  assert.equal(bytes[0], 0xa3);
  assert.equal(X.decodeBytes(bytes), text);
});
await test("a character Windows-1252 can't hold becomes a question mark rather than breaking the file", () => {
  assert.equal(X.decodeBytes(X.encodeCp1252("a→b")), "a?b");
});
await test("UTF-8 text and a byte-order mark are read as text", () => {
  assert.equal(X.decodeBytes(new TextEncoder().encode("﻿£5")), "£5");
});
await test("a file must start Begin Header and hold the assessment table", () => {
  assert.throws(() => X.checkVaFile("hello", "assessment", 1000), /isn't a Value Analyser file/);
  assert.throws(() => X.checkVaFile("Begin Header\r\nEnd Section\r\n", "assessment", 1000), /no VA_Assessment table/);
  assert.throws(() => X.checkVaFile("", "assessment", 1000), /empty/);
  assert.throws(() => X.checkVaFile(va2(), "assessment", 10), /too large/);
});
await test("line ends are put back to the workbook's", () => {
  assert.ok(!/[^\r]\n/.test(X.checkVaFile(va2().replace(/\r\n/g, "\n"), "assessment", 100000)));
});
await test("rows, header values and the template's fingerprint are read from a file", () => {
  const t = va2();
  const rows = X.vaRows(t);
  assert.deepEqual(rows.map((r) => r.dimension), ["Economy", "Efficiency"]);
  assert.equal(rows[1].factor, "Process time");
  assert.equal(X.headerValue(t, "Profile Type"), "Value for Money (Highways)");
  assert.equal(X.structureKey(rows), X.structureKey(X.vaRows(va2())));
  assert.notEqual(X.structureKey(rows), X.structureKey(X.vaRows(va2([[101, "Economy", "Something else"]]))));
});
await test("names that could leave their folder are refused", () => {
  for (const bad of ["../secret", "a/b", "a\\b", "a:b", "ends.", "no"]) assert.throws(() => X.checkName(bad), /name/i, bad);
  assert.equal(X.checkName("  Highways   2026 "), "Highways 2026");
});
await test("a file name stays inside its folder", () => {
  assert.ok(!X.fileName("a/../b").includes("/"));
  assert.equal(X.fileName("..."), "assessment");
});
await test("text that Excel would read as a formula is exported as text", () => {
  assert.equal(X.csvField("=1+1"), "'=1+1");
  assert.equal(X.csvField('say "hi"'), '"say ""hi"""');
  assert.equal(X.csvField(12), "12");
});
const peer = (n, extra = {}) => ({ totals: { score: n, conf: 10, opp: 20 }, dims: [{ name: "Economy", score: n, conf: 1, opp: 2 }], factors: { a: [n, 1, 2], ...extra } });
await test("averages: mean, median and counts", () => {
  const mean = X.aggregate([peer(10), peer(20), peer(60)], "mean", 3);
  assert.equal(mean.totals.score, 30);
  assert.equal(mean.dims[0].n, 3);
  assert.equal(X.aggregate([peer(10), peer(20), peer(60)], "median", 3).totals.score, 20);
  assert.equal(mean.factors.a.n, 3);
});
await test("a factor or dimension too few have answered isn't shown", () => {
  const list = [peer(10, { only: [99, 1, 2] }), peer(20), peer(60)];
  list[0].dims.push({ name: "Bespoke", score: 88, conf: 1, opp: 2 });
  const b = X.aggregate(list, "mean", 3);
  assert.equal(b.factors.only, undefined);
  assert.deepEqual(b.dims.map((d) => d.name), ["Economy"]);
  assert.ok(!JSON.stringify(b).includes("99") && !JSON.stringify(b).includes("88"));
});
await test("no highest or lowest, and no middle half until five, as three figures could be worked back", () => {
  const three = X.aggregate([peer(10), peer(20), peer(60)], "mean", 3);
  for (const part of [three.totals, three.dims[0], three.factors.a]) for (const k of ["min", "max", "q1", "q3"]) assert.equal(part[k], undefined, k);
  const five = X.aggregate([10, 20, 30, 40, 60].map((n) => peer(n)), "mean", 3);
  assert.equal(five.totals.q1, 20); assert.equal(five.totals.q3, 40); assert.equal(five.totals.min, undefined);
  assert.equal(five.factors.a.q1, 20); assert.equal(five.dims[0].q3, 40);
});
await test("a composite built before this rule is held to it when it's read", () => {
  const old = { n: 3, totals: { score: 30, min: 10, max: 60, q1: 15, q3: 40 }, dims: [{ name: "Few", n: 1, score: 9 }, { name: "Economy", n: 3, score: 30, min: 10, max: 60, q1: 15, q3: 40 }], factors: { a: { score: 30, n: 3, min: 10, max: 60 }, b: { score: 9, n: 1 } } };
  const seen = X.publicBenchmark({ source: "composite", summary: JSON.stringify(old), visible: 1, member_list: "[]" }, true, false, 3).summary;
  assert.deepEqual(Object.keys(seen.factors), ["a"]);
  assert.deepEqual(seen.dims.map((d) => d.name), ["Economy"]);
  assert.equal(seen.totals.min, undefined); assert.equal(seen.totals.q1, undefined); assert.equal(seen.factors.a.max, undefined);
});
await test("a file full of blank lines or repeated tables is read quickly", () => {
  const started = performance.now();
  X.headerValue("Begin Header\r\n" + "\r\n".repeat(2_500_000), "Profile Type");
  X.vaRows("\r\nBegin Table: VA_Assessment\r\n".repeat(170_000));
  assert.ok(performance.now() - started < 1500, "took too long");
});
await test("the table is found as before", () => {
  assert.deepEqual(X.vaRows("no table here"), []);
  assert.deepEqual(X.vaRows("x\r\nBegin Table: VA_Assessment\r\n  |c|ID|e|{N}|e|1|e|n|e|l"), []);
  assert.equal(X.vaRows(va2().replace(/\r\n/g, "\n")).length, 2);
});
await test("a summary from the page is reduced to figures", () => {
  const c = X.cleanSummary({ totals: { score: "bad", conf: 1.23456 }, dims: [{ name: "x".repeat(300), score: 5 }], factors: { a: [1, 2, 3, 4, 5, 6, 7] }, extra: "dropped" });
  assert.equal(c.totals.score, null);
  assert.equal(c.totals.conf, 1.235);
  assert.equal(c.dims[0].name.length, 150);
  assert.equal(c.factors.a.length, 5);
  assert.equal(c.extra, undefined);
});
await test("settings: stray quotes and invisible characters are ignored, and nothing is reported by value", () => {
  process.env.SITE_ADMINS = ' "A@x.test, b@x.test"​ ';
  assert.deepEqual(X.getConfig().siteAdmins, ["a@x.test", "b@x.test"]);
  process.env.SITE_ADMINS = env.SITE_ADMINS;
  assert.ok(!X.settingsReport().join(" ").includes(env.STORAGE_ACCESS_KEY + " "));
  assert.ok(!X.settingsReport().join(" ").includes(env.SESSION_SECRET));
});
await test("the sign-in secret is required: there's no fallback made from other keys", () => {
  const keep = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  assert.deepEqual(X.missingSettings(X.getConfig()), ["SESSION_SECRET"]);
  process.env.SESSION_SECRET = keep;
});
await test("a template's levels are read from a list, and a template that doesn't say is service level", () => {
  assert.equal(X.cleanLevels("service, function"), "service,function");
  assert.equal(X.cleanLevels(["PROCESS", "organisation"]), "organisation,process");
  assert.equal(X.cleanLevels(""), "service");
  assert.equal(X.cleanLevels(null), "service");
  assert.equal(X.cleanLevels("everywhere"), "service");
});
await test("a template's settings are read from its file", () => {
  const t = va2() + "Begin Template Settings\r\n   Template Levels:= service,function\r\n   Template Description:= About this\r\nEnd Section\r\n";
  assert.equal(X.headerValue(t, "Template Levels"), "service,function");
  assert.equal(X.headerValue(t, "Template Description"), "About this");
});
await test("peer comparisons can't be set below three authorities", () => {
  process.env.MIN_PEERS = "2";
  assert.equal(X.getConfig().minPeers, 3);
  delete process.env.MIN_PEERS;
});
await test("the upload limit stays within its range", () => {
  process.env.MAX_UPLOAD_MB = "9999";
  assert.equal(X.getConfig().maxUpload, 20 * 1024 * 1024);
  delete process.env.MAX_UPLOAD_MB;
  assert.equal(X.getConfig().maxUpload, 5 * 1024 * 1024);
});
process.exit(failures ? 1 : 0);
