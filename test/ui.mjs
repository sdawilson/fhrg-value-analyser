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
const wait = async (fn, what) => { for (let i = 0; i < 120; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`Waited for ${typeof what === "function" ? what() : what}`); };
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
  w.document.querySelector("dialog.ask button[value=ok]").click();
  await wait(() => !w.document.querySelector("dialog.ask"), "the guidance to close");
});
// ----- shading on the scorecard
const sc = () => w.document.querySelector("#sc");
const rowsWith = (k) => [...sc().querySelectorAll(`.f-row[data-i] select[data-k="${k}"]`)];
const valueOf = (sel) => { const m = sel.selectedOptions[0]?.textContent.match(/\[(\d+)\]/) || sel.value.match(/\[(\d+)\]/); return m ? Number(m[1]) : null; };
const step = (v) => Math.max(0, Math.min(100, Math.round(v / 25) * 25));
await test("performance and confidence are shaded from muted red to muted green by their value", async () => {
  await wait(() => sc() && rowsWith("score").length, "the scorecard");
  for (const k of ["score", "conf"]) {
    const answered = rowsWith(k).filter((s) => valueOf(s) !== null);
    assert.ok(answered.length > 10, k);
    for (const s of answered) assert.ok(s.classList.contains(`t${step(valueOf(s))}`), `${k} ${s.value} ${s.className}`);
    for (const s of rowsWith(k).filter((s) => valueOf(s) === null)) assert.ok(!/\bt\d/.test(s.className), `${k} unanswered`);
  }
  const css = html.match(/--t0: (#[0-9a-f]{6}); --t25: #[0-9a-f]{6}; --t50: #[0-9a-f]{6}; --t75: #[0-9a-f]{6}; --t100: (#[0-9a-f]{6});/);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [lo, hi] = [rgb(css[1]), rgb(css[2])];
  assert.ok(lo[0] > lo[1] && lo[0] > lo[2], "low is reddish");
  assert.ok(hi[1] > hi[0] && hi[1] > hi[2], "high is greenish");
});
await test("weightings and opportunity are shaded more strongly the higher they are", () => {
  for (const k of ["weight", "opp"]) {
    const all = rowsWith(k);
    const val = (s) => (k === "weight" ? (s.value === "" ? null : Number(s.value)) : valueOf(s));
    for (const s of all) {
      const v = val(s), want = v && v > 0 ? `n${Math.max(25, step(v))}` : null;
      if (want) assert.ok(s.classList.contains(want), `${k} ${v} ${s.className}`);
      else assert.ok(!/\bn\d/.test(s.className), `${k} ${v} should be plain`);
    }
    assert.ok(all.some((s) => /\bn\d/.test(s.className)), k);
  }
  const css = html.match(/--n25: (#[0-9a-f]{6}); --n50: #[0-9a-f]{6}; --n75: #[0-9a-f]{6}; --n100: (#[0-9a-f]{6});/);
  const light = (h) => [1, 3, 5].reduce((a, i) => a + parseInt(h.slice(i, i + 2), 16), 0);
  assert.ok(light(css[1]) > light(css[2]), "a higher value is a stronger shade");
});
await test("each priority has a bar, as a share of the largest", () => {
  const cells = [...sc().querySelectorAll(".f-row[data-i] [data-pri]")];
  const num = (c) => { const v = c.querySelector(".pv").textContent.trim(); return v === "–" ? 0 : Number(v); };
  const max = Math.max(...cells.map(num)), share = (c) => Number(c.style.getPropertyValue("--p"));
  assert.ok(max > 0);
  assert.ok(cells.every((c) => c.classList.contains("pri-bar") && c.querySelector(".pbar i")));
  assert.equal(share(cells.find((c) => num(c) === max)), 1);
  for (const c of cells) assert.ok(Math.abs(share(c) - num(c) / max) < 0.02, `${c.textContent} ${share(c)}`);
});
// ----- row totals
const totalsBox = () => w.document.querySelector("#sc-totals");
const cellNum = (el) => { const v = el.textContent.trim(); return v === "–" ? null : Number(v); };
await test("row totals are off until asked for, and the choice is remembered", () => {
  assert.equal(totalsBox().checked, false);
  assert.ok(!sc().classList.contains("show-totals"));
  totalsBox().checked = true; totalsBox().dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.ok(sc().classList.contains("show-totals"));
  assert.equal(w.localStorage.getItem("va.rowTotals"), "1");
});
await test("each row's totals are its weighted share, and add up to the dimension's and the overall score", async () => {
  const doc = VA.parse(JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/assessments/open", { id: ${list.find((a) => a.type === "Best Practice Carbon").id} })))()`)).va2, "a.va2").doc;
  const c = VA.calculate(doc);
  let overall = 0;
  c.dims.forEach((d, di) => {
    const rows = doc.rows.map((r, i) => ({ r, i })).filter((o) => o.r.dimension === d.name && c.rows[o.i].scored);
    const sumW = rows.reduce((a, o) => a + o.r.weight, 0), allW = doc.rows.reduce((a, r, i) => a + (c.rows[i].heading ? 0 : r.weight || 0), 0);
    let dimSum = 0, allSum = 0;
    for (const { r, i } of rows) {
      const row = sc().querySelector(`.f-row[data-i="${i}"]`), dimCell = cellNum(row.querySelector("[data-tdim] .tv")), allCell = cellNum(row.querySelector("[data-tall] .tv"));
      const s = c.rows[i].score;
      if (s === null) { assert.equal(dimCell, null); continue; }
      assert.ok(Math.abs(dimCell - (r.weight / sumW) * s) < 0.051, `${r.id} dimension total ${dimCell}`);
      assert.ok(Math.abs(allCell - (r.weight / allW) * s) < 0.0051, `${r.id} assessment total ${allCell}`);
      dimSum += dimCell; allSum += allCell;
    }
    const tr = sc().querySelector(`[data-total="${di}"]`);
    assert.equal(tr.querySelector('[data-tsum="dim"]').textContent, d.score.toFixed(1), d.name);
    assert.ok(Math.abs(dimSum - d.score) < 0.05 * rows.length + 0.01, `${d.name}: rows add up to the dimension's score`);
    overall += Number(tr.querySelector('[data-tsum="all"]').textContent);
    assert.ok(Math.abs(allSum - Number(tr.querySelector('[data-tsum="all"]').textContent)) < 0.005 * rows.length + 0.01);
  });
  assert.ok(Math.abs(overall - c.totals.score) < 0.005 * c.dims.length + 0.01, "the dimensions' assessment totals add up to the overall score");
  assert.ok(sc().querySelector("[data-tdim] .lbl-mobile"), "labelled on a phone");
});
await test("row totals follow a changed answer, and hide again when unticked", () => {
  const s = rowsWith("score").find((x) => valueOf(x) !== null && x.closest(".f-row").querySelector("[data-tdim]")), row = s.closest(".f-row");
  const before = row.querySelector("[data-tdim] .tv").textContent;
  const now = valueOf(s);
  s.value = [...s.options].find((o) => { const m = (o.value + o.textContent).match(/\[(\d+)\]/); return m && Number(m[1]) !== now; }).value;
  s.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.notEqual(row.querySelector("[data-tdim] .tv").textContent, before);
  totalsBox().checked = false; totalsBox().dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.ok(!sc().classList.contains("show-totals"));
  assert.equal(w.localStorage.getItem("va.rowTotals"), "0");
});
await test("row totals sit at the end of the row, after Notes", () => {
  const css = html.replace(/\s+/g, " ");
  assert.match(css, /\.f-head \.c-t, \.f-row \.c-t \{ display: none; order: 1; \}/);
  for (const sel of ["\\.sc\\.show-totals \\.f-head, \\.sc\\.show-totals \\.f-row", "\\.sc\\.show-bench\\.show-totals \\.f-head, \\.sc\\.show-bench\\.show-totals \\.f-row"])
    assert.match(css, new RegExp(`${sel} \\{ grid-template-columns: [^}]* 4rem 5\\.2rem 4\\.6rem 4\\.6rem; \\}`), "priority, notes, then the two totals");
  // only where there's room for them: narrower, each row stacks as on a phone
  assert.match(css, /@media \(min-width: 1280px\) \{ \.sc\.show-totals \.f-head, \.sc\.show-totals \.f-row \{ grid-template-columns/);
  assert.match(css, /@media \(max-width: 1279px\) \{ \.sc\.show-totals \.f-head \{ display: none; \} \.sc\.show-totals \.f-row \{ grid-template-columns: 3rem minmax\(0, 1fr\) auto; grid-template-areas/);
});
await test("scores sit in the middle of their cells", () => {
  const css = html.replace(/\s+/g, " ");
  assert.match(css, /\.f-row select \{ text-align: center; text-align-last: center; \}/);
  assert.match(css, /\.f-row \.pri \{[^}]*text-align: center;/);
  assert.match(css, /\.pri-bar \{[^}]*align-items: center;/);
  assert.match(css, /\.f-head \.mid, \.f-row \.c-t, \.f-row \.c-b \{ text-align: center; \}/);
  assert.match(css, /\.prio-table td\.num, \.prio-table th\.num \{ text-align: center; vertical-align: middle; \}/);
  assert.match(css, /\.heat td\.v \{[^}]*vertical-align: middle;/);
  const head = [...sc().querySelectorAll(".f-head span")].filter((s) => /Weighting|Performance|Confidence|Opportunity|Priority/.test(s.textContent));
  assert.ok(head.length >= 5 && head.every((s) => s.classList.contains("mid")));
});
// ----- locked weightings
const lockBox = () => w.document.querySelector("#sc-lock");
const weightSel = () => rowsWith("weight");
const carbonId = () => list.find((a) => a.type === "Best Practice Carbon").id;
const saveAndRead = async () => {
  w.document.querySelector("#ws-save").click();
  await wait(() => /Saved/.test(w.document.querySelector("#ws-status")?.textContent || ""), "the save");
  return JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/assessments/open", { id: ${carbonId()} })))()`)).va2;
};
const readSaved = async () => JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/assessments/open", { id: ${carbonId()} })))()`)).va2;
let lockedDoc = null;
// the same answers on the template's weightings, row by row, worked out without the page's own helpers
const onTemplate = (doc) => { const d = VA.clone(doc); d.rows.forEach((r, i) => (r.weight = lockedDoc.rows[i].weight)); d.weighting = lockedDoc.weighting; d.weightsLocked = true; d.templateWeights = null; return d; };
const untick = async () => { lockBox().checked = false; lockBox().dispatchEvent(new w.Event("change", { bubbles: true })); await wait(() => w.document.querySelector("dialog.ask"), "the warning"); return w.document.querySelector("dialog.ask"); };
await test("weightings are locked by default, and a locked weighting can't be changed", async () => {
  lockedDoc = VA.parse(await readSaved(), "a.va2").doc;
  assert.equal(lockBox().checked, true);
  assert.ok(weightSel().length && weightSel().every((s) => s.disabled));
  const s = weightSel().find((x) => x.value !== "" && x.value !== "25"), i = s.closest(".f-row").dataset.i, before = s.value;
  s.disabled = false; s.value = "25"; s.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => w.document.querySelector(`.f-row[data-i="${i}"] select[data-k="weight"]`)?.disabled, "the scorecard to redraw");
  assert.equal(w.document.querySelector(`.f-row[data-i="${i}"] select[data-k="weight"]`).value, before);
});
await test("unlocking warns that it may break benchmarking, and can be called off", async () => {
  const d = await untick();
  assert.match(d.textContent, /Unlocking weightings may break benchmarking/);
  d.querySelector("[data-cancel]").click();
  await wait(() => !w.document.querySelector("dialog.ask"), "the warning to close");
  assert.equal(lockBox().checked, true);
  assert.ok(weightSel().every((s) => s.disabled));
});
await test("once unlocked, the weightings can be changed and the file records it", async () => {
  const d = await untick();
  d.querySelector("button[value=ok]").click();
  await wait(() => w.document.querySelector("#sc-lock-warn"), "the unlocked note");
  assert.equal(lockBox().checked, false);
  assert.ok(weightSel().every((s) => !s.disabled));
  assert.match(w.document.querySelector("#sc-lock-warn").textContent, /template's weightings/);
  const text = await saveAndRead();
  assert.match(text, /Weightings Locked:= No/);
  assert.match(text, /Template Weighting Method:= Simple\r\n/);
  const back = VA.parse(text, "a.va2").doc;
  assert.equal(back.weightsLocked, false);
  // a copy of the template's weightings, row by row
  for (const r of lockedDoc.rows) assert.equal(back.templateWeights.w[VA.weightKey(r)], r.weight ?? null, `${r.id} ${r.factor}`);
  assert.equal(VA.weightsDiffer(back), false, "unchanged so far");
  assert.equal(VA.summarise(back).template, undefined, "nothing extra to compare while they're the same");
});
await test("the shading follows a changed answer straight away", async () => {
  const s = rowsWith("score").find((x) => x.options.length > 2), row = s.closest(".f-row");
  const pick = (sel, n) => { sel.value = [...sel.options].find((o) => o.textContent.includes(`[${n}]`) || o.value.includes(`[${n}]`)).value; sel.dispatchEvent(new w.Event("change", { bubbles: true })); };
  pick(s, 0); assert.ok(s.classList.contains("t0"), s.className);
  pick(s, 100); assert.ok(s.classList.contains("t100"), s.className);
  const o = row.querySelector('select[data-k="opp"]');
  pick(o, 100); assert.ok(o.classList.contains("n100"), o.className);
  pick(o, 0); assert.ok(!/\bn\d/.test(o.className), o.className);
  const i = row.dataset.i, wsel = row.querySelector('select[data-k="weight"]');
  wsel.value = "25"; wsel.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => sc().querySelector(`.f-row[data-i="${i}"] select[data-k="weight"]`)?.classList.contains("n25"), "the weighting's shade");
});
await test("changed weightings keep the template's in the file, and benchmarks count the template's", async () => {
  const text = await saveAndRead();
  const doc = VA.parse(text, "a.va2").doc, mine = VA.calculate(doc), theirs = VA.calculate(onTemplate(doc));
  assert.ok(VA.weightsDiffer(doc));
  assert.notEqual(mine.totals.score.toFixed(3), theirs.totals.score.toFixed(3), "the change moves the score");
  const s = VA.summarise(doc);
  assert.equal(s.totals.score.toFixed(2), mine.totals.score.toFixed(2), "the list shows the authority's own score");
  assert.equal(s.template.totals.score.toFixed(2), theirs.totals.score.toFixed(2), "benchmarks get the score on the template's weightings");
  s.template.dims.forEach((d, k) => assert.equal(d.score.toFixed(2), theirs.dims[k].score.toFixed(2), d.name));
  // and the page's own averages use them
  const peer = VA.summarise(onTemplate(doc));
  assert.equal(VA.aggregate([s, peer, peer]).totals.score.toFixed(2), theirs.totals.score.toFixed(2));
});
await test("beside a benchmark, the scores are put back on the template's weightings", async () => {
  const id = carbonId();
  w.location.hash = `/a/${id}/benchmark`;
  await wait(() => w.document.querySelector('[data-src="fhrg"]'), "the benchmark tab");
  w.document.querySelector('[data-src="fhrg"]').click();
  await wait(() => w.document.querySelector("#bm-set"), "the FHRG benchmarks");
  const sel = w.document.querySelector("#bm-set");
  sel.value = [...sel.options].find((o) => /Carbon/.test(o.textContent)).value;
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => /template's weightings/.test(w.document.querySelector("#bm-result")?.textContent || ""), "the comparison");
  const theirs = VA.calculate(onTemplate(VA.parse(await readSaved(), "a.va2").doc)).totals.score.toFixed(1);
  const lead = w.document.querySelector("#bm-result .kpi.lead");
  assert.match(lead.textContent, /on the template's weightings/);
  assert.equal(lead.querySelector("strong").textContent, theirs);
  assert.match(w.document.querySelector("#bm-result .notice").textContent, new RegExp(`overall ${theirs.replace(".", "\\.")}`));
  w.location.hash = `/a/${id}/scorecard`;
  await wait(() => /template's weightings/.test(w.document.querySelector("#strip")?.textContent || ""), "the summary strip");
  assert.ok([...w.document.querySelectorAll("[data-stats]")].some((s) => /on the template's/.test(s.textContent)), "a dimension's heading compares on the template's weightings too");
  w.location.hash = `/a/${id}/report`;
  await wait(() => w.document.querySelector(".kpis"), "the report");
  assert.match(w.document.querySelector("#ws-body").textContent, new RegExp(`${theirs.replace(".", "\\.")} on the template's weightings`));
  w.location.hash = `/a/${id}/scorecard`;
  await wait(() => lockBox(), "the scorecard");
});
// ----- the copy of the template's weightings, in awkward cases
// moving between assessments may ask about unsaved changes from an earlier test: leave them
const leaveUnsaved = () => { const d = w.document.querySelector("dialog.ask[open]"); if (d && /Leave without saving/.test(d.textContent)) d.querySelector("button[value=ok]").click(); };
const unlocked = (doc) => { const d = VA.clone(doc); d.weightsLocked = false; d.templateWeights = VA.weightSnapshot(d); return d; };
const reread = (d) => VA.parse(VA.write(d, {}), "a.va2").doc;
await test("a factor zeroed because it doesn't apply, and left unanswered, stays out of comparisons", () => {
  const d = unlocked(lockedDoc), c = VA.calculate(d);
  const i = d.rows.findIndex((r, k) => c.rows[k].scored && c.rows[k].answered);
  d.rows[i].weight = 0; d.rows[i].score = ""; d.rows[i].scoreOv = null;
  assert.equal(VA.weightsDiffer(d), true, "it does differ from the template's");
  assert.equal(VA.weightsDiffer(d, true), false, "but not for comparing");
  assert.equal(VA.summarise(d).template, undefined);
  const j = d.rows.findIndex((r, k) => k > i && c.rows[k].scored && c.rows[k].answered);
  d.rows[j].weight = d.rows[j].weight === 25 ? 100 : 25;
  const fair = VA.onTemplateWeights(d);
  assert.equal(fair.rows[i].weight, 0, "the factor that doesn't apply stays out");
  assert.equal(fair.rows[j].weight, lockedDoc.rows[j].weight, "the changed one goes back");
  assert.equal(VA.restoreTemplateWeights(VA.clone(d)).rows[i].weight, lockedDoc.rows[i].weight, "locking again puts every weighting back");
});
await test("a dimension that repeats a factor's name keeps each one's weighting", () => {
  const d0 = VA.clone(lockedDoc);
  d0.rows.forEach((r) => (r.id = null));
  const [a, b] = d0.rows.map((r, k) => k).filter((k) => d0.rows[k].range && d0.rows[k].dimension === d0.rows[d0.rows.findIndex((x) => x.range)].dimension).slice(0, 2);
  d0.rows[b].factor = d0.rows[a].factor; d0.rows[a].weight = 100; d0.rows[b].weight = 50;
  const back = reread(unlocked(d0));
  assert.equal(new Set(VA.weightKeys(back.rows)).size, back.rows.length);
  assert.equal(VA.weightsDiffer(back), false, "nothing changed");
  back.rows[b].weight = 75;
  assert.equal(VA.weightsDiffer(back), true);
  const r = VA.restoreTemplateWeights(back);
  assert.equal(r.rows[a].weight, 100); assert.equal(r.rows[b].weight, 50);
});
await test("names with odd characters read back the same, and a locked file drops any copy", () => {
  const d0 = VA.clone(lockedDoc);
  const k = d0.rows.findIndex((r) => r.range);
  d0.rows.filter((r) => r.dimension === d0.rows[k].dimension).forEach((r) => (r.dimension = "Corp|e|orate"));
  d0.rows[k].factor = "Line one\nline two |e| and |c| more ";
  const back = reread(unlocked(d0));
  assert.equal(VA.weightsDiffer(back), false);
  back.rows[k].weight = back.rows[k].weight === 25 ? 100 : 25;
  assert.equal(VA.weightsDiffer(back), true);
  const locked = VA.write(unlocked(lockedDoc), {}).replace("   Weightings Locked:= No\r\n", "");
  assert.match(locked, /Template Weighting:= /);
  assert.equal(VA.parse(locked, "a.va2").doc.templateWeights, null);
});
await test("an assessment unlocked without a copy takes one from its template, or says it has none", async () => {
  const save = async (name, templateId) => {
    const text = (await readSaved()).replace(/Begin Template Settings\r\n[\s\S]*?End Section\r\n/, "").replace(/Profile Name:= [^\r\n]*/, `Profile Name:= ${name}`) + "Begin Template Settings\r\n   Weightings Locked:= No\r\nEnd Section\r\n";
    return JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/assessments/save", ${JSON.stringify({ name, va2: text, templateId })})))()`)).id;
  };
  const tid = JSON.parse(await w.eval(`(async () => JSON.stringify((await Demo.call("/api/templates/list")).templates.find((t) => t.name === "Best Practice Carbon").id))()`));
  for (const [name, templateId, words] of [["Unlocked from its template", tid, /put back on the template's weightings/], ["Unlocked from nowhere", null, /no copy of the template's weightings/]]) {
    const id = await save(name, templateId);
    w.location.hash = `/a/${id}/scorecard`;
    await wait(() => (leaveUnsaved(), w.document.querySelector("#sc-lock-warn") && w.document.querySelector("#ws-title")?.textContent.includes(name)), name);
    assert.match(w.document.querySelector("#sc-lock-warn").textContent, words, name);
  }
});
await test("locking again asks, then puts the template's weightings back", async () => {
  w.location.hash = `/a/${carbonId()}/scorecard`;
  await wait(() => (leaveUnsaved(), lockBox() && /Carbon Best Practice 2025-26/.test(w.document.querySelector("#ws-title")?.textContent || "") && !lockBox().checked), "the unlocked assessment");
  const relock = async () => { lockBox().checked = true; lockBox().dispatchEvent(new w.Event("change", { bubbles: true })); await wait(() => w.document.querySelector("dialog.ask"), "the question"); return w.document.querySelector("dialog.ask"); };
  let d = await relock();
  assert.match(d.textContent, /puts the template's weightings back/);
  d.querySelector("[data-cancel]").click();
  await wait(() => !w.document.querySelector("dialog.ask"), "the question to close");
  assert.equal(lockBox().checked, false, "still unlocked");
  d = await relock();
  d.querySelector("button[value=ok]").click();
  await wait(() => weightSel().length && weightSel().every((s) => s.disabled), "the weightings to lock");
  const text = await saveAndRead(), doc = VA.parse(text, "a.va2").doc;
  assert.doesNotMatch(text, /Weightings Locked|Template Weighting/);
  doc.rows.forEach((r, i) => assert.equal(r.weight, lockedDoc.rows[i].weight, `${r.id} ${r.factor}`));
});
await test("the weighting method is locked with the weightings", async () => {
  const id = list.find((a) => a.type === "Best Practice Carbon").id;
  w.location.hash = `/a/${id}/profile`;
  await wait(() => w.document.querySelector("input[name=wm]"), "the profile");
  assert.ok(w.document.querySelector("input[name=wm]").closest("fieldset").disabled);
  assert.match(w.document.querySelector("#ws-body").textContent, /Locked with the weightings/);
});
await test("the report's top priorities are shaded the same way, with bars", async () => {
  const id = list.find((a) => a.type === "Best Practice Carbon").id;
  w.location.hash = `/a/${id}/report`;
  await wait(() => w.document.querySelector(".prio-table tbody tr"), "the report");
  const rows = [...w.document.querySelectorAll(".prio-table tbody tr")];
  for (const tr of rows) {
    const td = tr.querySelectorAll("td.num"), [perf, conf, opp] = [0, 1, 2].map((k) => Number(td[k].textContent));
    assert.ok(td[0].getAttribute("style").includes(`--t${step(perf)}`), td[0].getAttribute("style"));
    assert.ok(td[1].getAttribute("style").includes(`--t${step(conf)}`));
    if (opp > 0) assert.ok(td[2].getAttribute("style").includes(`--n${Math.max(25, step(opp))}`));
  }
  assert.equal(Number(rows[0].querySelector(".pri-bar").style.getPropertyValue("--p")), 1, "the top priority has the full bar");
  assert.ok(Number(rows.at(-1).querySelector(".pri-bar").style.getPropertyValue("--p")) <= 1);
});
await test("a template's lock travels into its assessments, and a file that doesn't say is locked", () => {
  assert.equal(VA.parse(va2(), "a.va2").doc.weightsLocked, true);
  const tpl = VA.parse(va2(), "t.vt2").doc;
  tpl.kind = "template";
  assert.doesNotMatch(VA.write(tpl, {}), /Weightings Locked/);
  tpl.weightsLocked = false;
  const back = VA.parse(VA.write(tpl, {}), "t.vt2").doc;
  assert.equal(back.weightsLocked, false);
  assert.equal(VA.fromTemplate(back, {}).weightsLocked, false);
  assert.equal(VA.fromTemplate(VA.parse(va2(), "t.vt2").doc, {}).weightsLocked, true);
});
await test("a template can say which standard function it's for, in the file and the editor", async () => {
  const tpl = VA.parse(va2(), "t.vt2").doc;
  tpl.kind = "template"; tpl.function = "hw.winter"; tpl.levels = "function,process";
  const text = VA.write(tpl, {});
  // it counts only on a Highways template that can be used on functions or processes
  assert.doesNotMatch(VA.write({ ...tpl, levels: "service" }, {}), /Template Function/);
  assert.doesNotMatch(VA.write({ ...tpl, service: "Waste" }, {}), /Template Function/);
  assert.match(VA.write({ ...tpl, levels: "service,process" }, {}), /Template Function/);
  assert.match(text, /Template Function:= hw\.winter\r\n/);
  assert.equal(VA.parse(text, "t.vt2").doc.function, "hw.winter");
  assert.equal(VA.parse(text.replace("hw.winter", "hw.made-up"), "t.vt2").doc.function, "", "only the FHRG's keys are kept");
  const a = VA.fromTemplate(VA.parse(text, "t.vt2").doc, {});
  assert.doesNotMatch(VA.write(a, {}), /Template Function/, "an assessment doesn't carry it");
  // the editor: set it, save, and it's in the file and the list
  const own = JSON.parse(await w.eval(`(async () => JSON.stringify((await Demo.call("/api/templates/list", {})).templates.find((t) => t.name === "Depot options appraisal")))()`));
  w.location.hash = `/templates/${own.id}`;
  await wait(() => { const d = w.document.querySelector("dialog.ask[open]"); if (d) d.querySelector("button[value=ok]").click(); return w.document.querySelector("#te-lock"); }, "the template editor");
  assert.equal(w.document.querySelector("#te-fn"), null, "not offered for a service-level template");
  const lv = w.document.querySelector('[data-level="function"]');
  lv.checked = true; lv.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => w.document.querySelector("#te-fn"), "the function's choice once it can be used on functions");
  const pick = (v) => { const s = w.document.querySelector("#te-fn"); s.value = v; s.dispatchEvent(new w.Event("change", { bubbles: true })); };
  pick("hw.drainage");
  w.document.querySelector("#te-save").click();
  await wait(() => /Saved/.test(w.document.querySelector("#te-status")?.textContent || ""), "the template to save");
  const got = JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/templates/get", { id: ${own.id} })))()`));
  assert.match(got.vt2, /Template Function:= hw\.drainage/);
  assert.equal(got.template.std_function, "hw.drainage");
  pick("");
  w.document.querySelector("#te-save").click();
  let cleared = false;
  for (let i = 0; i < 60 && !cleared; i++) {
    await new Promise((r) => setTimeout(r, 100));
    cleared = !/Template Function/.test(JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/templates/get", { id: ${own.id} })))()`)).vt2);
  }
  assert.ok(cleared, "the function cleared");
  // a service-only version doesn't keep it: unticking function level takes the choice away
  const lv2 = w.document.querySelector('[data-level="function"]');
  pick("hw.drainage");
  lv2.checked = false; lv2.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => !w.document.querySelector("#te-fn"), "the choice gone with function level");
  w.document.querySelector("#te-save").click();
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const g = JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/templates/get", { id: ${own.id} })))()`));
    gone = !/Template Function/.test(g.vt2) && g.template.std_function === null && !/function/.test(g.template.levels);
  }
  assert.ok(gone, "a service-only template keeps no function");
});
await test("the template editor locks weightings by default, and says why", async () => {
  w.location.hash = "/templates/5";
  await wait(() => { const d = w.document.querySelector("dialog.ask"); if (d) d.querySelector("button[value=ok]").click(); return w.document.querySelector("#te-lock"); }, "the template editor");
  const box = w.document.querySelector("#te-lock");
  assert.equal(box.checked, true);
  assert.match(box.closest(".field").textContent, /benchmarking/);
  box.checked = false; box.dispatchEvent(new w.Event("change", { bubbles: true }));
  w.document.querySelector("#te-save").click();
  await wait(() => /Saved/.test(w.document.querySelector("#te-status")?.textContent || ""), "the template to save");
  const vt2 = JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call("/api/templates/get", { id: 5 })))()`)).vt2;
  assert.match(vt2, /Weightings Locked:= No/);
  assert.equal(VA.parse(vt2, "t.vt2").doc.weightsLocked, false);
  const was = w.document.querySelector("#te-name").value;
  w.location.hash = "/templates/new";
  await wait(() => w.document.querySelector("#te-lock") && w.document.querySelector("#te-name").value !== was, "a new template");
  assert.equal(w.document.querySelector("#te-lock").checked, true, "a new template starts locked");
});
await test("the public page holds no real authority's data, and guidance for only a few factors", () => {
  assert.ok(!/cheshire|ringway|mukona|buckingham|bucks council|central bedfordshire/i.test(html));
  const st = Array.from(w.eval("STARTERS"));
  assert.equal(st.length, 4, "Climate Readiness stays in the members' library");
  assert.ok(!/Is there a named senior owner accountable/.test(html));
  for (const s of st) assert.ok(Object.keys(s.guidance).length <= 3, s.name);
  // five of the FHRG's function templates, value for money and carbon, with factors and weightings only
  const fn = Array.from(w.eval("FUNCTION_STARTERS"));
  assert.equal(fn.length, 10);
  assert.deepEqual([...new Set(fn.map((s) => s.key))].sort(), ["hw.carriageways", "hw.drainage", "hw.street-lighting", "hw.structures", "hw.winter"]);
  for (const s of fn) {
    assert.deepEqual(Object.keys(s).sort(), ["description", "key", "levels", "name", "rows", "type"], s.name);
    assert.ok(Array.from(s.rows).every((r) => r.length === 7 && typeof r[2] === "string" && r[2].length <= 80), s.name);
  }
});
await test("the template names are clean", () => {
  const names = Array.from(w.eval("STARTERS")).flatMap((s) => Array.from(s.rows).map((r) => r[2]));
  assert.deepEqual(names.filter((n) => / \? /.test(n)), []);
});
// ----- factors that don't apply
await test("a factor that doesn't apply is weighted 0 while locked, left out, and keeps its weighting to come back", () => {
  const d = VA.clone(lockedDoc), c = VA.calculate(d);
  const i = d.rows.findIndex((r, k) => c.rows[k].scored && c.rows[k].answered), w0 = d.rows[i].weight;
  VA.setNotApplicable(d, i, true);
  assert.equal(d.rows[i].weight, 0); assert.equal(d.rows[i].score, ""); assert.equal(d.weightsLocked, true);
  assert.equal(VA.calculate(d).factors, c.factors - 1, "left out of the scores");
  const text = VA.write(d, {});
  assert.match(text, /Not Applicable:= /); assert.doesNotMatch(text, /Weightings Locked/);
  const back = VA.parse(text, "a.va2").doc;
  assert.equal(back.rows[i].na, true); assert.equal(back.rows[i].naWeight, w0);
  assert.equal(VA.summarise(back).template, undefined, "nothing extra to compare");
  back.weightsLocked = false; back.templateWeights = VA.weightSnapshot(back);
  assert.equal(VA.weightsDiffer(back), false, "unlocking keeps the template's weighting aside");
  VA.restoreTemplateWeights(back);
  assert.equal(back.rows[i].weight, 0, "locking again leaves it out still");
  VA.setNotApplicable(back, i, false);
  assert.equal(back.rows[i].weight, w0); assert.equal(back.rows[i].na, false);
  assert.equal(VA.weightsDiffer(back), false, "unmarked, it's at the template's weighting again");
  const z = VA.clone(lockedDoc), k = z.rows.findIndex((r) => r.range);
  z.rows[k].weight = 0; VA.setNotApplicable(z, k, true); VA.setNotApplicable(z, k, false);
  assert.equal(z.rows[k].weight, 0, "a factor the template weights 0 comes back at 0");
  const tpl = VA.toTemplate(VA.parse(text, "a.va2").doc);
  assert.equal(tpl.rows[i].weight, w0, "a template made from it has the weighting back");
});
await test("on the scorecard, marking a factor as not applying keeps the weightings locked", async () => {
  const leave = () => { const d = w.document.querySelector("dialog.ask[open]"); if (d && /Leave without saving/.test(d.textContent)) d.querySelector("button[value=ok]").click(); };
  leave(); w.location.hash = `/a/${carbonId()}/scorecard`;
  await wait(() => (leave(), lockBox() && /Carbon Best Practice 2025-26/.test(w.document.querySelector("#ws-title")?.textContent || "")), "the scorecard");
  assert.equal(lockBox().checked, true);
  const s = rowsWith("score").find((x) => valueOf(x) !== null), i = s.closest(".f-row").dataset.i;
  const row = () => sc().querySelector(`.f-row[data-i="${i}"]`);
  const before = row().querySelector('select[data-k="weight"]').value;
  row().querySelector(`[data-more="${i}"]`).click();
  await wait(() => sc().querySelector(`[data-drawer="${i}"] [data-na]`), "the factor's notes");
  const box = sc().querySelector(`[data-drawer="${i}"] [data-na]`);
  box.checked = true; box.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => w.document.querySelector("dialog.ask[open]"), "the question");
  assert.match(w.document.querySelector("dialog.ask[open]").textContent, /answers cleared/);
  w.document.querySelector("dialog.ask[open] button[value=ok]").click();
  await wait(() => row()?.classList.contains("na"), "the factor to be marked");
  assert.ok(row().querySelector(".na-chip")); assert.equal(row().querySelector('select[data-k="score"]').disabled, true);
  assert.equal(lockBox().checked, true, "still locked");
  const text = await saveAndRead();
  assert.match(text, /Not Applicable:= /); assert.doesNotMatch(text, /Weightings Locked/);
  const box2 = sc().querySelector(`[data-drawer="${i}"] [data-na]`);
  box2.checked = false; box2.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => row() && !row().classList.contains("na"), "the factor to apply again");
  assert.equal(row().querySelector('select[data-k="weight"]').value, before, "its weighting is back");
  assert.doesNotMatch(await saveAndRead(), /Not Applicable/);
});
// ----- services, and copying a template to another service or level
const acceptLeave = () => { const d = w.document.querySelector("dialog.ask[open]"); if (d && /Leave without saving/.test(d.textContent)) d.querySelector("button[value=ok]").click(); };
const demoCall = async (path, body = {}) => JSON.parse(await w.eval(`(async () => JSON.stringify(await Demo.call(${JSON.stringify(path)}, ${JSON.stringify(body)})))()`));
const openTemplates = async () => {
  // from another page, so the list is drawn afresh
  if (/\/templates$/.test(w.location.hash)) { w.location.hash = "/benchmarks"; await wait(() => !w.document.querySelector("[data-copy]") && !/Loading/.test(w.document.querySelector("#main")?.textContent || ""), "another page"); }
  acceptLeave(); w.location.hash = "/templates";
  await wait(() => (acceptLeave(), /Scorecard templates/.test(w.document.querySelector("#main")?.textContent || "") && w.document.querySelector("[data-copy]")), "the templates");
};
const cardOf = (name) => [...w.document.querySelectorAll(".tcard")].find((c) => c.querySelector("h3")?.textContent === name);
const set = (el, v) => { if (el.type === "checkbox") el.checked = v; else el.value = v; el.dispatchEvent(new w.Event(el.tagName === "INPUT" && el.type !== "checkbox" ? "input" : "change", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); };
const saveTemplate = async () => {
  w.document.querySelector("#te-save").click();
  await wait(() => { const d = w.document.querySelector("dialog.ask[open]"); if (d && /Save with problems/.test(d.textContent)) d.querySelector("button[value=ok]").click(); return /^Saved$/.test(w.document.querySelector("#te-status")?.textContent || ""); }, "the template to save");
};
await test("swapping a service's name keeps capitals, and leaves the names of bodies and laws alone", () => {
  const sw = (s, to = "Waste") => VA.swapWords(s, "Highways", to);
  assert.equal(sw("Highways budget"), "Waste budget");
  assert.equal(sw("the highway network and HIGHWAYS teams"), "the waste network and WASTE teams");
  assert.equal(sw("Liaison with Highways England and the Highway Code, then highways"), "Liaison with Highways England and the Highway Code, then waste");
  assert.equal(sw("Highwayside"), "Highwayside", "only whole words");
  assert.equal(sw("Highways", "highways"), "Highways", "the same service changes nothing");
  assert.equal(VA.swapWords("Parks & Gardens (North) budget, and parks & gardens (north) staff", "Parks & Gardens (North)", "Waste"), "Waste budget, and waste staff", "names ending in punctuation");
  assert.equal(sw("the highways team", "SEN Transport"), "the SEN transport team", "an acronym keeps its capitals");
});
await test("copying never merges two dimensions into one", () => {
  const d = VA.blankDoc();
  d.rows = [["Highway network", 100], ["Waste network", 200]].flatMap(([dim, id]) => [{ id, dimension: dim, factor: dim, tier: 0, weight: null, range: "" }, { id: id + 1, dimension: dim, factor: "A factor", tier: 1, weight: 50, range: "Excellent To Poor" }]);
  d.guidance = { "dim:Highway network": { desc: "Roads", levels: {} }, "dim:Waste network": { desc: "Bins", levels: {} } };
  const changes = VA.swapService(d, "Highways", "Waste");
  assert.equal(JSON.stringify(VA.dimensions(d.rows)), JSON.stringify(["Highway network", "Waste network"]));
  assert.equal(Object.keys(d.guidance).length, 2);
  assert.ok(changes.some((c) => c.where === "Dimension kept"));
});
await test("template cards say which service and level they're for", async () => {
  await openTemplates();
  assert.match(cardOf("Value for Money (Highways)").textContent, /Highways · Service level/);
});
await test("copying to another service swaps its name, and opens the copy to be tailored", async () => {
  cardOf("Value for Money (Highways)").querySelector("[data-copy]").click();
  await wait(() => w.document.querySelector("dialog.ask[open] #cp-svc"), "the copy dialog");
  const d = w.document.querySelector("dialog.ask[open]");
  assert.deepEqual([...d.querySelectorAll("#cp-svc option")].map((o) => o.textContent), ["Highways", "Transport", "Waste", "Add a service…"]);
  assert.equal(d.querySelector("#cp-hide"), null, "a member can't hide an FHRG template");
  set(d.querySelector("#cp-svc"), "Waste");
  assert.equal(d.querySelector("#cp-name").value, "Value for Money (Waste)");
  set(d.querySelector('input[name="lv_function"]'), true);
  set(d.querySelector('input[name="lv_service"]'), false);
  d.querySelector("button[value=ok]").click();
  await wait(() => w.document.querySelector("#te-copy-note"), "the copy in the editor");
  const note = w.document.querySelector("#te-copy-note").textContent;
  assert.match(note, /A copy of "Value for Money \(Highways\)" for Waste, at Function level/);
  assert.match(note, /from "Highways" to "Waste"/);
  assert.match(note, /Type: Value for Money \(Highways\) → Value for Money \(Waste\)/);
  assert.equal(w.document.querySelector("#te-svc").value, "Waste");
  assert.equal(w.document.querySelector("#te-type").value, "Value for Money (Waste)");
  assert.equal(w.document.querySelector('[data-level="function"]').checked, true);
  assert.equal(w.document.querySelector('[data-level="service"]').checked, false);
  await saveTemplate();
  assert.equal(w.document.querySelector("#te-copy-note"), null, "the note goes once it's saved");
  const saved = (await demoCall("/api/templates/list")).templates.find((x) => x.name === "Value for Money (Waste)");
  assert.equal(saved.service, "Waste"); assert.equal(saved.levels, "function"); assert.equal(saved.profile_type, "Value for Money (Waste)");
  assert.match((await demoCall("/api/templates/get", { id: saved.id })).vt2, /Template Service:= Waste\r\n/);
  assert.ok((await demoCall("/api/templates/list")).templates.find((x) => x.name === "Value for Money (Highways)").visible, "the original stays");
});
await test("moving a template to a new service hides the original once the copy is saved", async () => {
  await openTemplates();
  cardOf("Depot options appraisal").querySelector("[data-copy]").click();
  await wait(() => w.document.querySelector("dialog.ask[open] #cp-svc"), "the copy dialog");
  const d = w.document.querySelector("dialog.ask[open]");
  set(d.querySelector("#cp-svc"), "");
  assert.equal(d.querySelector("#cp-new-wrap").hidden, false, "a new service can be named");
  set(d.querySelector("#cp-new"), "Parks and open spaces");
  assert.equal(d.querySelector("#cp-name").value, "Depot options appraisal (Parks and open spaces)", "Highways isn't in its name, so the service is added");
  set(d.querySelector("#cp-hide"), true);
  d.querySelector("button[value=ok]").click();
  await wait(() => w.document.querySelector("#te-copy-note"), "the copy in the editor");
  assert.match(w.document.querySelector("#te-copy-note").textContent, /The original will be hidden once it's saved/);
  assert.ok((await demoCall("/api/services/list")).services.some((s) => s.name === "Parks and open spaces" && !s.fhrg), "the new service is the authority's own");
  await saveTemplate();
  const list = (await demoCall("/api/templates/list")).templates;
  assert.equal(list.find((x) => x.name === "Depot options appraisal").visible, false);
  assert.equal(list.find((x) => x.name === "Depot options appraisal (Parks and open spaces)").service, "Parks and open spaces");
  acceptLeave(); w.location.hash = "/new";
  await wait(() => /New assessment/.test(w.document.querySelector("#main")?.textContent || "") && w.document.querySelector(".tcard"), "the new assessment page");
  assert.equal(cardOf("Depot options appraisal"), undefined, "a hidden template isn't offered");
  await openTemplates();
  const hidden = w.document.querySelector(".hidden-tpls");
  assert.match(hidden.textContent, /Depot options appraisal/);
  hidden.querySelector("[data-show-t]").click();
  await wait(() => !w.document.querySelector(".hidden-tpls") && cardOf("Depot options appraisal"), "it to be offered again");
});
await test("FHRG administrators keep the list of services", async () => {
  acceptLeave(); w.location.hash = "/admin/templates";
  await wait(() => /Only the FHRG team/.test(w.document.querySelector("#main")?.textContent || ""), "the admin page, refused to a lead");
  const role = w.document.querySelector("#demo-role");
  set(role, "admin");
  await wait(() => w.document.querySelector("#svc-add"), "the services");
  const rows = () => [...w.document.querySelectorAll("#admin-svcs tbody tr")].map((r) => r.textContent);
  assert.ok(rows().some((r) => /Highways/.test(r)) && rows().some((r) => /Parks and open spaces.*Northbridge Council/.test(r)));
  const f = w.document.querySelector("#svc-add");
  f.querySelector("input").value = "Libraries";
  f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => rows().some((r) => /Libraries/.test(r)), "the new service");
  const used = rows().findIndex((r) => /Parks and open spaces/.test(r));
  w.document.querySelectorAll("#admin-svcs tbody tr")[used].querySelector("[data-svc-del]").click();
  await wait(() => w.document.querySelector("dialog.ask[open]"), "the question");
  w.document.querySelector("dialog.ask[open] button[value=ok]").click();
  await wait(() => /so it stays/.test(w.document.querySelector("#svc-msg")?.textContent || ""), "the refusal");
  const lib = rows().findIndex((r) => /Libraries/.test(r));
  w.document.querySelectorAll("#admin-svcs tbody tr")[lib].querySelector("[data-svc-del]").click();
  await wait(() => w.document.querySelector("dialog.ask[open]"), "the question");
  w.document.querySelector("dialog.ask[open] button[value=ok]").click();
  await wait(() => !rows().some((r) => /Libraries/.test(r)), "it to go");
  // an FHRG template moves only as an FHRG template: copied for one authority, the original can't be hidden
  await openTemplates();
  cardOf("Best Practice Carbon").querySelector("[data-copy]").click();
  await wait(() => w.document.querySelector("dialog.ask[open] #cp-scope"), "the copy dialog");
  const d = w.document.querySelector("dialog.ask[open]");
  assert.equal(d.querySelector("#cp-hide"), null, "the default for its type stays");
  d.querySelector("[data-cancel]").click();
  await wait(() => !w.document.querySelector("dialog.ask[open]"), "the dialog to close");
  const spare = await demoCall("/api/templates/save", { name: "Spare FHRG template", scope: "fhrg", vt2: VA.write(VA.parse((await demoCall("/api/templates/get", { id: 1 })).vt2, "t.vt2").doc, {}) });
  await openTemplates();
  cardOf("Spare FHRG template").querySelector("[data-copy]").click();
  await wait(() => w.document.querySelector("dialog.ask[open] #cp-hide"), "the copy dialog");
  const d2 = w.document.querySelector("dialog.ask[open]");
  assert.equal(d2.querySelector("#cp-hide").disabled, false);
  set(d2.querySelector("#cp-scope"), "authority");
  assert.equal(d2.querySelector("#cp-hide").disabled, true, "a copy for one authority can't move an FHRG template");
  d2.querySelector("[data-cancel]").click();
  await wait(() => !w.document.querySelector("dialog.ask[open]"), "the dialog to close");
  await demoCall("/api/templates/delete", { id: spare.id });
  set(role, "lead");
  await wait(() => w.document.querySelector(".nav [data-admin]").hidden, "the lead's view");
});
// ----- the organisation map
const mapText = () => w.document.querySelector(".stage")?.textContent || "";
const nodeNamed = (name) => [...w.document.querySelectorAll("[data-node]")].find((b) => b.querySelector(".nd-label").textContent === name);
const shareOf = (name) => nodeNamed(name)?.querySelector(".bub-v").textContent;
const hubName = () => w.document.querySelector("[data-hub] .hub-title")?.textContent;
const openMap = async () => {
  acceptLeave();
  w.location.hash = "/map";
  await wait(() => (acceptLeave(), w.document.querySelector(".stage [data-hub]")), "the map");
  // back to the top, wherever an earlier test left it
  w.document.querySelector("[data-crumb='0']").click();
  await wait(() => hubName() === "Northbridge Council", "the organisation in the middle");
};
await test("the map has the organisation in the middle and its services around it, with their shares", async () => {
  await openMap();
  assert.equal(w.document.querySelector('.nav a[data-path="/"]').textContent, "Organisation", "it's the home page");
  assert.deepEqual([...w.document.querySelectorAll("[data-node] .nd-label")].map((x) => x.textContent), ["Highways", "Transport"]);
  assert.equal(shareOf("Highways"), "67%"); assert.equal(shareOf("Transport"), "33%");
  assert.match(nodeNamed("Highways").textContent, /15 functions/);
  assert.equal(w.document.querySelectorAll(".hub-ring path").length, 2, "the ring shows the two shares");
  assert.ok(w.document.querySelector("[data-hub]").disabled, "nothing above the organisation");
  assert.match(w.document.querySelector("#map-panel h2").textContent, /Northbridge Council/);
  // a new service is offered from the same list as templates, less those already on the map
  const offered = [...w.document.querySelectorAll("#map-svcs option")].map((o) => o.value);
  assert.ok(offered.includes("Waste") && !offered.includes("Highways"), offered.join());
});
await test("opening a service shows its functions, and the middle goes back up", async () => {
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways in the middle");
  assert.equal(w.document.querySelectorAll("[data-node]").length, 15);
  assert.equal(w.document.querySelectorAll(".hub-ring path").length, 15);
  assert.deepEqual([...w.document.querySelectorAll(".map-crumbs button")].map((b) => b.textContent), ["Northbridge Council", "Highways"]);
  // the functions' weightings add up to 950, so carriageways' 100 is about a tenth
  assert.equal(shareOf("Carriageways"), "11%");
  const total = [...w.document.querySelectorAll("[data-node] .bub-v")].reduce((a, x) => a + parseFloat(x.textContent), 0);
  assert.ok(Math.abs(total - 100) <= 8, `shares add to about 100 (${total})`);
  nodeNamed("Winter service").click();
  await wait(() => hubName() === "Winter service", "the winter service's processes");
  assert.deepEqual([...w.document.querySelectorAll("[data-node]")].map((b) => [b.querySelector(".nd-label").textContent, b.querySelector(".bub-v").textContent]),
    [["Precautionary gritting", "57%"], ["Snow clearance", "29%"], ["Salt and grit bins", "14%"]]);
  // a process is the last level: clicking one selects it rather than opening it
  nodeNamed("Snow clearance").click();
  await wait(() => /Snow clearance/.test(w.document.querySelector("#map-panel h2").textContent), "the process in the panel");
  assert.equal(hubName(), "Winter service");
  assert.equal(w.document.querySelector("#map-add"), w.document.querySelector("#map-add-name").form, "processes can be added here");
  w.document.querySelector("[data-hub]").click();
  await wait(() => hubName() === "Highways", "back to Highways");
  w.document.querySelector("[data-hub]").click();
  await wait(() => hubName() === "Northbridge Council", "back to the top");
});
await test("an item's weighting, name and facts are set in the panel beside the map", async () => {
  await openMap();
  nodeNamed("Transport").click();
  await wait(() => hubName() === "Transport", "Transport in the middle");
  // the item in the middle lists what's below it, with their weightings and shares
  const kid = (name) => [...w.document.querySelectorAll(".kid-weights tbody tr")].find((r) => r.cells[0].textContent === name);
  assert.equal(kid("Passenger transport").cells[2].textContent, "57%");
  set(kid("Passenger transport").querySelector("select"), "25");
  await wait(() => shareOf("Passenger transport") === "25%", "the new share");
  assert.equal(shareOf("Transport planning"), "75%");
  assert.equal(kid("Transport planning").cells[2].textContent, "75%");
  // an item opened in the middle is set in the panel: its name, its weighting among its siblings, its facts
  nodeNamed("Passenger transport").click();
  await wait(() => hubName() === "Passenger transport", "the function in the middle");
  assert.match(w.document.querySelector("#map-panel").textContent, /25% of Transport/);
  set(w.document.querySelector("#mi-weight"), "100");
  await wait(() => /57% of Transport/.test(w.document.querySelector("#map-panel").textContent), "the weighting back");
  w.document.querySelector("#mi-name").value = "Bus services";
  w.document.querySelector("#map-item").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => hubName() === "Bus services", "the new name");
  assert.match(w.document.querySelector(".map-crumbs").textContent, /Bus services/);
  // facts: an amount is saved as a number and shown in pounds; a wrong one is refused and marked
  const budget = () => [...w.document.querySelectorAll("[data-fact]")].find((x) => /Revenue budget/.test(w.document.querySelector(`label[for=${x.id}]`).textContent));
  set(budget(), "1250000");
  await wait(() => budget().value === "£1,250,000", "the amount in pounds");
  const org = await demoCall("/api/org/get"), id = org.items.find((x) => x.name === "Bus services").id;
  assert.equal(org.values[id][budget().dataset.fact], "1250000");
  set(budget(), "lots");
  await wait(() => budget().getAttribute("aria-invalid") === "true", "the refusal");
  set(budget(), "");
  await wait(() => budget().getAttribute("aria-invalid") === null, "the fact cleared");
  assert.equal((await demoCall("/api/org/get")).values[id]?.[budget().dataset.fact], undefined);
  const model = [...w.document.querySelectorAll("select[data-fact]")][0];
  assert.deepEqual([...model.options].map((o) => o.value), ["", "In-house", "Outsourced", "Mixed"]);
  // put it back for the tests that follow
  w.document.querySelector("#mi-name").value = "Passenger transport";
  w.document.querySelector("#map-item").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => hubName() === "Passenger transport", "the name back");
});
await test("items are added and removed, and removing one with others below it asks first", async () => {
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  const add = (name) => { w.document.querySelector("#map-add-name").value = name; w.document.querySelector("#map-add").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); };
  add("<i>Fleet</i> & depots");
  await wait(() => nodeNamed("<i>Fleet</i> & depots"), "the new function");
  assert.equal(w.document.querySelector(".stage i"), null, "a name is shown as text, never as markup");
  assert.match(w.document.querySelector("#map-panel h2").textContent, /Fleet/, "the new item is selected");
  nodeNamed("<i>Fleet</i> & depots").click();
  await wait(() => hubName() === "<i>Fleet</i> & depots", "the new function in the middle");
  add("Vehicle servicing");
  await wait(() => nodeNamed("Vehicle servicing"), "a process below it");
  w.document.querySelector("[data-hub]").click();
  await wait(() => hubName() === "Highways", "back to Highways");
  // going back up keeps it selected, so it can be removed from here
  assert.match(w.document.querySelector("#map-panel h2").textContent, /Fleet/);
  assert.ok(nodeNamed("<i>Fleet</i> & depots").classList.contains("sel"));
  w.document.querySelector("#mi-remove").click();
  await wait(() => /Remove <i>Fleet/.test(w.document.querySelector("dialog.ask[open] h2")?.textContent || ""), "the first question");
  w.document.querySelector("dialog.ask[open] button[value=ok]").click();
  await wait(() => /Remove everything below it too/.test(w.document.querySelector("dialog.ask[open] h2")?.textContent || ""), "the second question");
  assert.match(w.document.querySelector("dialog.ask[open]").textContent, /1 item below it/);
  w.document.querySelector("dialog.ask[open] button[value=ok]").click();
  await wait(() => hubName() === "Highways" && !nodeNamed("<i>Fleet</i> & depots"), "it and its process to go");
  assert.equal(w.document.querySelectorAll("[data-node]").length, 15);
  assert.ok(!(await demoCall("/api/org/get")).items.some((x) => x.name === "Vehicle servicing"));
});
await test("an authority adds facts of its own to its property sheets", async () => {
  await openMap();
  const f = w.document.querySelector("#fact-add");
  f.querySelector("#fa-name").value = "Depots";
  f.querySelector("#fa-kind").value = "number";
  f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => /Depots/.test(w.document.querySelector(".facts-sheet").textContent), "the new fact");
  const label = [...w.document.querySelectorAll(".fact label")].find((l) => /Depots/.test(l.textContent));
  assert.match(label.textContent, /your own/);
  assert.equal(w.document.querySelectorAll(".fact label .chip").length, 1, "the FHRG's facts aren't marked as your own");
});
await test("circles round the middle keep apart, however uneven the shares", async () => {
  // where the circles are drawn, with the stage's height (720 to its 1,000 width, or square for many) taken into account
  const least = () => {
    const pts = [...w.document.querySelectorAll("[data-node]")].map((b) => ({ x: parseFloat(b.style.left), y: parseFloat(b.style.top) }));
    const high = w.document.querySelector(".stage").classList.contains("tall") ? 1 : 0.72;
    let d = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) d = Math.min(d, Math.hypot(pts[i].x - pts[j].x, (pts[i].y - pts[j].y) * high));
    return d;
  };
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  assert.ok(least() > 9, `15 functions ${least().toFixed(1)} apart`);
  // labels above or below their circles are narrower than the gap between neighbours there
  const lv = parseFloat(w.document.querySelector(".stage").dataset.lv);
  for (const side of ["above", "below"]) {
    const xs = [...w.document.querySelectorAll(`.nd.${side}`)].map((b) => parseFloat(b.style.left)).sort((a, z) => a - z);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= lv - 0.01, `${side}: ${xs.join()} with labels ${lv}% wide`);
  }
  // one big share and several tiny ones: the small circles are spread out rather than bunched in the big one's gap
  const org = await demoCall("/api/org/get"), drainage = org.items.find((x) => x.name === "Drainage");
  const added = [];
  for (const [name, weight] of [["Gully cleansing", 100], ["Culverts", 0], ["Soakaways", 0], ["Flood response", 0], ["Ditches", 0]]) {
    const r = await demoCall("/api/org/item", { action: "add", parentId: drainage.id, name });
    await demoCall("/api/org/item", { action: "weight", id: r.id, weight });
    added.push(r.id);
  }
  // they were added behind the page's back, so open the map afresh
  w.location.hash = "/guidance";
  await wait(() => !w.document.querySelector(".stage"), "another page");
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  nodeNamed("Drainage").click();
  await wait(() => hubName() === "Drainage" && w.document.querySelectorAll("[data-node]").length === 5, "the drainage processes");
  assert.ok(least() > 14, `uneven shares ${least().toFixed(1)} apart`);
  assert.equal(w.document.querySelectorAll(".hub-ring path").length, 1, "only shares that count are drawn on the ring");
  assert.equal(shareOf("Gully cleansing"), "100%"); assert.equal(shareOf("Culverts"), "0%");
  // more than a ring can hold: a list
  for (let k = 1; k <= 16; k++) added.push((await demoCall("/api/org/item", { action: "add", parentId: drainage.id, name: `Catchment ${k}` })).id);
  w.location.hash = "/guidance";
  await wait(() => !w.document.querySelector(".stage"), "another page");
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  nodeNamed("Drainage").click();
  await wait(() => hubName() === "Drainage" && w.document.querySelectorAll("[data-node]").length === 21, "21 processes");
  assert.ok(w.document.querySelector(".stage").classList.contains("list"));
  for (const id of added) await demoCall("/api/org/item", { action: "remove", id });
  w.document.querySelector("[data-crumb='0']").click();
  await wait(() => hubName() === "Northbridge Council", "back to the top");
});
await test("a member can't remove the standard items, only the lead", async () => {
  const role = w.document.querySelector("#demo-role");
  set(role, "member");
  await wait(() => !/Authority lead/.test(w.document.querySelector("#account").textContent), "the member's view");
  await openMap();
  assert.equal(w.document.querySelector("#mi-remove"), null, "nothing to remove at the top");
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  assert.equal(w.document.querySelector("#mi-remove"), null, "Highways can't be removed by a member");
  const hw = (await demoCall("/api/org/get")).items.find((x) => x.name === "Highways");
  const refused = await demoCall("/api/org/item", { action: "remove", id: hw.id, withEverything: true }).then(() => "", (e) => String(e?.message ?? e));
  assert.match(refused, /only your authority's lead/i);
  set(role, "lead");
  await wait(() => /Authority lead/.test(w.document.querySelector("#account").textContent), "the lead's view");
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways" && w.document.querySelector("#mi-remove"), "the lead's Remove");
  w.document.querySelector("[data-crumb='0']").click();
  await wait(() => hubName() === "Northbridge Council", "back to the top");
});
// ----- assessments on the map
const panelText = () => w.document.querySelector("#map-panel")?.textContent || "";
const panelLinks = () => [...w.document.querySelectorAll("#map-panel .ma-list a.title")].map((a) => a.textContent);
await test("the map shows each item's assessments, and opens them", async () => {
  await openMap();
  assert.equal(nodeNamed("Highways").querySelector(".bub-n").textContent, "8", "a count on the circle");
  assert.match(nodeNamed("Highways").textContent, /15 functions · 8 assessments/);
  assert.equal(nodeNamed("Transport").querySelector(".bub-n"), null);
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways" && /Assessments/.test(panelText()), "Highways and its assessments");
  assert.match(w.document.querySelector("[data-hub]").textContent, /8 assessments/);
  assert.equal(panelLinks().length, 8);
  assert.ok(panelLinks().includes("Northbridge Value for Money 2025-26"));
  // its own value for money and carbon assessments, on the FHRG's carriageways templates, and the business case
  assert.equal(nodeNamed("Carriageways").querySelector(".bub-n").textContent, "3");
  assert.equal(nodeNamed("Drainage").querySelector(".bub-n").textContent, "2");
  assert.equal(nodeNamed("Footways and cycleways").querySelector(".bub-n"), null);
  nodeNamed("Carriageways").click();
  await wait(() => hubName() === "Carriageways", "Carriageways");
  assert.deepEqual(panelLinks().sort(), ["Northbridge Carriageways Best Practice Carbon 2025-26", "Northbridge Carriageways Value for Money 2025-26", "Resurfacing programme business case"]);
  // open one, and come back to where it sits
  [...w.document.querySelectorAll("#map-panel .ma-list a.title")].find((a) => a.textContent === "Resurfacing programme business case").click();
  await wait(() => /Resurfacing programme business case/.test(w.document.querySelector("#ws-title")?.textContent || ""), "the assessment");
  const back = [...w.document.querySelectorAll(".ws-head .meta a")].find((a) => a.textContent === "Carriageways");
  assert.ok(back, "it says where it is on the map");
  back.click();
  await wait(() => hubName() === "Carriageways" && /Resurfacing/.test(panelText()), "back on the map at Carriageways");
  assert.deepEqual([...w.document.querySelectorAll(".map-crumbs button")].map((b) => b.textContent), ["Northbridge Council", "Highways", "Carriageways"]);
});
await test("an assessment started from the map is offered only the templates that fit, and starts on the item", async () => {
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  nodeNamed("Drainage").click();
  await wait(() => hubName() === "Drainage" && w.document.querySelector("#map-panel a[href*='item=']"), "Drainage's start button");
  w.document.querySelector("#map-panel a[href*='item=']").click();
  await wait(() => /For Drainage on your map/.test(w.document.querySelector("main").textContent), "the templates for Drainage");
  const offered = [...w.document.querySelectorAll(".tcard")].filter((c) => c.querySelector("a[href*='template=']")).map((c) => c.querySelector("h3").textContent);
  // the FHRG's drainage templates, not another function's, and the business case, which suits any function
  assert.deepEqual(offered.sort(), ["Drainage Best Practice Carbon", "Drainage Value for Money", "Programme & Project Business Case"], offered.join(" / "));
  [...w.document.querySelectorAll(".tcard")].find((c) => c.querySelector("h3").textContent === "Programme & Project Business Case").querySelector("a.btn").click();
  await wait(() => w.document.querySelector("#nf"), "the new assessment form");
  assert.match(w.document.querySelector("aside").textContent, /it'll go on Drainage/);
  w.document.querySelector("#nf-name").value = "Drainage culvert renewal case";
  w.document.querySelector("#nf").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => /Drainage culvert renewal case/.test(w.document.querySelector("#ws-title")?.textContent || ""), "the new assessment");
  assert.ok([...w.document.querySelectorAll(".ws-head .meta a")].some((a) => a.textContent === "Drainage"));
  const org = await demoCall("/api/org/get"), list = (await demoCall("/api/assessments/list")).assessments;
  assert.equal(list.find((a) => a.name === "Drainage culvert renewal case").org_item_id, org.items.find((x) => x.name === "Drainage").id);
  // a process within winter service is offered winter's templates and the business case only
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  nodeNamed("Winter service").click();
  await wait(() => hubName() === "Winter service", "winter");
  nodeNamed("Snow clearance").click();
  await wait(() => /Snow clearance/.test(w.document.querySelector("#map-panel h2").textContent), "the process");
  w.document.querySelector("#map-panel a[href*='item=']").click();
  await wait(() => /For Snow clearance on your map/.test(w.document.querySelector("main").textContent), "the templates for the process");
  assert.deepEqual([...w.document.querySelectorAll(".tcard")].filter((c) => c.querySelector("a[href*='template=']")).map((c) => c.querySelector("h3").textContent).sort(),
    ["Programme & Project Business Case", "Winter service Best Practice Carbon", "Winter service Value for Money"]);
  // and the demonstration refuses to put a carriageways assessment on drainage, as the server does
  const all = (await demoCall("/api/assessments/list")).assessments, map = await demoCall("/api/org/get");
  const cwA = all.find((a) => a.name === "Northbridge Carriageways Value for Money 2025-26"), dr = map.items.find((x) => x.name === "Drainage");
  const why = await demoCall("/api/assessments/attach", { id: cwA.id, itemId: dr.id }).then(() => "", (e) => String(e?.message ?? e));
  assert.match(why, /from a template for Carriageways, so it goes on that function or a process within it/);
  // and benchmarks a function assessment only with the same function's: no other authority has one here
  // even without "same scorecard template", which would otherwise let in other authorities' service assessments
  const peers = await demoCall("/api/benchmarks/peers", { assessmentId: cwA.id, sameTemplate: false });
  assert.equal(peers.ok, false); assert.equal(peers.count, 0);
  const svc = all.find((a) => a.name === "Northbridge Value for Money 2025-26");
  assert.equal((await demoCall("/api/benchmarks/peers", { assessmentId: svc.id })).ok, true, "the service's own comparison still works");
  // a service with no template of its own says so, and offers no button
  await openMap();
  nodeNamed("Transport").click();
  await wait(() => hubName() === "Transport", "Transport");
  assert.equal(w.document.querySelector("#map-panel a[href*='item=']"), null);
  assert.match(panelText(), /No template is set for service level for Transport yet/);
});
await test("an assessment is taken off the map and put back from the panel", async () => {
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways" && panelLinks().length === 8, "Highways' eight");
  const row = [...w.document.querySelectorAll("#map-panel .ma-list li")].find((li) => /Value for Money 2023-24/.test(li.textContent));
  row.querySelector("[data-unplace]").click();
  await wait(() => panelLinks().length === 7, "seven left");
  const vfm = (await demoCall("/api/assessments/list")).assessments.find((a) => /Value for Money 2023-24/.test(a.name));
  assert.equal(vfm.org_item_id, null, "taken off the map, still in the list");
  const pick = w.document.querySelector("#ma-pick");
  assert.ok([...pick.options].some((o) => Number(o.value) === vfm.id), "offered to put back");
  assert.ok([...pick.options].some((o) => o.textContent === "Resurfacing programme business case (now on Carriageways)"), "one elsewhere is offered as a move");
  set(pick, String(vfm.id));
  w.document.querySelector("#ma-place").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => panelLinks().length === 8, "back to eight");
});
await test("removing an item keeps its assessments, and says so first", async () => {
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  w.document.querySelector("#map-add-name").value = "Pothole pilot";
  w.document.querySelector("#map-add").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => nodeNamed("Pothole pilot"), "the new function");
  nodeNamed("Pothole pilot").click();
  await wait(() => hubName() === "Pothole pilot" && w.document.querySelector("#map-panel a[href*='item=']"), "its start button");
  w.document.querySelector("#map-panel a[href*='item=']").click();
  await wait(() => w.document.querySelector(".tcard a.btn"), "the templates");
  const any = [...w.document.querySelectorAll(".tcard h3")].map((h) => h.textContent);
  assert.ok(any.includes("Carriageways Value for Money") && any.includes("Winter service Best Practice Carbon"), "a function the authority added can use any function's template");
  [...w.document.querySelectorAll(".tcard")].find((c) => c.querySelector("h3").textContent === "Programme & Project Business Case").querySelector("a.btn").click();
  await wait(() => w.document.querySelector("#nf"), "the form");
  w.document.querySelector("#nf-name").value = "Pothole pilot case";
  w.document.querySelector("#nf").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => /Pothole pilot case/.test(w.document.querySelector("#ws-title")?.textContent || ""), () => `the new assessment (${w.document.querySelector("#nf-msg")?.textContent || w.document.querySelector("main").textContent.slice(0, 200)})`);
  [...w.document.querySelectorAll(".ws-head .meta a")].find((a) => a.textContent === "Pothole pilot").click();
  await wait(() => hubName() === "Pothole pilot" && w.document.querySelector("#mi-remove"), "back on the map");
  w.document.querySelector("#mi-remove").click();
  await wait(() => w.document.querySelector("dialog.ask[open]"), "the question");
  assert.match(w.document.querySelector("dialog.ask[open]").textContent, /The assessment on it stays in your list, off the map/);
  w.document.querySelector("dialog.ask[open] button[value=ok]").click();
  await wait(() => hubName() === "Highways" && !nodeNamed("Pothole pilot"), "the item gone");
  const kept = (await demoCall("/api/assessments/list")).assessments.find((a) => a.name === "Pothole pilot case");
  assert.ok(kept); assert.equal(kept.org_item_id, null);
});
await test("a copy saved as a new assessment stays on the same item, and the open one follows changes on the map", async () => {
  await openMap();
  nodeNamed("Highways").click();
  await wait(() => hubName() === "Highways", "Highways");
  nodeNamed("Carriageways").click();
  await wait(() => hubName() === "Carriageways" && panelLinks().length === 3, "Carriageways' assessments");
  [...w.document.querySelectorAll("#map-panel .ma-list a.title")].find((a) => a.textContent === "Resurfacing programme business case").click();
  await wait(() => /Resurfacing programme business case/.test(w.document.querySelector("#ws-title")?.textContent || ""), "the assessment");
  w.document.querySelector('[data-act="saveas"]').click();
  await wait(() => w.document.querySelector("dialog[open] #dlg-text"), "the name");
  w.document.querySelector("dialog[open] #dlg-text").value = "Resurfacing programme option B";
  w.document.querySelector("dialog[open] button[value=ok]").click();
  await wait(() => /option B/.test(w.document.querySelector("#ws-title")?.textContent || ""), "the copy");
  assert.ok([...w.document.querySelectorAll(".ws-head .meta a")].some((a) => a.textContent === "Carriageways"), "the copy says it's on Carriageways");
  const copy = (await demoCall("/api/assessments/list")).assessments.find((a) => a.name === "Resurfacing programme option B");
  const cw = (await demoCall("/api/org/get")).items.find((x) => x.name === "Carriageways");
  assert.equal(copy.org_item_id, cw.id, "and it is");
  // renamed on the map: the open assessment shows the new name
  [...w.document.querySelectorAll(".ws-head .meta a")].find((a) => a.textContent === "Carriageways").click();
  await wait(() => hubName() === "Carriageways" && w.document.querySelector("#mi-name"), "the map");
  assert.equal(panelLinks().length, 4);
  // only what fits a function is offered to put here: not the service-level value for money assessments
  const offer = [...(w.document.querySelector("#ma-pick")?.options || [])].map((o) => o.textContent);
  assert.ok(offer.some((x) => /Drainage culvert renewal case/.test(x)), offer.join(" / "));
  assert.ok(!offer.some((x) => /Value for Money|Carbon|Depot/.test(x)), offer.join(" / "));

  w.document.querySelector("#mi-name").value = "Carriageways <b>and</b> roads";
  w.document.querySelector("#map-item").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => hubName() === "Carriageways <b>and</b> roads", "the new name");
  assert.equal(w.document.querySelector("#map-panel b b, #map-panel h2 b"), null, "a name is shown as text");
  acceptLeave();
  w.location.hash = `/a/${copy.id}/scorecard`;
  await wait(() => [...w.document.querySelectorAll(".ws-head .meta a")].some((a) => a.textContent === "Carriageways <b>and</b> roads"), "the new name on the assessment");
  // the new-assessment page names it as text too
  acceptLeave();
  w.location.hash = `/new?item=${cw.id}`;
  await wait(() => /For Carriageways <b>and<\/b> roads on your map/.test(w.document.querySelector("main").textContent), "the new-assessment page");
  assert.equal(w.document.querySelector("main .notice b"), null);
  // put the name back
  await demoCall("/api/org/item", { action: "rename", id: cw.id, name: "Carriageways" });
});
await test("the organisation map is the home page, and the assessments page keeps the list and new assessments", async () => {
  acceptLeave();
  w.location.hash = "/assessments";
  await wait(() => (acceptLeave(), w.document.querySelector("#list-body")), "the assessments page");
  assert.ok(w.document.querySelector('.hero a[href*="/new"]'), "a new assessment starts here");
  assert.equal(w.document.querySelector(".nav a[aria-current]").textContent, "Assessments");
  w.location.hash = "/";
  await wait(() => w.document.querySelector(".stage [data-hub]"), "the map at home");
  assert.equal(w.document.querySelector(".nav a[aria-current]").textContent, "Organisation");
  w.location.hash = "/map";
  await wait(() => w.document.querySelector(".stage [data-hub]") && w.document.querySelector(".nav a[aria-current]")?.textContent === "Organisation", "the map's own address");
  w.location.hash = "/new";
  await wait(() => w.document.querySelector(".nav a[aria-current]")?.textContent === "Assessments", "new assessments under Assessments");
  // an assessment's crumbs lead back to the list, not the map
  const id = (await demoCall("/api/assessments/list")).assessments.find((a) => a.name === "Northbridge Value for Money 2025-26").id;
  w.location.hash = `/a/${id}/scorecard`;
  await wait(() => w.document.querySelector("#ws-title"), "an assessment");
  assert.match(w.document.querySelector(".crumbs a").getAttribute("href"), /\/assessments$/);
  assert.equal(w.document.querySelector(".nav a[aria-current]").textContent, "Assessments");
});
await test("a page someone has left doesn't paint its error over the next one", async () => {
  acceptLeave();
  w.location.hash = "/a/999999";
  await new Promise((r) => setTimeout(r, 20));
  w.location.hash = "/guidance";
  await wait(() => (acceptLeave(), /How the Value Analyser works/.test(w.document.querySelector("main h1")?.textContent || "")), "the guidance");
  await new Promise((r) => setTimeout(r, 400));
  assert.doesNotMatch(w.document.querySelector("main").textContent, /Something went wrong/);
  assert.match(w.document.querySelector("main h1").textContent, /How the Value Analyser works/);
});
await test("the sign-in card offers the Northbridge demonstration beside Sign in, as Clarion's does", async () => {
  // an earlier test may leave unsaved changes: say yes to leaving them
  const leave = () => w.document.querySelector("dialog.ask[open] button[value=ok]")?.click();
  leave();
  w.location.hash = "/assessments";
  await wait(() => (leave(), w.document.querySelector("#signout") && w.document.querySelector("#list-body") && /Northbridge Value for Money 2025-26/.test(w.document.querySelector("#main").textContent)), "the assessments");
  w.document.querySelector("#signout").click();
  await wait(() => (leave(), w.document.querySelector("#signin")), "the sign-in card");
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
