// Passwords and sessions. Accounts belong to the FHRG website: joining, approvals and password resets happen
// there. Password hashes are read from its database and checked here. Sessions are the toolkit's own, signed
// with its own SESSION_SECRET, so a session here can't be used on the website or the other way round.
import type { Config } from "./config";
import { audit, exec, q } from "./db";
import { FriendlyError, cleanText, delay, json, now, readJsonBody, sameText } from "./util";

export const enc = new TextEncoder();
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
export async function pbkdf2(secret: string, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: rounds }, key, 256);
  return new Uint8Array(bits);
}
export async function checkSecret(secret: string, stored: string): Promise<boolean> {
  const [kind, rounds, salt, hash] = (stored || "").split("$");
  if (kind !== "pbkdf2" || !hash) return false;
  return sameText(b64url(await pbkdf2(secret, fromB64url(salt), Number(rounds))), hash);
}
export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export const COOKIE = "fhrg_session";
export const SESSION_DAYS = 30;
export const SESSION_HOURS = 12;

// Failed sign-ins are counted in memory the moment a request arrives, before anything has to wait, so that
// many tries sent at once all count. The container runs as one copy, so this is enough. A restart clears them.
const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
const SIGNIN_MAX_PER_ACCOUNT_AND_NETWORK = 8;
const SIGNIN_MAX_PER_NETWORK = 30;
// Far higher, so someone guessing from elsewhere can't keep the real person out
const SIGNIN_MAX_PER_EMAIL = 60;
// Checked when no account matches, so a wrong email takes as long as a wrong password
const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const attempts = new Map<string, number[]>();
function countAttempt(keys: [string, number][]): boolean {
  const at = Date.now();
  for (const [k, times] of attempts) {
    const live = times.filter((t) => at - t < SIGNIN_WINDOW_MS);
    if (live.length) attempts.set(k, live); else attempts.delete(k);
  }
  if (keys.some(([k, max]) => (attempts.get(k)?.length ?? 0) >= max)) return false;
  for (const [k] of keys) attempts.set(k, [...(attempts.get(k) ?? []), at]);
  return true;
}
function giveBack(keys: string[]): void {
  for (const k of keys) {
    const times = attempts.get(k);
    if (times) { times.pop(); if (!times.length) attempts.delete(k); }
  }
}
export function clientIp(request: Request): string {
  const h = request.headers;
  // bunny.net's CDN replaces X-Real-IP and X-Forwarded-For with the visitor's address, so a visitor can't set them
  return (h.get("x-real-ip") || (h.get("x-forwarded-for") || "").split(",")[0] || "").trim();
}

// One person on a modern connection has a whole block of addresses, so limits count the block and not the address
export function networkOf(request: Request, parts = 4): string {
  const ip = clientIp(request).toLowerCase();
  if (!ip.includes(":")) return ip;
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1); // an ordinary address written the new way
  const [head, tail] = ip.split("::");
  const front = head ? head.split(":") : [], back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...new Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return groups.slice(0, parts).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

export type Me = {
  id: number; email: string; name: string; title: string; role: string; siteAdmin: boolean;
  authorityId: number; authorityName: string; authoritySlug: string; authorityKind: string;
  remembered: boolean;
};

