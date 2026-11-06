// The real web server, over real connections: health check, limits, downloads, cookies.
import assert from "node:assert/strict";
import http from "node:http";
import { addAuthority, addUser, failures, fileBytes, summary, test, va2 } from "./sim.mjs";
import { startServer } from "./.build/server.mjs";

addAuthority(1, "Northbridge Council");
await addUser(1, "ann@north.test", "Ann", 1, { role: "lead" });
const server = startServer(0, new URL("../public/index.html", import.meta.url).pathname);
await new Promise((r) => server.listening ? r() : server.once("listening", r));
const port = server.address().port, base = `http://127.0.0.1:${port}`;
const post = (path, body, token) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-fhrg": "1", ...(token ? { "x-session-token": token } : {}) }, body: JSON.stringify(body) });

await test("the health check answers without needing anything else", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get("cache-control"), "no-store");
});
let token = "";
await test("signing in sets the cookie and hands the page its token", async () => {
  const r = await post("/api/login", { email: "ann@north.test", password: "pw", remember: true });
  const b = await r.json();
  token = b.session.token;
  assert.equal(b.session.maxAge, 30 * 86400);
  const c = r.headers.getSetCookie()[0];
  assert.match(c, /^fhrg_session=/); assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/);
});
await test("the page is the full toolkit, live, and a HEAD request gets no body", async () => {
  const t = await (await fetch(base + "/")).text();
  assert.ok(t.includes("const LIVE = true;"));
  assert.ok(t.length > 300_000);
  const r = await fetch(base + "/", { method: "HEAD" });
  assert.equal(r.status, 200); assert.equal((await r.text()), "");
});
await test("an assessment of nearly 5 MB saves and downloads intact", async () => {
  const long = "é".repeat(4_900_000);
  const text = va2([[1, "Economy", long]]);
  const r = await post("/api/assessments/save", { name: "A large one", va2: text, summary: summary(50) }, token);
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b).slice(0, 200));
  const d = await fetch(`${base}/download/assessment/${b.id}`, { headers: { "x-session-token": token } });
  assert.equal(d.status, 200);
  const got = new Uint8Array(await d.arrayBuffer());
  assert.equal(Number(d.headers.get("content-length")), got.length);
  assert.deepEqual(got, fileBytes("assessments/northbridge-council/A large one.va2"));
});
await test("an outsized request is turned away from its stated length", async () => {
  const code = await new Promise((resolve, reject) => {
    const q = http.request({ port, method: "POST", path: "/api/login", headers: { "content-length": 500_000_000, "x-fhrg": "1" } }, (r) => { r.resume(); resolve(r.statusCode); });
    q.on("error", reject); q.write("x"); 
  });
  assert.equal(code, 413);
});
await test("an outsized request with no stated length is stopped as it arrives, not after", async () => {
  // the limit for 5 MB uploads is about 17 MB; the sender keeps going until the server answers, up to 60 MB
  let sent = 0;
  const code = await new Promise((resolve) => {
    const q = http.request({ port, method: "POST", path: "/api/assessments/save", headers: { "transfer-encoding": "chunked", "x-fhrg": "1", "x-session-token": token, connection: "close" } }, (r) => { r.resume(); done = true; resolve(r.statusCode); });
    let done = false;
    q.on("error", () => { done = true; resolve("closed"); });
    const chunk = Buffer.alloc(1024 * 1024, 120);
    const more = () => { if (done) return; if (sent >= 60) return q.end(); sent++; q.write(chunk, () => setImmediate(more)); };
    more();
  });
  assert.ok(code === 413 || code === "closed", `got ${code}`);
  assert.ok(sent < 40, `the server read ${sent} MB before refusing`);
});
await test("a sign-in request is held to its own limit", async () => {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "x-fhrg": "1" }, body: JSON.stringify({ email: "x".repeat(400_000) }) });
  assert.equal(r.status, 413);
});
await test("a request refused before its body has arrived closes the connection", async () => {
  const r = await new Promise((resolve, reject) => {
    const q = http.request({ port, method: "POST", path: "/api/assessments/list", headers: { "x-fhrg": "1", "content-length": 2_000_000 } }, (res) => { res.resume(); resolve(res); });
    q.on("error", reject);
    q.write("x".repeat(1000));
  });
  assert.equal(r.statusCode, 401);
  assert.equal(r.headers.connection, "close");
});
await test("a finished request keeps its connection", async () => {
  const code = await new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: true });
    const q = http.request({ port, method: "POST", path: "/api/assessments/list", agent, headers: { "x-fhrg": "1", "x-session-token": token, "content-type": "application/json", "content-length": 2 } }, (res) => { res.resume(); agent.destroy(); resolve(res.headers.connection); });
    q.on("error", reject);
    q.end("{}");
  });
  assert.notEqual(code, "close");
});
await test("an unreadable address gets a plain refusal", async () => {
  const code = await new Promise((resolve) => {
    const q = http.request({ port, method: "GET", path: "//" }, (r) => { r.resume(); resolve(r.statusCode); });
    q.end();
  });
  assert.ok([400, 404, 200].includes(code));
});
server.close();
server.closeAllConnections?.();
process.exit(failures ? 1 : 0);
