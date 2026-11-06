// Simulated Bunny Storage and the FHRG website's database, so the toolkit can be tested without any accounts.
// Importing this replaces fetch; requests to 127.0.0.1 (a server under test) go through. The database is real
// SQLite answering in the libSQL protocol, so every statement in the toolkit is really run.
import { webcrypto as crypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const env = {
  STORAGE_ACCESS_KEY: "key", STORAGE_ZONE: "zone", BUNNY_DATABASE_URL: "https://db.test", BUNNY_DATABASE_AUTH_TOKEN: "tok",
  SESSION_SECRET: "a-long-test-secret-of-forty-or-more-characters!!", SITE_ADMINS: "boss@fhrg.test", KEEP_VERSIONS: "3",
};
Object.assign(process.env, env);

export const store = new Map(); // path inside the zone -> Uint8Array
const enc = new TextEncoder(), dec = new TextDecoder();
export const root = "value-analyser/";
export const putFile = (path, text) => store.set(root + path, typeof text === "string" ? enc.encode(text) : text);
export const fileBytes = (path) => store.get(root + path) ?? null;
export const files = (prefix = "") => [...store.keys()].filter((k) => k.startsWith(root + prefix)).map((k) => k.slice(root.length));

export const sql = new DatabaseSync(":memory:");
// the website's tables, as it creates them
sql.exec(`CREATE TABLE authorities (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'authority',
    status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL, approved TEXT, code_used INTEGER DEFAULT 0);
  CREATE TABLE users (id INTEGER PRIMARY KEY, authority_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, title TEXT,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', site_admin INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL,
    reset_hash TEXT, reset_expires TEXT, registered TEXT NOT NULL, approved TEXT, last_login TEXT, reset_sent TEXT);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT);`);

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function hash(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}
export const addAuthority = (id, name, status = "approved") => sql.prepare("INSERT INTO authorities (id, slug, name, status, created) VALUES (?, ?, ?, ?, ?)").run(id, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, status, "2026-01-01");
// password "pw" for everyone
export async function addUser(id, email, name, authorityId, { role = "member", status = "approved", siteAdmin = 0, password = "pw" } = {}) {
  sql.prepare("INSERT INTO users (id, authority_id, email, name, title, role, status, site_admin, password_hash, registered) VALUES (?, ?, ?, ?, 'Engineer', ?, ?, ?, ?, '2026-01-01')").run(id, authorityId, email, name, role, status, siteAdmin, await hash(password));
}

export const sim = { storageDown: false, databaseDown: false, keys: [], storageCalls: 0 };

function answerDb(body) {
  const results = [];
  for (const r of body.requests) {
    if (r.type !== "execute") { results.push({ type: "ok", response: { type: "close" } }); continue; }
    try {
      const args = (r.stmt.args || []).map((a) => (a.type === "null" ? null : a.type === "integer" || a.type === "float" ? Number(a.value) : a.value));
      const st = sql.prepare(r.stmt.sql);
      const v = (x) => (x === null || x === undefined ? { type: "null" } : typeof x === "number" ? (Number.isInteger(x) ? { type: "integer", value: String(x) } : { type: "float", value: x }) : { type: "text", value: String(x) });
      let result;
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(r.stmt.sql)) {
        const rows = st.all(...args), cols = rows.length ? Object.keys(rows[0]) : [];
        result = { cols: cols.map((name) => ({ name })), rows: rows.map((row) => cols.map((c) => v(row[c]))), affected_row_count: 0, last_insert_rowid: null };
      } else {
        const o = st.run(...args);
        result = { cols: [], rows: [], affected_row_count: Number(o.changes), last_insert_rowid: String(o.lastInsertRowid) };
      }
      results.push({ type: "ok", response: { type: "execute", result } });
    } catch (e) { results.push({ type: "error", error: { message: e.message } }); }
  }
  return { results };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  if (url.hostname === "db.test") {
    if (sim.databaseDown) throw new Error("connect failed");
    if (init.headers?.Authorization !== `Bearer ${env.BUNNY_DATABASE_AUTH_TOKEN}`) return new Response("no", { status: 401 });
    return new Response(JSON.stringify(answerDb(JSON.parse(init.body))), { headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "storage.bunnycdn.com") {
    sim.storageCalls++;
    if (sim.storageDown) return new Response("down", { status: 503 });
    if (init.headers?.AccessKey !== env.STORAGE_ACCESS_KEY) return new Response("no", { status: 401 });
    const zone = `/${env.STORAGE_ZONE}/`;
    if (!url.pathname.startsWith(zone)) return new Response("no zone", { status: 404 });
    const path = decodeURIComponent(url.pathname.slice(zone.length));
    if (method === "PUT") { store.set(path, init.body instanceof Uint8Array ? new Uint8Array(init.body) : enc.encode(String(init.body))); return new Response(null, { status: 201 }); }
    if (method === "DELETE") return new Response(null, { status: store.delete(path) ? 200 : 404 });
    if (path.endsWith("/")) {
      const items = [...store.keys()].filter((k) => k.startsWith(path) && !k.slice(path.length).includes("/")).map((k) => ({ ObjectName: k.slice(path.length), Length: store.get(k).length, IsDirectory: false }));
      return new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } });
    }
    const b = store.get(path);
    return b ? new Response(b, { headers: { "content-length": String(b.length) } }) : new Response("nothing", { status: 404 });
  }
  throw new Error(`Unexpected request to ${url.hostname}`);
};

// A small .va2 in the workbook's format. rows: [id, dimension, factor]; answers come from `score`.
export function va2(rows = [[101, "Economy", "Unit costs"], [201, "Efficiency", "Process time"]], over = {}) {
  const cell = (name, type, value) => `|c|${name}|e|${type}|e|${value}|e|<None>|e|-4131|i|0|i|0|i|0|i|Arial|i|10|i|False|i|False|i|0`;
  return ["Begin Header", "   Organisation:= Test", `   Profile Type:= ${over.type || "Value for Money (Highways)"}`, "End Section", "Begin Fields", "   Assessment WA Total:= 50", "End Section", "Begin Table: VA_Assessment",
    ...rows.map(([id, dim, factor]) => `  ${cell("ID", "{N}", id)}${cell("Dimension", "{T}", dim)}${cell("Factor_Name", "{T}", factor)}`), "End Section", ""].join("\r\n");
}
export const summary = (score, over = {}) => ({
  type: "Value for Money (Highways)", year: "2026", authorityProfile: "County", weighting: "simple", totals: { score, conf: 60, opp: 40 }, answeredScore: score, completeness: 1, factorCount: 2, answered: 2,
  dims: [{ name: "Economy", score, conf: 60, opp: 40, share: 0.5, factors: 1, answered: 1 }, { name: "Efficiency", score, conf: 60, opp: 40, share: 0.5, factors: 1, answered: 1 }],
  factors: { "101|Unit costs": [score, 60, 40], "201|Process time": [score, 60, 40] }, ...over,
});

// A tiny test harness: PASS and FAIL lines are counted by run.mjs
export let failures = 0;
export async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e?.message || e}`); }
}
