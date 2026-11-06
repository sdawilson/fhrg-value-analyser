// Administration, for the FHRG team.
import { requireSiteAdmin } from "./accounts";
import { ASSESSMENT_COLS, publicAssessment } from "./assessments";
import type { Config } from "./config";
import type { Stmt } from "./db";
import { audit, exec, q } from "./db";
import { VA_TYPE, fileName, storageDelete, storageGet, storagePut } from "./storage";
import { TEMPLATE_COLS, ensureSeed, publicTemplate, registerTemplateFiles, templateFor } from "./templates";
import { FriendlyError, cleanText, json, now, readJsonBody } from "./util";

export async function handleOverview(c: Config, request: Request): Promise<Response> {
  await requireSiteAdmin(c, request);
  await ensureSeed(c);
  const r = (await q(c, `SELECT
      (SELECT COUNT(*) FROM va_assessments) AS assessments,
      (SELECT COUNT(DISTINCT authority_id) FROM va_assessments) AS authorities,
      (SELECT COUNT(*) FROM va_assessments WHERE shared = 1) AS shared,
      (SELECT COUNT(*) FROM va_templates WHERE scope_id = 0 AND visible = 1) AS fhrg_templates,
      (SELECT COUNT(*) FROM va_templates WHERE scope_id <> 0) AS authority_templates,
      (SELECT COUNT(*) FROM va_benchmarks WHERE visible = 1) AS benchmarks`))[0];
  const types = await q(c, "SELECT profile_type, COUNT(*) AS n, COUNT(DISTINCT authority_id) AS authorities, AVG(score) AS avg_score FROM va_assessments GROUP BY profile_type ORDER BY n DESC");
  const checks = [
    { label: "At least one FHRG template is available", ok: r.fhrg_templates > 0, fix: "Upload the starter .vt2 templates under Templates, or put them in the storage folder templates/fhrg/." },
    { label: "Site administrators are named in SITE_ADMINS", ok: c.siteAdmins.length > 0, fix: "Add your email to the SITE_ADMINS variable." },
    { label: `Version history is ${c.keepVersions ? `on (${c.keepVersions} earlier saves kept)` : "off"}`, ok: true, fix: "" },
    { label: `Live peer comparisons need at least ${c.minPeers} other authorities (MIN_PEERS)`, ok: true, fix: "" },
  ];
  return json({ counts: r, types, checks, fhrgSite: c.fhrgSite });
}

export async function handleAdminAssessments(c: Config, request: Request): Promise<Response> {
  await requireSiteAdmin(c, request);
  const rows = await q(c, `SELECT ${ASSESSMENT_COLS.split(", ").map((x) => "a." + x).join(", ")}, au.name AS authority_name FROM va_assessments a JOIN authorities au ON au.id = a.authority_id ORDER BY au.name, a.updated DESC LIMIT 2000`);
  return json({ assessments: rows.map((a) => publicAssessment(a)) });
}

export async function handleAdminAuthorities(c: Config, request: Request): Promise<Response> {
  await requireSiteAdmin(c, request);
  const rows = await q(c, "SELECT id, name, slug FROM authorities WHERE status = 'approved' ORDER BY name");
  return json({ authorities: rows });
}

export async function handleAdminTemplates(c: Config, request: Request): Promise<Response> {
  const me = await requireSiteAdmin(c, request);
  const added = await registerTemplateFiles(c, me.email);
  const rows = await q(c, `SELECT ${TEMPLATE_COLS}, au.name AS authority_name, (SELECT COUNT(*) FROM va_assessments a WHERE a.template_id = t.id) AS used
    FROM va_templates t LEFT JOIN authorities au ON au.id = t.scope_id ORDER BY t.scope_id <> 0, t.profile_type, t.is_default DESC, t.name`);
  return json({ templates: rows.map(publicTemplate), added });
}

export async function handleTemplateAction(c: Config, request: Request): Promise<Response> {
  const me = await requireSiteAdmin(c, request);
  const b = await readJsonBody(request);
  const t = await templateFor(c, me, Number(b.id) || 0);
  const stmts: Stmt[] = [];
  switch (b.action) {
    case "default":
      if (t.scope_id !== 0) throw new FriendlyError("Only FHRG templates can be a type's default.");
      stmts.push({ sql: "UPDATE va_templates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE scope_id = 0 AND COALESCE(profile_type, '') = COALESCE(?, '')", args: [t.id, t.profile_type] },
        { sql: "UPDATE va_templates SET visible = 1 WHERE id = ?", args: [t.id] });
      break;
    case "hide":
      if (t.is_default) throw new FriendlyError("Make another template the default for its type before hiding this one.");
      stmts.push({ sql: "UPDATE va_templates SET visible = 0 WHERE id = ?", args: [t.id] }); break;
    case "show": stmts.push({ sql: "UPDATE va_templates SET visible = 1 WHERE id = ?", args: [t.id] }); break;
    case "promote": {
      // an authority's template becomes an FHRG template (a copy, so the authority keeps its own)
      if (t.scope_id === 0) throw new FriendlyError("That's already an FHRG template.");
      const name = cleanText(b.name, 120) || t.name;
      const clash = (await q(c, "SELECT id FROM va_templates WHERE scope_id = 0 AND name_key = ?", name.toLowerCase()))[0];
      if (clash) throw new FriendlyError("The FHRG already has a template with that name. Give the copy another name.", 409, "name");
      const src = await storageGet(c, t.file_key);
      if (!src) throw new FriendlyError("The template's file is missing from storage.", 404);
      const key = `templates/fhrg/${fileName(name)}.vt2`;
      const bytes = new Uint8Array(await src.arrayBuffer());
      await storagePut(c, key, bytes, VA_TYPE);
      const at = now();
      stmts.push({ sql: `INSERT INTO va_templates (scope_id, levels, service, name, name_key, profile_type, description, file_key, factors, dimensions, structure, is_default, visible, version, bytes, created, created_by, updated, updated_by)
        VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, ?, ?, ?)`, args: [t.levels, t.service, name, name.toLowerCase(), t.profile_type, t.description, key, t.factors, t.dimensions, t.structure, bytes.length, at, me.email, at, me.email] });
      break;
    }
    case "delete":
      if (t.is_default) throw new FriendlyError("Make another template the default for its type before deleting this one.");
      await storageDelete(c, t.file_key);
      stmts.push({ sql: "DELETE FROM va_templates WHERE id = ?", args: [t.id] }, { sql: "UPDATE va_assessments SET template_id = NULL WHERE template_id = ?", args: [t.id] }); break;
    default: throw new FriendlyError("Unknown action.");
  }
  stmts.push(audit(me.email, `va-template-${b.action}`, { name: t.name }));
  await exec(c, stmts);
  return json({ ok: true });
}

export async function handleActivity(c: Config, request: Request): Promise<Response> {
  await requireSiteAdmin(c, request);
  const [log, byAuthority] = await exec(c, [
    { sql: "SELECT at, actor, action, detail FROM audit WHERE action LIKE 'va-%' ORDER BY id DESC LIMIT 200" },
    { sql: `SELECT au.name, COUNT(*) AS n, SUM(a.shared) AS shared, MAX(a.updated) AS last FROM va_assessments a JOIN authorities au ON au.id = a.authority_id GROUP BY a.authority_id ORDER BY n DESC` },
  ]);
  return json({ log: log.rows, byAuthority: byAuthority.rows });
}
