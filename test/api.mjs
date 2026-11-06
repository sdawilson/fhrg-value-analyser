// The toolkit's routes, run against simulated storage and a real SQL database. Refusals are proved with someone
// from another authority, a plain member and nobody at all.
import assert from "node:assert/strict";
import { addAuthority, addUser, env, failures, fileBytes, files, hash, putFile, sim, sql, store, summary, test, va2 } from "./sim.mjs";
import { handleRequest, setPage } from "./.build/app.mjs";

setPage(`<script>const LIVE = false;</script>`);
const send = (path, { method = "POST", body, token, headers = {} } = {}) => handleRequest(new Request(`https://value-analyser.invalid${path}`, {
  method, headers: { ...(method === "POST" ? { "content-type": "application/json", "x-fhrg": "1" } : {}), ...(token ? { "x-session-token": token } : {}), ...headers },
  body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
}));
const call = async (path, body, token, headers) => { const r = await send(path, { body, token, headers }); return { status: r.status, ...(await r.json()) }; };
let ip = 0;
const login = async (email, password = "pw") => (await call("/api/login", { email, password }, null, { "x-real-ip": `10.0.0.${++ip}` })).session?.token;
const expectStatus = (r, status, what = "") => assert.equal(r.status, status, `${what} ${JSON.stringify(r).slice(0, 200)}`);

addAuthority(1, "Northbridge Council"); addAuthority(2, "Eastshire County Council"); addAuthority(3, "Westshire Council"); addAuthority(4, "Southshire Council");
addAuthority(5, "Waiting Council", "pending"); addAuthority(6, "Lapsed Council", "suspended"); addAuthority(9, "FHRG");
await addUser(1, "ann@north.test", "Ann", 1, { role: "lead" }); await addUser(2, "bob@north.test", "Bob", 1); await addUser(3, "cat@east.test", "Cat", 2);
await addUser(4, "dee@west.test", "Dee", 3); await addUser(5, "eve@south.test", "Eve", 4); await addUser(6, "fay@wait.test", "Fay", 5);
await addUser(7, "gus@lapsed.test", "Gus", 6); await addUser(8, "pending@north.test", "Pen", 1, { status: "pending" }); await addUser(10, "off@north.test", "Off", 1, { status: "suspended" });
await addUser(11, "boss@fhrg.test", "Boss", 9);
putFile("templates/fhrg/Value for Money (Highways) (Default).vt2", va2());

const ann = await login("ann@north.test"), bob = await login("bob@north.test"), cat = await login("cat@east.test"), boss = await login("boss@fhrg.test");
const dee = await login("dee@west.test"), eve = await login("eve@south.test");

