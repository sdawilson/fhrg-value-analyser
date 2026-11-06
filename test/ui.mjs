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
// jsdom has no modal dialogs: stand them in, so a dialog opens and closes
w.HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); };
w.HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };
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
const guided = () => {
  const { doc } = VA.parse(va2(), "t.vt2");
  doc.kind = "template";
  doc.guidance = {
    101: { desc: "About this factor", levels: { Excellent: "The very best" } },
    "dim:Economy": { desc: "About economy", levels: { Good: "Good economy" } },
    "scale:Excellent To Poor": { desc: "", levels: { Poor: "Weak" } },
    "*": { desc: "For all", levels: { Satisfactory: "Fine" } },
  };
  doc.levels = "service,function"; doc.description = "Line one\nLine two";
  doc.rows[0].range = "Excellent To Poor"; doc.rows[1].range = "Excellent To Poor";
  doc.rows[0].weight = 50; doc.rows[1].weight = 50;
  return doc;
};
await test("scoring guidance and a template's settings survive being written and read", () => {
  const text = VA.write(guided(), {});
  assert.match(text, /Begin Scoring Guidance/); assert.match(text, /Begin Template Settings/);
  const back = VA.parse(text, "t.vt2").doc;
  assert.equal(back.guidance["101"].levels.Excellent, "The very best");
  assert.equal(back.guidance["dim:Economy"].desc, "About economy");
  assert.equal(back.levels, "service,function");
  assert.equal(back.description, "Line one\nLine two");
  assert.ok(!back.extraSections?.length, "not left as an unknown section");
});
await test("a factor's own guidance comes first, then its dimension's, its scale's and the template's", () => {
  const doc = guided();
  const g = VA.guidanceFor(doc, doc.rows[0]);
  assert.equal(g.desc, "About this factor");
  assert.deepEqual(Array.from(g.levels).map((x) => [x.label, x.text]), [["Excellent", "The very best"], ["Good", "Good economy"], ["Satisfactory", "Fine"], ["Poor", "Weak"]]);
  const other = VA.guidanceFor(doc, doc.rows[1]);
  assert.equal(other.desc, "For all", "a factor in another dimension falls back to the template's");
});
await test("a template with no guidance offers none", () => {
  const { doc } = VA.parse(va2(), "t.vt2");
  assert.equal(VA.guidanceFor(doc, doc.rows[0]), null);
});
await test("an assessment made from a template keeps its guidance and answer scales, and can be written back", () => {
  const t = guided();
  t.scales = { "Not Started To Advanced": ["Advanced [100]", "Established [75]", "Developing [50]", "Initial [25]", "Not Started [0]"] };
  t.rows[0].range = "Not Started To Advanced";
  const a = VA.fromTemplate(t, { Profile_Name: "Check" });
  a.rows[0].score = "Established [75]"; a.rows[1].score = "Good [75]";
  assert.equal(Math.round(VA.calculate(a).totals.score), 75);
  const back = VA.parse(VA.write(a, {}), "a.va2").doc;
  assert.equal(back.guidance["101"].desc, "About this factor");
  assert.equal(back.scales["Not Started To Advanced"].length, 5);
});
await test("Climate Readiness is one of the assessment types", () => {
  assert.ok(Array.from(VA.PROFILE_TYPES).includes("Climate Readiness"));
});