export async function makeSession(c: Config, id: number, passwordHash: string, remember: boolean): Promise<string> {
  const exp = Date.now() + (remember ? SESSION_DAYS * 86400000 : SESSION_HOURS * 3600000);
  const payload = b64url(enc.encode(JSON.stringify({ u: id, v: passwordHash.slice(-12), exp })));
  return `${payload}.${await hmac(c.sessionSecret, payload)}`;
}
export function sessionCookie(token: string, remember: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? `; Max-Age=${SESSION_DAYS * 86400}` : ""}`;
}
// Bunny's pull zone setting "Disable Cookies" (on by default) removes Set-Cookie from replies,
// so sign-in also hands the token to the page, which stores the cookie itself and sends it back
// as the x-session-token header too.
export function signedIn(data: Record<string, unknown>, token: string, remember: boolean): Response {
  return json({ ...data, session: { token, maxAge: remember ? SESSION_DAYS * 86400 : 0 } }, 200, { "set-cookie": sessionCookie(token, remember) });
}
export const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export function cookieValue(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

export async function getMe(c: Config, request: Request): Promise<Me | null> {
  const header = (request.headers.get("x-session-token") ?? "").trim();
  const token = TOKEN_RE.test(header) ? header : cookieValue(request, COOKIE);
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !sameText(sig, await hmac(c.sessionSecret, payload))) return null;
  let d: any;
  try {
    d = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
  if (!d || typeof d.exp !== "number" || d.exp < Date.now() || typeof d.u !== "number") return null;
  const rows = await q(c, `SELECT u.id, u.email, u.name, u.title, u.role, u.status, u.site_admin, u.password_hash,
      a.id AS a_id, a.name AS a_name, a.slug AS a_slug, a.kind AS a_kind, a.status AS a_status
    FROM users u JOIN authorities a ON a.id = u.authority_id WHERE u.id = ?`, d.u);
  const u = rows[0];
  if (!u || u.status !== "approved" || String(u.password_hash).slice(-12) !== d.v) return null;
  const siteAdmin = u.site_admin === 1 || c.siteAdmins.includes(u.email);
  if (u.a_status !== "approved" && !siteAdmin) return null;
  return { id: u.id, email: u.email, name: u.name, title: u.title || "", role: u.role, siteAdmin, authorityId: u.a_id, authorityName: u.a_name, authoritySlug: u.a_slug, authorityKind: u.a_kind, remembered: d.exp - Date.now() > SESSION_HOURS * 3600000 };
}

export async function requireMe(c: Config, request: Request): Promise<Me> {
  const me = await getMe(c, request);
  if (!me) throw new FriendlyError("Please sign in with your FHRG account.", 401);
  return me;
}
export async function requireSiteAdmin(c: Config, request: Request): Promise<Me> {
  const me = await requireMe(c, request);
  if (!me.siteAdmin) throw new FriendlyError("Only the FHRG team can do that.", 403);
  return me;
}

export function publicMe(me: Me | null) {
  return me ? { name: me.name, email: me.email, title: me.title, role: me.role, siteAdmin: me.siteAdmin, authority: me.authorityName, authorityId: me.authorityId } : null;
}

export async function handleBoot(c: Config, request: Request): Promise<Response> {
  const me = await getMe(c, request);
  return json({
    me: publicMe(me),
    fhrgSite: c.fhrgSite,
    features: { versions: c.keepVersions > 0, demo: c.demo },
    limits: { maxUpload: c.maxUpload, minPeers: c.minPeers },
  });
}

export async function handleLogin(c: Config, request: Request): Promise<Response> {
  const b = await readJsonBody(request, 10_000);
  const email = cleanText(b.email, 200).toLowerCase();
  const password = typeof b.password === "string" ? b.password.slice(0, 500) : "";
  const remember = b.remember === true;
  const network = networkOf(request) || "-", ipKey = `ip|${network}`, pairKey = `pair|${email}|${network}`, emailKey = `email|${email}`;
  if (!countAttempt([[ipKey, SIGNIN_MAX_PER_NETWORK], [pairKey, SIGNIN_MAX_PER_ACCOUNT_AND_NETWORK], [emailKey, SIGNIN_MAX_PER_EMAIL]])) {
    throw new FriendlyError("Too many unsuccessful sign-ins. Wait 15 minutes and try again. If you've forgotten your password, you can reset it on the FHRG website in the meantime.", 429);
  }
  let wrongPassword = false;
  try {
    const u = (await q(c, `SELECT u.id, u.email, u.status, u.password_hash, u.site_admin, a.status AS a_status
      FROM users u JOIN authorities a ON a.id = u.authority_id WHERE u.email = ?`, email))[0];
    const ok = await checkSecret(password, u ? String(u.password_hash || "") : DUMMY_HASH);
    if (!u || !ok) {
      wrongPassword = true;
      await delay(400);
      // a set-up problem rather than a wrong password: this is linked to a database with no FHRG accounts
      if (!u && !(await q(c, "SELECT COUNT(*) AS n FROM users"))[0].n) {
        wrongPassword = false;
        throw new FriendlyError("The toolkit's database has no FHRG accounts yet. Check that BUNNY_DATABASE_URL is the FHRG website's database.", 503);
      }
      throw new FriendlyError("That email and password don't match an FHRG account.", 401);
    }
    attempts.delete(pairKey);
    const siteAdmin = u.site_admin === 1 || c.siteAdmins.includes(u.email);
    if (!siteAdmin && u.a_status === "pending") throw new FriendlyError("Your authority is waiting for approval by the FHRG team.", 403);
    if (!siteAdmin && u.a_status !== "approved") throw new FriendlyError("Your authority's access has been switched off. Contact the FHRG team.", 403);
    if (u.status === "pending") throw new FriendlyError("Your request is waiting for approval by your authority's lead.", 403);
    if (u.status !== "approved") throw new FriendlyError("This account has been switched off. Contact your authority's lead.", 403);
    await exec(c, [{ sql: "UPDATE users SET last_login = ? WHERE id = ?", args: [now(), u.id] }, audit(u.email, "va-login")]);
    const token = await makeSession(c, u.id, u.password_hash, remember);
    return signedIn({ ok: true }, token, remember);
  } finally {
    // only a wrong password counts, not a success or the database being down
    if (!wrongPassword) giveBack([ipKey, pairKey, emailKey]);
  }
}

export function handleLogout(): Response {
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}
