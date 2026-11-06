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
  w.location.hash = `/a/${id}/report`;
  await wait(() => w.document.querySelector(".kpis"), "the report");
  assert.match(w.document.querySelector("#ws-body").textContent, new RegExp(`${theirs.replace(".", "\\.")} on the template's weightings`));
  w.location.hash = `/a/${id}/scorecard`;
  await wait(() => lockBox(), "the scorecard");
});
await test("locking again asks, then puts the template's weightings back", async () => {
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
});
await test("the template names are clean", () => {
  const names = Array.from(w.eval("STARTERS")).flatMap((s) => Array.from(s.rows).map((r) => r[2]));
  assert.deepEqual(names.filter((n) => / \? /.test(n)), []);
});
await test("the sign-in card offers the Northbridge demonstration beside Sign in, as Clarion's does", async () => {
  // an earlier test may leave unsaved changes: say yes to leaving them
  const leave = () => w.document.querySelector("dialog.ask[open] button[value=ok]")?.click();
  leave();
  w.location.hash = "/";
  await wait(() => (leave(), w.document.querySelector("#signout") && /Northbridge Value for Money 2025-26/.test(w.document.querySelector("#main").textContent)), "the assessments");
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