// ----- signing in
await test("a member signs in, and the session works by header and by cookie", async () => {
  assert.ok(ann);
  const a = await (await send("/api/boot", { method: "GET", token: ann })).json();
  assert.equal(a.me.authority, "Northbridge Council");
  const r = await (await send("/api/boot", { method: "GET", headers: { cookie: `other=1; fhrg_session=${ann}` } })).json();
  assert.equal(r.me.email, "ann@north.test");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'va-login'").get().n > 0, true);
});
await test("boot sends only what the page needs", async () => {
  const a = await (await send("/api/boot", { method: "GET", token: ann })).json();
  assert.deepEqual(Object.keys(a).sort(), ["features", "fhrgSite", "limits", "me"]);
  assert.equal(JSON.stringify(a).includes("password"), false);
  assert.equal(a.fhrgSite, "https://fhrg.co.uk");
});
await test("a wrong password and an unknown email get the same answer", async () => {
  const a = await call("/api/login", { email: "ann@north.test", password: "no" }, null, { "x-real-ip": "10.1.0.1" });
  const b = await call("/api/login", { email: "nobody@north.test", password: "no" }, null, { "x-real-ip": "10.1.0.2" });
  expectStatus(a, 401); expectStatus(b, 401);
  assert.equal(a.error, b.error);
});
await test("people who aren't approved are turned away with the reason", async () => {
  for (const [email, words] of [["fay@wait.test", /waiting for approval by the FHRG/], ["gus@lapsed.test", /switched off/], ["pending@north.test", /lead/], ["off@north.test", /switched off/]]) {
    const r = await call("/api/login", { email, password: "pw" }, null, { "x-real-ip": "10.1.0.3" });
    expectStatus(r, 403, email); assert.match(r.error, words); assert.equal(r.session, undefined);
  }
});
await test("eight wrong passwords from one network stop tries there, even with the right password", async () => {
  await addUser(20, "try@north.test", "Try", 1);
  for (let i = 0; i < 8; i++) expectStatus(await call("/api/login", { email: "try@north.test", password: "no" }, null, { "x-real-ip": "10.2.0.1" }), 401, `try ${i}`);
  const r = await call("/api/login", { email: "try@north.test", password: "pw" }, null, { "x-real-ip": "10.2.0.1" });
  expectStatus(r, 429); assert.equal(r.session, undefined);
});
await test("someone guessing from elsewhere doesn't lock the real person out", async () => {
  expectStatus(await call("/api/login", { email: "try@north.test", password: "pw" }, null, { "x-real-ip": "10.2.9.9" }), 200);
});
await test("guessing from many places at once still meets a limit for the account", async () => {
  await addUser(26, "wide@north.test", "Wide", 1);
  for (let i = 0; i < 60; i++) expectStatus(await call("/api/login", { email: "wide@north.test", password: "no" }, null, { "x-real-ip": `10.6.${i}.1` }), 401, `try ${i}`);
  expectStatus(await call("/api/login", { email: "wide@north.test", password: "no" }, null, { "x-real-ip": "10.7.0.1" }), 429);
});
await test("moving around one block of modern addresses doesn't get round the limit", async () => {
  await addUser(27, "six@north.test", "Six", 1);
  for (let i = 0; i < 8; i++) expectStatus(await call("/api/login", { email: "six@north.test", password: "no" }, null, { "x-real-ip": `2001:db8:1:2:${i + 1}::9` }), 401, `try ${i}`);
  expectStatus(await call("/api/login", { email: "six@north.test", password: "no" }, null, { "x-real-ip": "2001:db8:1:2:ffff::1" }), 429);
});
await test("a sign-in request is held to a small size", async () => {
  expectStatus(await call("/api/login", { email: "x".repeat(20_000), password: "no" }, null, { "x-real-ip": "10.8.0.1" }), 413);
});
await test("thirty wrong passwords from one address stop that address, not others", async () => {
  for (let i = 0; i < 30; i++) expectStatus(await call("/api/login", { email: `n${i}@x.test`, password: "no" }, null, { "x-real-ip": "10.3.0.1" }), 401, `try ${i}`);
  expectStatus(await call("/api/login", { email: "ann@north.test", password: "pw" }, null, { "x-real-ip": "10.3.0.1" }), 429);
  expectStatus(await call("/api/login", { email: "ann@north.test", password: "pw" }, null, { "x-real-ip": "10.3.0.2" }), 200);
});
await test("a right password doesn't use up the allowance", async () => {
  for (let i = 0; i < 12; i++) expectStatus(await call("/api/login", { email: "bob@north.test", password: "pw" }, null, { "x-real-ip": "10.4.0.1" }), 200, `try ${i}`);
});
await test("the database being down isn't counted as a wrong password", async () => {
  sim.databaseDown = true;
  await addUser(21, "busy@north.test", "Busy", 1);
  for (let i = 0; i < 10; i++) assert.equal((await call("/api/login", { email: "busy@north.test", password: "pw" }, null, { "x-real-ip": "10.5.0.1" })).status, 500);
  sim.databaseDown = false;
  expectStatus(await call("/api/login", { email: "busy@north.test", password: "pw" }, null, { "x-real-ip": "10.5.0.1" }), 200);
});
await test("a tampered session, or one signed with the website's secret, isn't accepted", async () => {
  const [p, s] = ann.split(".");
  assert.equal((await (await send("/api/boot", { method: "GET", token: `${p}.${s.slice(0, -2)}xx` })).json()).me, null);
  const other = Buffer.from(JSON.stringify({ u: 1, v: "x", exp: Date.now() + 1e7 })).toString("base64url");
  assert.equal((await (await send("/api/boot", { method: "GET", token: `${other}.${s}` })).json()).me, null);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("the-website-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const row = sql.prepare("SELECT password_hash AS h FROM users WHERE id = 1").get();
  const payload = Buffer.from(JSON.stringify({ u: 1, v: row.h.slice(-12), exp: Date.now() + 1e7 })).toString("base64url");
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url");
  assert.equal((await (await send("/api/boot", { method: "GET", token: `${payload}.${sig}` })).json()).me, null);
});
await test("changing a password on the website ends sessions here", async () => {
  await addUser(22, "move@north.test", "Move", 1);
  const t = await login("move@north.test");
  sql.prepare("UPDATE users SET password_hash = ? WHERE id = 22").run(await hash("new"));
  assert.equal((await (await send("/api/boot", { method: "GET", token: t })).json()).me, null);
});
await test("a calling site can't post without the page's header", async () => {
  const r = await handleRequest(new Request("https://value-analyser.invalid/api/assessments/list", { method: "POST", headers: { "x-session-token": ann, "content-type": "text/plain" }, body: "{}" }));
  assert.equal(r.status, 403);
});

// ----- templates
let tid = 0;
await test("the FHRG's template in storage appears for everyone, with (Default) read from its name", async () => {
  const r = await call("/api/templates/list", {}, cat);
  assert.equal(r.templates.length, 1);
  assert.equal(r.templates[0].name, "Value for Money (Highways)");
  assert.equal(r.templates[0].is_default, true);
  assert.equal(r.templates[0].fhrg, true);
  assert.equal(r.templates[0].factors, 2);
});
await test("a member saves a template for their own authority, and it stays theirs", async () => {
  const r = await call("/api/templates/save", { name: "Our template", vt2: va2([[1, "Economy", "One"]]) }, bob);
  expectStatus(r, 200); tid = r.id;
  assert.ok(files("templates/northbridge-council/").includes("templates/northbridge-council/Our template.vt2"));
  assert.equal((await call("/api/templates/list", {}, cat)).templates.some((t) => t.id === tid), false);
  expectStatus(await call("/api/templates/get", { id: tid }, cat), 404);
  assert.equal((await send(`/download/template/${tid}`, { method: "GET", token: cat })).status, 404);
});
await test("only its creator or the lead can change a template", async () => {
  await addUser(23, "other@north.test", "Other", 1);
  const other = await login("other@north.test");
  expectStatus(await call("/api/templates/save", { id: tid, baseVersion: 1, name: "Our template", vt2: va2() }, other), 403);
  expectStatus(await call("/api/templates/delete", { id: tid }, other), 403);
  expectStatus(await call("/api/templates/save", { id: tid, baseVersion: 1, name: "Our template", vt2: va2() }, ann), 200);
});
await test("saving an old copy of a template is stopped", async () => {
  const r = await call("/api/templates/save", { id: tid, baseVersion: 1, name: "Our template", vt2: va2() }, bob);
  expectStatus(r, 409); assert.equal(r.conflict.version, 2);
});
await test("only the FHRG team can touch the FHRG's templates", async () => {
  expectStatus(await call("/api/templates/save", { name: "Mine now", scope: "fhrg", vt2: va2() }, ann), 403);
  const id = (await call("/api/templates/list", {}, ann)).templates.find((t) => t.fhrg).id;
  expectStatus(await call("/api/templates/delete", { id }, ann), 403);
  expectStatus(await call("/api/templates/save", { id, baseVersion: 1, name: "Changed", vt2: va2() }, ann), 403);
  expectStatus(await call("/api/templates/delete", { id }, boss), 400); // it's the default
});
await test("an authority's template can't be used by another authority's assessment", async () => {
  const r = await call("/api/assessments/save", { name: "Borrowed template", va2: va2(), templateId: tid, summary: summary(50) }, cat);
  expectStatus(r, 200);
  assert.equal((await call("/api/assessments/open", { id: r.id }, cat)).assessment.template_id, null);
  await call("/api/assessments/delete", { id: r.id }, cat);
});

// ----- assessments
let aid = 0;
const text = va2([[101, "Economy", "Unit costs – £ per m²"], [201, "Efficiency", "Process time"]]);
await test("an assessment is saved in the workbook's encoding and comes back the same", async () => {
  const r = await call("/api/assessments/save", { name: "Highways 2026", va2: text, summary: summary(62), profileType: "Value for Money (Highways)", reportingYear: "2026" }, bob);
  expectStatus(r, 200); aid = r.id;
  const bytes = fileBytes("assessments/northbridge-council/Highways 2026.va2");
  assert.ok(bytes.includes(0xa3) && bytes.includes(0x96), "£ and – are single Windows-1252 bytes");
  const o = await call("/api/assessments/open", { id: aid }, bob);
  assert.equal(o.va2, text);
  assert.equal(o.assessment.score, 62);
  assert.equal(o.assessment.file_key, undefined);
});
await test("the list shows only your own authority's", async () => {
  assert.equal((await call("/api/assessments/list", {}, ann)).assessments.length, 1);
  assert.equal((await call("/api/assessments/list", {}, cat)).assessments.length, 0);
  assert.equal((await call("/api/assessments/list", { authorityId: 1 }, cat)).assessments.length, 0, "a member can't ask for another authority's");
  assert.equal((await call("/api/assessments/list", { authorityId: 1 }, boss)).assessments.length, 1);
});
await test("someone from another authority can't open, change, share, delete or download it", async () => {
  for (const [path, body] of [["open", { id: aid }], ["save", { id: aid, name: "Taken", va2: text, baseVersion: 1 }], ["share", { id: aid, shared: false }], ["delete", { id: aid }], ["versions", { id: aid }], ["restore", { id: aid, versionId: 1 }]]) {
    expectStatus(await call(`/api/assessments/${path}`, body, cat), 404, path);
  }
  assert.equal((await send(`/download/assessment/${aid}`, { method: "GET", token: cat })).status, 404);
  assert.ok(fileBytes("assessments/northbridge-council/Highways 2026.va2"));
});
await test("nobody signed in gets anything", async () => {
  for (const path of ["templates/list", "assessments/list", "assessments/open", "benchmarks/list", "benchmarks/peers", "admin/overview"]) expectStatus(await call(`/api/${path}`, { id: aid }), 401, path);
  const r = await send(`/download/assessment/${aid}`, { method: "GET" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/signin\?next=/);
});
await test("saving an old copy is stopped, and force overrides it", async () => {
  expectStatus(await call("/api/assessments/save", { id: aid, baseVersion: 1, name: "Highways 2026", va2: text, summary: summary(70) }, ann), 200);
  const stale = await call("/api/assessments/save", { id: aid, baseVersion: 1, name: "Highways 2026", va2: text, summary: summary(71) }, bob);
  expectStatus(stale, 409); assert.equal(stale.conflict.updated_by, "ann@north.test");
  expectStatus(await call("/api/assessments/save", { id: aid, baseVersion: 1, force: true, name: "Highways 2026", va2: text, summary: summary(72) }, bob), 200);
});
await test("earlier saves are kept, listed, restored and pruned to KEEP_VERSIONS", async () => {
  for (let v = 3; v < 8; v++) expectStatus(await call("/api/assessments/save", { id: aid, baseVersion: v, name: "Highways 2026", va2: va2([[v, "Economy", `Version ${v}`]]), summary: summary(v) }, bob), 200, `save ${v}`);
  const list = (await call("/api/assessments/versions", { id: aid }, bob)).versions;
  assert.equal(list.length, 3);
  assert.equal(files("versions/northbridge-council/").length, 3);
  const r = await call("/api/assessments/restore", { id: aid, versionId: list[0].id }, bob);
  assert.match(r.va2, /Version 6/);
  const dl = await send(`/download/version/${list[0].id}`, { method: "GET", token: cat });
  assert.equal(dl.status, 404);
});
await test("renaming moves the file and leaves no copy", async () => {
  const before = (await call("/api/assessments/open", { id: aid }, bob)).assessment.version;
  expectStatus(await call("/api/assessments/save", { id: aid, baseVersion: before, name: "Highways 2026 final", va2: text, summary: summary(80) }, bob), 200);
  assert.deepEqual(files("assessments/northbridge-council/"), ["assessments/northbridge-council/Highways 2026 final.va2"]);
});
await test("a second assessment can't take a name already in use", async () => {
  const r = await call("/api/assessments/save", { name: "HIGHWAYS 2026 FINAL", va2: text }, ann);
  expectStatus(r, 409); assert.equal(r.clashId, aid);
});
await test("names and files that aren't valid are refused", async () => {
  expectStatus(await call("/api/assessments/save", { name: "../../escape", va2: text }, ann), 400);
  expectStatus(await call("/api/assessments/save", { name: "A fair name", va2: "not a file" }, ann), 400);
});
await test("a file over the upload limit is refused", async () => {
  expectStatus(await call("/api/assessments/save", { name: "Too big", va2: text + "x".repeat(5 * 1024 * 1024) }, ann), 413);
});
await test("the download is the stored file, byte for byte, as a named attachment", async () => {
  const r = await send(`/download/assessment/${aid}`, { method: "GET", token: bob });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="Highways 2026 final\.va2"/);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), fileBytes("assessments/northbridge-council/Highways 2026 final.va2"));
});
await test("only the creator, a lead or the FHRG team can delete; deleting removes its files", async () => {
  const mine = (await call("/api/assessments/save", { name: "Bob's own", va2: text, summary: summary(1) }, bob)).id;
  await addUser(24, "third@north.test", "Third", 1);
  expectStatus(await call("/api/assessments/delete", { id: mine }, await login("third@north.test")), 403);
  expectStatus(await call("/api/assessments/delete", { id: mine }, ann), 200);
  assert.deepEqual(files("assessments/northbridge-council/").filter((f) => f.includes("Bob")), []);
});
await test("the FHRG team can bring in a file on an authority's behalf; a member can't", async () => {
  const r = await call("/api/assessments/save", { name: "Imported", va2: text, authorityId: 2, imported: true, summary: summary(44) }, boss);
  expectStatus(r, 200);
  assert.ok(files("assessments/eastshire-county-council/").length === 1);
  const o = await call("/api/assessments/save", { name: "Planted", va2: text, authorityId: 3, summary: summary(44) }, cat);
  assert.equal((await call("/api/assessments/open", { id: o.id }, cat)).assessment.authority_id, 2);
  await call("/api/assessments/delete", { id: o.id }, cat);
});

