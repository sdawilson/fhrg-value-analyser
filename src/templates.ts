// A template is a .vt2 file: an assessment with no answers, in the Excel tool's format. The FHRG's
// templates (scope 0) are shared with every member and kept by the site administrators; an authority's
// own templates are kept by its members.
import type { Me } from "./accounts";
import { requireMe } from "./accounts";
import type { Config } from "./config";
import type { Row, Stmt } from "./db";
import { audit, exec, q } from "./db";
import { VA_TYPE, fileName, storageDelete, storageList, storagePut, storageText } from "./storage";
import { FriendlyError, checkName, cleanText, excelDate, json, now, readJsonBody } from "./util";
import { cleanService, listedService } from "./services";
import { checkVaFile, encodeCp1252, headerValue, structureKey, vaRows } from "./vafile";

export const TEMPLATE_COLS = "t.id, t.scope_id, t.name, t.profile_type, t.description, t.factors, t.dimensions, t.structure, t.is_default, t.visible, t.levels, t.service, t.version, t.bytes, t.created, t.created_by, t.updated, t.updated_by";

// Where in an organisation's structure a template can be used. A template that doesn't say is a service-level one.
export const LEVELS = ["organisation", "service", "function", "process"];
export function cleanLevels(v: unknown): string {
  const words = (Array.isArray(v) ? v : String(v ?? "").split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase());
  return LEVELS.filter((l) => words.includes(l)).join(",") || "service";
}

export function publicTemplate(t: Row) {
  return { ...t, fhrg: t.scope_id === 0, is_default: !!t.is_default, visible: !!t.visible, levels: cleanLevels(t.levels), service: cleanService(t.service) };
}

export async function templateFor(c: Config, me: Me, id: number, forEdit = false): Promise<Row> {
  const t = (await q(c, `SELECT t.*, au.name AS authority_name, au.slug AS authority_slug FROM va_templates t LEFT JOIN authorities au ON au.id = t.scope_id WHERE t.id = ?`, id))[0];
  if (!t) throw new FriendlyError("That template isn't available. It may have been deleted.", 404);
  if (me.siteAdmin) return t;
  if (t.scope_id !== 0 && t.scope_id !== me.authorityId) throw new FriendlyError("That template isn't available.", 404);
  if (t.scope_id === 0 && !t.visible) throw new FriendlyError("That template isn't available.", 404);
  if (forEdit && t.scope_id === 0) throw new FriendlyError("Only the FHRG team can change the FHRG's templates. Save a copy for your authority instead.", 403);
  if (forEdit && t.created_by !== me.email && me.role !== "lead") throw new FriendlyError("Only the person who created this template, or your authority's lead, can change it.", 403);
  return t;
}