// ----- the demonstration
const wait = async (fn, what) => { for (let i = 0; i < 120; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`Waited for ${what}`); };
await test("the demonstration is Northbridge, and says it's fictional", async () => {
  await wait(() => /Northbridge/.test(w.document.body.textContent), "Northbridge");
  assert.match(w.document.querySelector(".demo-bar").textContent, /Northbridge is fictional and nothing you change here is saved/);
  assert.ok(!/Sample County|Sample CC|sample-county/.test(html));
});
const list = await w.eval(`(async () => JSON.stringify((await Demo.call("/api/assessments/list", { withSummary: true })).assessments.map((a) => ({ name: a.name, type: a.profile_type, c: a.completeness, score: a.score, id: a.id }))))()`).then(JSON.parse);
await test("it holds completed value for money and carbon assessments", () => {
  const done = (type) => list.filter((a) => a.type === type && a.c === 1 && a.score > 0);
  assert.ok(done("Value for Money (Highways)").length >= 3, JSON.stringify(list.map((a) => a.name)));
  assert.ok(done("Best Practice Carbon").length >= 2);
});
await test("the scores come from the real calculations and improve year on year", () => {
  const vfm = list.filter((a) => a.type === "Value for Money (Highways)").sort((x, y) => (x.name < y.name ? -1 : 1));
  assert.ok(vfm[0].score < vfm[2].score, vfm.map((a) => a.score).join());
});
await test("a demonstration assessment reads and scores as a real file does", async () => {
  const id = list.find((a) => a.type === "Best Practice Carbon").id;
  const r = JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/assessments/open", { id: ${id} })))()`));
  const { doc } = VA.parse(r.va2, "a.va2");
  assert.equal(Math.round(VA.calculate(doc).totals.score * 1000) / 1000, Math.round(r.assessment.score * 1000) / 1000);
  assert.ok(doc.rows.some((x) => x.comment));
  assert.ok(VA.guidanceFor(doc, doc.rows.find((x) => String(x.id) === "101")), "guidance shows for a sample of factors");
  assert.equal(VA.guidanceFor(doc, doc.rows.find((x) => String(x.id) === "701")), null, "and not for every factor");
});
await test("the scorecard offers guidance, and it opens", async () => {
  const id = list.find((a) => a.type === "Best Practice Carbon").id;
  w.location.hash = `/a/${id}/scorecard`;
  await wait(() => w.document.querySelector("[data-guide]"), "the guidance link");
  w.document.querySelector("[data-guide]").click();
  await wait(() => w.document.querySelector("dl.guide"), "the guidance");
  const body = w.document.querySelector("dl.guide").textContent;
  for (const word of ["Excellent", "Good", "Satisfactory", "Requires Improvement", "Poor"]) assert.ok(body.includes(word), word);
});
await test("the public page holds no real authority's data, and guidance for only a few factors", () => {
  assert.ok(!/cheshire|ringway|mukona|buckingham|bucks council|central bedfordshire/i.test(html));
  const st = Array.from(w.eval("STARTERS"));
  assert.equal(st.length, 4, "Climate Readiness stays in the members' library");
  assert.ok(!/Is there a named senior owner accountable/.test(html));
  for (const s of st) assert.ok(Object.keys(s.guidance).length <= 3, s.name);
});
await test("the template names are clean", () => {
  const names = Array.from(w.eval("STARTERS")).flatMap((s) => Array.from(s.rows).map((r) => r[2]));
  assert.deepEqual(names.filter((n) => / \? /.test(n)), []);
});
await test("the sign-in card offers the Northbridge demonstration beside Sign in, as Clarion's does", async () => {
  w.document.querySelector("dialog.ask[open] button[value=ok]")?.click();
  w.location.hash = "/";
  await wait(() => w.document.querySelector("#signout") && /Northbridge Value for Money 2025-26/.test(w.document.querySelector("#main").textContent), "the assessments");
  w.document.querySelector("#signout").click();
  await wait(() => w.document.querySelector("#signin"), "the sign-in card");
  const card = w.document.querySelector(".auth-sign .auth-card");
  assert.ok(card, "the framed card");
  assert.ok(w.document.body.classList.contains("auth-page"), "the site's header and footer step aside");
  const row = w.document.querySelector("#signin button[type=submit]").parentElement;
  const demo = row.querySelector("#si-demo");
  assert.equal(demo.getAttribute("href"), "/demo");
  assert.match(demo.textContent, /Explore the Northbridge demonstration/);
  assert.match(card.textContent, /Northbridge is a fictional authority/);
  assert.match(card.textContent, /Forgotten your password\?/);
  assert.ok(card.querySelector("img.auth-logo").getAttribute("src").startsWith("data:image/"));
  w.location.hash = "/guidance";
  await wait(() => !w.document.body.classList.contains("auth-page"), "the header to come back on another page");
});
dom.window.close();
process.exit(failures ? 1 : 0);