// ----- benchmarking
await test("peers: below the minimum, no figures at all", async () => {
  const r = await call("/api/benchmarks/peers", { assessmentId: aid }, bob);
  assert.equal(r.ok, false); assert.equal(r.count, 1); assert.equal(r.benchmark, undefined);
  assert.match(r.message, /At least 3/);
});
await test("peers: from three authorities, averages only, with no names", async () => {
  expectStatus(await call("/api/assessments/save", { name: "West 2026", va2: text, summary: summary(50) }, dee), 200);
  const e = await call("/api/assessments/save", { name: "South 2026", va2: text, summary: summary(60) }, eve); expectStatus(e, 200);
  const r = await call("/api/benchmarks/peers", { assessmentId: aid }, bob);
  assert.equal(r.ok, true); assert.equal(r.count, 3);
  assert.equal(r.benchmark.totals.score, 51.333);
  assert.ok(!/Eastshire|Westshire|Southshire/.test(JSON.stringify(r)));
});
await test("peers: one authority's bespoke factor doesn't reach anyone else", async () => {
  await call("/api/assessments/save", { name: "East bespoke", va2: text, summary: summary(44, { factors: { "101|Unit costs": [44, 60, 40], "201|Process time": [44, 60, 40], "999|Our secret factor": [13, 60, 40] } }) }, cat);
  const r = await call("/api/benchmarks/peers", { assessmentId: aid }, bob);
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.equal(r.benchmark.totals.min, undefined);
});
await test("peers: an assessment that isn't shared doesn't count", async () => {
  const id = (await call("/api/assessments/list", {}, eve)).assessments[0].id;
  await call("/api/assessments/share", { id, shared: false }, eve);
  assert.equal((await call("/api/benchmarks/peers", { assessmentId: aid }, bob)).ok, false);
  await call("/api/assessments/share", { id, shared: true }, eve);
});
await test("peers: another authority's assessment can't be the starting point", async () => {
  expectStatus(await call("/api/benchmarks/peers", { assessmentId: aid }, cat), 404);
});
await test("a benchmark built by the FHRG team shows members averages, and not who is in it", async () => {
  const r = await call("/api/admin/benchmark-build", { profile_type: "Value for Money (Highways)" }, boss);
  expectStatus(r, 200); assert.equal(r.members, 4);
  const seen = await call("/api/benchmarks/get", { id: r.id }, bob);
  assert.ok(seen.benchmark.summary.totals.score > 0);
  assert.equal(seen.benchmark.member_list, undefined);
  assert.ok((await call("/api/benchmarks/get", { id: r.id }, boss)).benchmark.member_list.length === 4);
  expectStatus(await call("/api/admin/benchmark-delete", { id: r.id }, bob), 403);
  const lone = await call("/api/assessments/save", { name: "A lone year", va2: text, reportingYear: "1999", summary: summary(33, { year: "1999" }) }, cat);
  expectStatus(await call("/api/admin/benchmark-build", { profile_type: "Value for Money (Highways)", reporting_year: "1999", min_members: 1 }, boss), 400, "a composite of one");
  await call("/api/assessments/delete", { id: lone.id }, cat);
  expectStatus(await call("/api/admin/benchmark-delete", { id: r.id }, boss), 200);
});