// .vt2 files placed in templates/fhrg/ by hand are added to the list ("(Default)" at the end of a name marks the default for its type)
export async function registerTemplateFiles(c: Config, actor: string): Promise<number> {
  const files = (await storageList(c, "templates/fhrg")).filter((f) => /\.(vt2|va2)$/i.test(f.name));
  const known = new Set((await q(c, "SELECT file_key FROM va_templates")).map((r) => r.file_key));
  const stmts: Stmt[] = [];
  const t = now();
  for (const f of files) {
    const key = `templates/fhrg/${f.name}`;
    if (known.has(key)) continue;
    const text = await storageText(c, key).catch(() => null);
    if (!text) continue;
    const rows = vaRows(text);
    const name = f.name.replace(/\.(vt2|va2)$/i, "").replace(/\s*\(\s*default\s*\)\s*$/i, "");
    const isDefault = /\(\s*default\s*\)\s*\.(vt2|va2)$/i.test(f.name) ? 1 : 0;
    stmts.push({ sql: `INSERT OR IGNORE INTO va_templates (scope_id, levels, service, name, name_key, profile_type, description, file_key, factors, dimensions, structure, is_default, visible, version, bytes, created, created_by, updated, updated_by)
      VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
      args: [cleanLevels(headerValue(text, "Template Levels")), cleanService(headerValue(text, "Template Service")), name, name.toLowerCase(), headerValue(text, "Profile Type") || null, headerValue(text, "Template Description").replace(/<lf>/g, " ") || null, key, rows.length, new Set(rows.map((r) => r.dimension)).size, structureKey(rows), isDefault, f.size, t, actor, t, actor] });
  }
  if (stmts.length) await exec(c, [...stmts, audit(actor, "va-register-templates", { count: stmts.length })]);
  return stmts.length;
}

let seeding: Promise<void> | null = null;
export function ensureSeed(c: Config): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      const n = (await q(c, "SELECT COUNT(*) AS n FROM va_templates WHERE scope_id = 0"))[0].n;
      if (!n) await registerTemplateFiles(c, "toolkit");
    })().catch((e) => {
      seeding = null;
      throw e;
    });
  }
  return seeding;
}

export async function handleTemplateList(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  await ensureSeed(c);
  const rows = await q(c, `SELECT ${TEMPLATE_COLS}, au.name AS authority_name,
      (SELECT COUNT(*) FROM va_assessments a WHERE a.template_id = t.id AND a.authority_id = ?) AS used
    FROM va_templates t LEFT JOIN authorities au ON au.id = t.scope_id
    WHERE (t.scope_id = 0 AND t.visible = 1) OR t.scope_id = ? ORDER BY t.scope_id = 0 DESC, t.profile_type, t.is_default DESC, t.name`, me.authorityId, me.authorityId);
  // only those that can be used at this level, or for this service, when asked
  const level = LEVELS.includes(b.level) ? b.level : "";
  const service = b.service ? cleanService(b.service).toLowerCase() : "";
  return json({ templates: rows.map(publicTemplate).filter((t) => (!level || t.levels.split(",").includes(level)) && (!service || t.service.toLowerCase() === service)) });
}

export async function handleTemplateGet(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const t = await templateFor(c, me, Number(b.id) || 0);
  const text = await storageText(c, t.file_key);
  if (!text) throw new FriendlyError("The template's file is missing from storage. Please let the FHRG team know.", 404);
  return json({ template: publicTemplate({ ...t, authority_name: t.authority_name }), vt2: text });
}

export async function handleTemplateSave(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request, c.maxUpload + 200_000);
  const name = checkName(b.name, "template");
  const text = checkVaFile(b.vt2, "template", c.maxUpload);
  const rows = vaRows(text);
  if (!rows.length) throw new FriendlyError("A template needs at least one factor.");
  const id = Number(b.id) || 0;
  let existing: Row | null = null;
  let scope = b.scope === "fhrg" ? 0 : me.authorityId;
  if (id) {
    existing = await templateFor(c, me, id, true);
    scope = existing.scope_id;
    if (!b.force && Number(b.baseVersion) !== existing.version) {
      throw new FriendlyError(`${existing.updated_by || "Someone"} saved a newer copy of this template at ${excelDate(existing.updated)}. Reload it to see their changes, or save yours as a new template.`, 409, undefined, { conflict: { updated: existing.updated, updated_by: existing.updated_by, version: existing.version } });
    }
  }
  if (scope === 0 && !me.siteAdmin) throw new FriendlyError("Only the FHRG team can save FHRG templates. Save it for your authority instead.", 403);
  const clash = (await q(c, "SELECT id FROM va_templates WHERE scope_id = ? AND name_key = ? AND id <> ?", scope, name.toLowerCase(), id))[0];
  if (clash) throw new FriendlyError(scope === 0 ? "The FHRG already has a template with that name." : "Your authority already has a template with that name.", 409, "name");
  const folder = scope === 0 ? "fhrg" : me.siteAdmin && existing ? (existing.authority_slug || "authority-" + scope) : me.authoritySlug;
  const key = `templates/${folder}/${fileName(name)}.vt2`;
  const bytes = encodeCp1252(text);
  await storagePut(c, key, bytes, VA_TYPE);
  const t = now();
  const profileType = cleanText(b.profileType, 100) || headerValue(text, "Profile Type") || null;
  const levels = cleanLevels(b.levels ?? headerValue(text, "Template Levels"));
  const service = await listedService(c, b.service ?? headerValue(text, "Template Service"));
  const fields = [name, name.toLowerCase(), profileType, cleanText(b.description, 1000) || null, key, rows.length, new Set(rows.map((r) => r.dimension)).size, structureKey(rows), bytes.length, levels, service];
  let newId = id, version = 1;
  if (existing) {
    version = existing.version + 1;
    await exec(c, [
      { sql: `UPDATE va_templates SET name = ?, name_key = ?, profile_type = ?, description = ?, file_key = ?, factors = ?, dimensions = ?, structure = ?, bytes = ?, levels = ?, service = ?, version = ?, updated = ?, updated_by = ? WHERE id = ?`, args: [...fields, version, t, me.email, id] },
      audit(me.email, "va-save-template", { id, name, scope }),
    ]);
    if (existing.file_key !== key) await storageDelete(c, existing.file_key);
  } else {
    const r = await exec(c, [
      { sql: `INSERT INTO va_templates (name, name_key, profile_type, description, file_key, factors, dimensions, structure, bytes, levels, service, scope_id, is_default, visible, version, created, created_by, updated, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, ?, ?)`, args: [...fields, scope, t, me.email, t, me.email] },
      audit(me.email, "va-new-template", { name, scope }),
    ]);
    newId = r[0].lastId || 0;
  }
  return json({ saved: true, id: newId, version, updated: t, updated_by: me.email, scope_id: scope });
}

// Hiding a template, as when it has moved to another service or level: it's no longer offered for new
// assessments, and assessments already made from it keep it. Those who can change it can hide it or show it again.
export async function handleTemplateHide(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const t = await templateFor(c, me, Number(b.id) || 0, true);
  const hide = b.hidden !== false;
  if (hide && t.scope_id === 0 && t.is_default) throw new FriendlyError("This is the default template for its type, so it stays. Make another template the default first.");
  await exec(c, [
    { sql: "UPDATE va_templates SET visible = ? WHERE id = ?", args: [hide ? 0 : 1, t.id] },
    audit(me.email, hide ? "va-hide-template" : "va-show-template", { name: t.name, scope: t.scope_id }),
  ]);
  return json({ ok: true, visible: !hide });
}

export async function handleTemplateDelete(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const t = await templateFor(c, me, Number(b.id) || 0, true);
  if (t.scope_id === 0 && t.is_default) throw new FriendlyError("Make another template the default for its type before deleting this one.");
  await storageDelete(c, t.file_key);
  await exec(c, [
    { sql: "DELETE FROM va_templates WHERE id = ?", args: [t.id] },
    { sql: "UPDATE va_assessments SET template_id = NULL WHERE template_id = ?", args: [t.id] },
    audit(me.email, "va-delete-template", { name: t.name, scope: t.scope_id }),
  ]);
  return json({ deleted: true });
}
