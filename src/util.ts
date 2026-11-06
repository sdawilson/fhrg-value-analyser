// Small helpers used throughout.

export class FriendlyError extends Error {
  status: number;
  field?: string;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 400, field?: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.field = field;
    this.extra = extra;
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

export function sameText(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();

export function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// A request's body, refused as soon as it passes the limit (so an outsized request can't fill memory)
async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") || 0) > limit) throw new FriendlyError("That request is too large.", 413);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new FriendlyError("That request is too large.", 413); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

export async function readJsonBody(request: Request, limit = 300_000): Promise<Record<string, any>> {
  // the limit is in characters; UTF-8 takes up to three bytes for each
  const text = new TextDecoder().decode(await readBodyBytes(request, limit * 3));
  if (text.length > limit) throw new FriendlyError("That request is too large.", 413);
  try {
    const body = JSON.parse(text || "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    throw new FriendlyError("The request was not valid JSON.", 400);
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 25000): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // text that Excel would read as a formula is shown as text
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "2026-10-14 14:11" in UK time, which Excel reads as a date
export const ukTime = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export function excelDate(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? ukTime.format(t).slice(0, 16) : iso;
}
export function ukStamp(t = Date.now()): string {
  return ukTime.format(t); // 2026-10-15 14:32:05
}

export function csv(headings: string[], rows: unknown[][]): string {
  return "\ufeff" + [headings, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// an assessment's or template's name: none of \ / : * ? " < > | (it becomes the file's name, as in the Excel tool)
export function checkName(v: unknown, what = "assessment"): string {
  const name = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim() : "";
  if (name.length < 3) throw new FriendlyError(`Give the ${what} a name of at least 3 characters.`, 400, "name");
  if (name.length > 120) throw new FriendlyError("That name is too long.", 400, "name");
  if (/[\\/:*?"<>|]/.test(name)) throw new FriendlyError('A name can\'t contain any of \\ / : * ? " < > |', 400, "name");
  if (/\.$/.test(name)) throw new FriendlyError("A name can't end with a full stop.", 400, "name");
  return name;
}

export function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

export function fileHeaders(name: string, type: string): Record<string, string> {
  return {
    "content-type": type,
    "content-disposition": `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
}

export function textPage(title: string, message: string, status: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font:17px/1.6 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#17212c">
<h1 style="color:#264a6f;font-size:1.6rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/" style="color:#264a6f">Back to the Value Analyser</a></p></body>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