// ----- administration
await test("every administration route refuses a member, even a lead", async () => {
  for (const p of ["overview", "assessments", "authorities", "templates", "template-action", "benchmarks", "benchmark-build", "benchmark-save", "benchmark-delete", "activity"]) expectStatus(await call(`/api/admin/${p}`, {}, ann), 403, p);
  for (const p of ["assessments.csv", "dimensions.csv"]) assert.equal((await send(`/export/${p}`, { method: "GET", token: ann })).status, 403);
});
await test("site administrators come from the website's flag as well as SITE_ADMINS", async () => {
  await addUser(25, "flag@fhrg.test", "Flag", 9, { siteAdmin: 1 });
  expectStatus(await call("/api/admin/overview", {}, await login("flag@fhrg.test")), 200);
});
await test("the overview's checks run", async () => {
  const r = await call("/api/admin/overview", {}, boss);
  assert.ok(r.counts.assessments >= 3);
  assert.ok(r.checks.length >= 3);
  assert.ok(!JSON.stringify(r.checks).includes("SESSION_SECRET"));
});
await test("the activity log and template actions work", async () => {
  assert.ok((await call("/api/admin/activity", {}, boss)).log.length > 0);
  const r = await call("/api/admin/template-action", { id: tid, action: "promote", name: "Shared template" }, boss);
  expectStatus(r, 200);
  assert.ok((await call("/api/templates/list", {}, cat)).templates.some((t) => t.name === "Shared template"));
  expectStatus(await call("/api/templates/get", { id: tid }, ann), 200);
});
await test("exports reach the FHRG team as Excel-safe CSV", async () => {
  await call("/api/assessments/save", { name: "=HYPERLINK(1)", va2: text, summary: summary(5) }, bob);
  const r = await send("/export/assessments.csv", { method: "GET", token: boss });
  const t = await r.text();
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.ok(t.includes("'=HYPERLINK(1)"));
  assert.ok((await (await send("/export/dimensions.csv", { method: "GET", token: boss })).text()).includes("Economy"));
});

