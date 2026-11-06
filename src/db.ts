// The FHRG website's database, which also holds the toolkit's own va_* tables.
import type { Config } from "./config";
import { fetchWithTimeout, now } from "./util";

// Bunny Database speaks the libSQL remote protocol (Hrana over HTTP): POST <url>/v2/pipeline.

export class DbError extends Error {}

export type Val = string | number | boolean | null | undefined;
export type Stmt = { sql: string; args?: Val[] };
export type Row = Record<string, any>;
export type DbResult = { rows: Row[]; changes: number; lastId: number | null };

export function hranaArg(v: Val) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  return { type: "text", value: String(v) };
}

export function hranaValue(v: any): any {
  switch (v?.type) {
    case "integer": return Number(v.value);
    case "float": return Number(v.value);
    case "text": return v.value;
    case "blob": return v.base64;
    default: return null;
  }
}

export async function db(c: Config, stmts: Stmt[]): Promise<DbResult[]> {
  const requests = [...stmts.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args || []).map(hranaArg) } })), { type: "close" }];
  let res: Response;
  try {
    res = await fetchWithTimeout(c.dbUrl, { method: "POST", headers: { Authorization: `Bearer ${c.dbToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ requests }) }, 20000);
  } catch (e) {
    throw new DbError(`The database could not be reached: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new DbError("The database rejected the access token. Check BUNNY_DATABASE_AUTH_TOKEN.");
  if (!res.ok) throw new DbError(`The database returned status ${res.status}. Check BUNNY_DATABASE_URL.`);
  const body: any = await res.json();
  return stmts.map((_, i) => {
    const r = body?.results?.[i];
    if (!r || r.type !== "ok") throw new DbError(r?.error?.message || "The database did not answer.");
    const result = r.response?.result || { cols: [], rows: [] };
    const cols: string[] = (result.cols || []).map((col: any) => col.name);
    return {
      rows: (result.rows || []).map((row: any[]) => Object.fromEntries(row.map((v, j) => [cols[j], hranaValue(v)]))),
      changes: Number(result.affected_row_count || 0),
      lastId: result.last_insert_rowid === null || result.last_insert_rowid === undefined ? null : Number(result.last_insert_rowid),
    };
  });
}

export async function q(c: Config, sql: string, ...args: Val[]): Promise<Row[]> {
  await ensureSchema(c);
  return (await db(c, [{ sql, args }]))[0].rows;
}

export async function exec(c: Config, stmts: Stmt[]): Promise<DbResult[]> {
  await ensureSchema(c);
  return await db(c, stmts);
}

export const SCHEMA = [
  // the FHRG website's tables, exactly as it creates them, so the toolkit also works on a fresh database
  `CREATE TABLE IF NOT EXISTS authorities (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'authority', status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL, approved TEXT, code_used INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, authority_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL,
     name TEXT NOT NULL, title TEXT, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending',
     site_admin INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL, reset_hash TEXT, reset_expires TEXT,
     registered TEXT NOT NULL, approved TEXT, last_login TEXT, reset_sent TEXT)`,
  `CREATE INDEX IF NOT EXISTS users_authority ON users (authority_id)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit (at)`,
  // the toolkit's own tables
  // scope_id: 0 for the FHRG's templates (shared with every member), otherwise the authority that owns it
  `CREATE TABLE IF NOT EXISTS va_templates (id INTEGER PRIMARY KEY, scope_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, name_key TEXT NOT NULL,
     profile_type TEXT, description TEXT, file_key TEXT NOT NULL, factors INTEGER, dimensions INTEGER, structure TEXT,
     is_default INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, bytes INTEGER,
     created TEXT NOT NULL, created_by TEXT, updated TEXT NOT NULL, updated_by TEXT, levels TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS va_templates_name ON va_templates (scope_id, name_key)`,
  `CREATE TABLE IF NOT EXISTS va_assessments (id INTEGER PRIMARY KEY, authority_id INTEGER NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
     file_key TEXT NOT NULL, profile_type TEXT, reporting_year TEXT, authority_profile TEXT, template_id INTEGER, template_name TEXT, structure TEXT,
     score REAL, confidence REAL, opportunity REAL, answered_score REAL, completeness REAL, answered INTEGER, factors INTEGER,
     shared INTEGER NOT NULL DEFAULT 1, summary TEXT, version INTEGER NOT NULL DEFAULT 1, bytes INTEGER,
     created TEXT NOT NULL, created_by TEXT, updated TEXT NOT NULL, updated_by TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS va_assessments_name ON va_assessments (authority_id, name_key)`,
  `CREATE INDEX IF NOT EXISTS va_assessments_type ON va_assessments (profile_type)`,
  `CREATE TABLE IF NOT EXISTS va_versions (id INTEGER PRIMARY KEY, assessment_id INTEGER NOT NULL, version INTEGER NOT NULL,
     file_key TEXT NOT NULL, bytes INTEGER, saved TEXT NOT NULL, saved_by TEXT, reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS va_versions_assessment ON va_versions (assessment_id)`,
  `CREATE TABLE IF NOT EXISTS va_benchmarks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, profile_type TEXT, reporting_year TEXT,
     authority_profile TEXT, template_name TEXT, structure TEXT, statistic TEXT, members INTEGER, source TEXT NOT NULL DEFAULT 'composite',
     summary TEXT NOT NULL, member_list TEXT, visible INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, created_by TEXT, updated TEXT)`,
];

export const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN reset_sent TEXT",
  "ALTER TABLE va_templates ADD COLUMN levels TEXT",
];

let schemaReady: Promise<void> | null = null;
export function ensureSchema(c: Config): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db(c, SCHEMA.map((sql) => ({ sql })));
      for (const sql of MIGRATIONS) {
        try {
          await db(c, [{ sql }]);
        } catch (e) {
          if (!/duplicate column/i.test((e as Error).message)) console.log(`[WARN] Migration skipped: ${(e as Error).message}`);
        }
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export function audit(actor: string, action: string, detail: unknown = ""): Stmt {
  return { sql: "INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", args: [now(), actor, action, typeof detail === "string" ? detail : JSON.stringify(detail)] };
}
