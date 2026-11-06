// Services: what a template or an assessment is for (Highways first). The FHRG keeps a standard list (scope 0),
// and an authority can add its own (scope = its id). A template or assessment that doesn't say is for Highways.
// Benchmarks only compare assessments of the same service.
import { requireMe, requireSiteAdmin } from "./accounts";
import type { Config } from "./config";
import { audit, exec, q } from "./db";
import { FriendlyError, json, now, readJsonBody } from "./util";

export const DEFAULT_SERVICE = "Highways";
const PATH_CHARS = /[\\/:*?"<>|]/;

// a service as read from a file or a request: plain text on one line, never empty
export function cleanService(v: unknown): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || DEFAULT_SERVICE;
}

// The FHRG's services and the authority's own (every authority's, for a site administrator who asks for all)
export async function handleServiceList(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const all = !!b.all && me.siteAdmin;
  const rows = await q(c, `SELECT s.id, s.scope_id, s.name, au.name AS authority_name,
      (SELECT COUNT(*) FROM va_templates t WHERE LOWER(COALESCE(t.service, ?)) = s.name_key) AS templates
    FROM va_services s LEFT JOIN authorities au ON au.id = s.scope_id
    WHERE ${all ? "1 = 1" : "s.scope_id = 0 OR s.scope_id = ?"} ORDER BY s.scope_id <> 0, s.name_key <> ?, s.name_key`,
  ...(all ? [DEFAULT_SERVICE, DEFAULT_SERVICE.toLowerCase()] : [DEFAULT_SERVICE, me.authorityId, DEFAULT_SERVICE.toLowerCase()]));
  return json({ services: rows.map((s) => ({ id: s.id, name: s.name, fhrg: s.scope_id === 0, authority_name: all ? s.authority_name : undefined, templates: all ? s.templates : undefined })) });
}

// Adding a service: to the FHRG's list (site administrators) or the authority's own. One that's already there is reused.
export async function handleServiceAdd(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const name = String(b.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) throw new FriendlyError("Give the service a name of 2 to 60 characters.", 400, "name");
  if (PATH_CHARS.test(name) || /[\u0000-\u001f\u007f]/.test(name)) throw new FriendlyError('A service\'s name can\'t contain any of \\ / : * ? " < > |', 400, "name");
  if (b.scope === "fhrg" && !me.siteAdmin) throw new FriendlyError("Only the FHRG team can add to the FHRG's services. Add it for your authority instead.", 403);
  const scope = b.scope === "fhrg" ? 0 : me.authorityId;
  const key = name.toLowerCase();
  const found = (await q(c, "SELECT id, scope_id, name FROM va_services WHERE name_key = ? AND (scope_id = 0 OR scope_id = ?) ORDER BY scope_id LIMIT 1", key, scope))[0];
  if (found) return json({ service: { id: found.id, name: found.name, fhrg: found.scope_id === 0 }, added: false });
  const r = await exec(c, [
    { sql: "INSERT INTO va_services (scope_id, name, name_key, created, created_by) VALUES (?, ?, ?, ?, ?)", args: [scope, name, key, now(), me.email] },
    audit(me.email, "va-add-service", { name, scope }),
  ]);
  return json({ service: { id: r[0].lastId || 0, name, fhrg: scope === 0 }, added: true });
}

// Taking a service off the list: site administrators only, and only while nothing uses it
export async function handleServiceDelete(c: Config, request: Request): Promise<Response> {
  const me = await requireSiteAdmin(c, request);
  const b = await readJsonBody(request);
  const s = (await q(c, "SELECT id, name, name_key FROM va_services WHERE id = ?", Number(b.id) || 0))[0];
  if (!s) throw new FriendlyError("That service wasn't found.", 404);
  if (s.name_key === DEFAULT_SERVICE.toLowerCase()) throw new FriendlyError(`${DEFAULT_SERVICE} is the service a template or assessment has when it doesn't say, so it stays.`);
  const used = (await q(c, `SELECT (SELECT COUNT(*) FROM va_templates WHERE LOWER(service) = ?) + (SELECT COUNT(*) FROM va_assessments WHERE LOWER(service) = ?) AS n`, s.name_key, s.name_key))[0].n;
  if (used) throw new FriendlyError(`${s.name} is used by ${used} template${used === 1 ? "" : "s"} or assessment${used === 1 ? "" : "s"}, so it stays.`);
  await exec(c, [{ sql: "DELETE FROM va_services WHERE id = ?", args: [s.id] }, audit(me.email, "va-delete-service", { name: s.name })]);
  return json({ deleted: true });
}