// ----- the page and odd requests
await test("the page is served live, with its security headers, on any of its paths", async () => {
  for (const path of ["/", "/assessments", "/a/12/report", "/signin"]) {
    const r = await send(path, { method: "GET" });
    assert.equal(r.status, 200, path);
    assert.ok((await r.text()).includes("const LIVE = true;"));
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
});
await test("unknown paths and methods are refused", async () => {
  assert.equal((await send("/api/nothing", { method: "GET" })).status, 404);
  assert.equal((await send("/nothing.php", { method: "GET" })).status, 404);
  expectStatus(await call("/api/nothing", {}, ann), 404);
  assert.equal((await handleRequest(new Request("https://value-analyser.invalid/", { method: "PUT", body: "x" }))).status, 404);
  assert.match(await (await send("/robots.txt", { method: "GET" })).text(), /Disallow: \//);
});
await test("a storage or database failure says so without showing any key", async () => {
  sim.storageDown = true;
  const r = await call("/api/assessments/open", { id: aid }, bob);
  sim.storageDown = false;
  expectStatus(r, 500);
  assert.ok(!JSON.stringify(r).includes(env.STORAGE_ACCESS_KEY + "\""));
});
await test("missing settings are named, never their values", async () => {
  const keep = process.env.STORAGE_ZONE;
  delete process.env.STORAGE_ZONE;
  const r = await send("/", { method: "GET" });
  const t = await r.text();
  const a = await call("/api/assessments/list", {}, ann);
  process.env.STORAGE_ZONE = keep;
  assert.equal(r.status, 500); assert.match(t, /STORAGE_ZONE/);
  expectStatus(a, 500); assert.match(a.error, /STORAGE_ZONE/);
});
await test("no file was stored outside the toolkit's folder", () => {
  assert.deepEqual([...store.keys()].filter((k) => !k.startsWith("value-analyser/")), []);
});
process.exit(failures ? 1 : 0);
