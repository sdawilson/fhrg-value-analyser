// Each assessment is one .va2 file in storage (assessments/<authority>/<name>.va2), written by the page in
// the Excel tool's own format. The database holds a list of them, with the summary figures the page
// calculated, for the assessment list, benchmarking and comparisons.
import type { Me } from "./accounts";
import { requireMe } from "./accounts";
import type { Config } from "./config";
import type { Row, Stmt } from "./db";
import { audit, exec, q } from "./db";
import { VA_TYPE, fileName, storageDelete, storageGet, storagePut, storageText } from "./storage";
import { FriendlyError, checkName, cleanText, excelDate, json, now, num, readJsonBody, safeParse, ukStamp } from "./util";
import { cleanService } from "./services";
import { checkVaFile, encodeCp1252, headerValue, structureKey, vaRows } from "./vafile";

export const ASSESSMENT_COLS = "id, authority_id, name, profile_type, reporting_year, authority_profile, template_id, template_name, service, structure, score, confidence, opportunity, answered_score, completeness, answered, factors, shared, version, bytes, created, created_by, updated, updated_by";

export async function assessmentFor(c: Config, me: Me, id: number): Promise<Row> {
  const a = (await q(c, `SELECT a.*, au.name AS authority_name, au.slug AS authority_slug FROM va_assessments a JOIN authorities au ON au.id = a.authority_id WHERE a.id = ?`, id))[0];
  if (!a || (a.authority_id !== me.authorityId && !me.siteAdmin)) throw new FriendlyError("That assessment wasn't found. It may have been deleted.", 404);
  return a;
}

export function publicAssessment(a: Row, withSummary = false) {
  const { summary, name_key, file_key, ...rest } = a;
  return { ...rest, shared: !!a.shared, ...(withSummary ? { summary: safeParse(summary) } : {}) };
}

// the figures the page worked out (VA.summarise), kept for lists, benchmarks and comparisons
export function cleanSummary(v: any): any {
  if (!v || typeof v !== "object") return null;
  const r = (x: unknown) => { const n = num(x); return n === null ? null : Math.round(n * 1000) / 1000; };
  const factors: Record<string, (number | null)[]> = {};
  for (const [k, arr] of Object.entries(v.factors && typeof v.factors === "object" ? v.factors : {}).slice(0, 2000)) {
    if (!Array.isArray(arr)) continue;
    factors[String(k).slice(0, 220)] = arr.slice(0, 5).map(r);
  }
  const dimsOf = (list: unknown) => (Array.isArray(list) ? list : []).slice(0, 50).map((d: any) => ({
    name: cleanText(d?.name, 150), score: r(d?.score), conf: r(d?.conf), opp: r(d?.opp), share: r(d?.share), factors: r(d?.factors), answered: r(d?.answered),
  })).filter((d: any) => d.name);
  const totalsOf = (x: any) => { const t = x && typeof x === "object" ? x : {}; return { score: r(t.score), conf: r(t.conf), opp: r(t.opp) }; };
  const dims = dimsOf(v.dims);
  const t = v.totals && typeof v.totals === "object" ? v.totals : {};
  // an assessment whose weightings differ from its template's: its scores on the template's, which benchmarks use
  const tpl = v.template && typeof v.template === "object" ? { totals: totalsOf(v.template.totals), dims: dimsOf(v.template.dims) } : null;
  return {
    v: 1, type: cleanText(v.type, 100), year: cleanText(v.year, 20), authorityProfile: cleanText(v.authorityProfile, 100), weighting: v.weighting === "tree" ? "tree" : "simple",
    totals: { score: r(t.score), conf: r(t.conf), opp: r(t.opp) }, answeredScore: r(v.answeredScore), completeness: r(v.completeness),
    factorCount: r(v.factorCount), answered: r(v.answered), dims, factors, network: r(v.network), budget: r(v.budget), population: r(v.population),
    ...(tpl ? { template: tpl } : {}),
  };
}

export async function handleAssessmentList(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const aid = me.siteAdmin && Number(b.authorityId) ? Number(b.authorityId) : me.authorityId;
  const rows = await q(c, `SELECT ${ASSESSMENT_COLS}${b.withSummary ? ", summary" : ""} FROM va_assessments WHERE authority_id = ? ORDER BY updated DESC`, aid);
  return json({ assessments: rows.map((a) => publicAssessment(a, !!b.withSummary)), authority: me.authorityName });
}

export async function handleAssessmentOpen(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = await assessmentFor(c, me, Number(b.id) || 0);
  const text = await storageText(c, a.file_key);
  if (text === null) throw new FriendlyError("The assessment's file is missing from storage. Please let the FHRG team know.", 404);
  return json({ assessment: { ...publicAssessment(a), authority_name: a.authority_name }, va2: text });
}

export async function handleAssessmentSave(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request, c.maxUpload + 300_000);
  const name = checkName(b.name);
  const text = checkVaFile(b.va2, "assessment", c.maxUpload);
  const summary = cleanSummary(b.summary);
  const id = Number(b.id) || 0;
  const t = now();
  let existing: Row | null = null;
  let authorityId = me.authorityId, authoritySlug = me.authoritySlug;
  // the FHRG team can bring in an authority's files from the Excel tool on its behalf
  if (!id && me.siteAdmin && Number(b.authorityId) && Number(b.authorityId) !== me.authorityId) {
    const au = (await q(c, "SELECT id, slug FROM authorities WHERE id = ?", Number(b.authorityId)))[0];
    if (!au) throw new FriendlyError("That authority wasn't found.", 404);
    authorityId = au.id; authoritySlug = au.slug;
  }
  if (id) {
    existing = await assessmentFor(c, me, id);
    authorityId = existing.authority_id;
    authoritySlug = existing.authority_slug;
    if (!b.force && Number(b.baseVersion) !== existing.version) {
      throw new FriendlyError(`${existing.updated_by || "Someone"} saved a newer copy of this assessment at ${excelDate(existing.updated)}. Reload it to see their changes, or save yours as a new assessment.`, 409, undefined, { conflict: { updated: existing.updated, updated_by: existing.updated_by, version: existing.version } });
    }
  }
  const clash = (await q(c, "SELECT id FROM va_assessments WHERE authority_id = ? AND name_key = ? AND id <> ?", authorityId, name.toLowerCase(), id))[0];
  if (clash) throw new FriendlyError("Your authority already has an assessment with that name. Choose another, or open that one.", 409, "name", { clashId: clash.id });
  const key = `assessments/${authoritySlug}/${fileName(name)}.va2`;
  // version history (optional): keep the file being replaced
  let versionStmt: Stmt | null = null;
  if (existing && c.keepVersions > 0) {
    const old = await storageGet(c, existing.file_key);
    if (old) {
      const vkey = `versions/${authoritySlug}/${fileName(existing.name)}/${ukStamp().replace(/[-:]/g, "").replace(" ", "_")} v${existing.version}.va2`;
      const bytes = new Uint8Array(await old.arrayBuffer());
      await storagePut(c, vkey, bytes, VA_TYPE);
      versionStmt = { sql: "INSERT INTO va_versions (assessment_id, version, file_key, bytes, saved, saved_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)", args: [existing.id, existing.version, vkey, bytes.length, existing.updated, existing.updated_by, cleanText(b.reason, 100) || null] };
    }
  }
  const bytes = encodeCp1252(text);
  await storagePut(c, key, bytes, VA_TYPE);
  const rows = vaRows(text);
  let templateId: number | null = Number(b.templateId) || null;
  if (templateId) {
    const tpl = (await q(c, "SELECT id, scope_id, name FROM va_templates WHERE id = ?", templateId))[0];
    if (!tpl || (tpl.scope_id !== 0 && tpl.scope_id !== authorityId)) templateId = null;
  }
  const shared = b.shared === false || b.shared === 0 ? 0 : 1;
  const cols = [name, name.toLowerCase(), key, cleanText(String(b.profileType ?? summary?.type ?? ""), 100) || null, cleanText(String(b.reportingYear ?? summary?.year ?? ""), 20) || null,
    cleanText(String(b.authorityProfile ?? summary?.authorityProfile ?? ""), 100) || null, templateId, cleanText(b.templateName, 150) || null, cleanService(headerValue(text, "Template Service")), structureKey(rows),
    summary?.totals?.score ?? null, summary?.totals?.conf ?? null, summary?.totals?.opp ?? null, summary?.answeredScore ?? null, summary?.completeness ?? null,
    summary?.answered ?? null, summary?.factorCount ?? null, shared, summary ? JSON.stringify(summary) : null, bytes.length];
  let newId = id, version = 1;
  if (existing) {
    version = existing.version + 1;
    await exec(c, [
      ...(versionStmt ? [versionStmt] : []),
      { sql: `UPDATE va_assessments SET name = ?, name_key = ?, file_key = ?, profile_type = ?, reporting_year = ?, authority_profile = ?, template_id = COALESCE(?, template_id),
          template_name = COALESCE(?, template_name), service = ?, structure = ?, score = ?, confidence = ?, opportunity = ?, answered_score = ?, completeness = ?, answered = ?, factors = ?, shared = ?,
          summary = ?, bytes = ?, version = ?, updated = ?, updated_by = ? WHERE id = ?`, args: [...cols, version, t, me.email, id] },
      audit(me.email, "va-save-assessment", { id, name, authority: existing.authority_name }),
    ]);
    if (existing.file_key !== key) await storageDelete(c, existing.file_key);
    if (versionStmt) await pruneVersions(c, id);
  } else {
    const r = await exec(c, [
      { sql: `INSERT INTO va_assessments (name, name_key, file_key, profile_type, reporting_year, authority_profile, template_id, template_name, service, structure, score, confidence, opportunity,
          answered_score, completeness, answered, factors, shared, summary, bytes, authority_id, version, created, created_by, updated, updated_by) VALUES (${new Array(26).fill("?").join(", ")})`,
        args: [...cols, authorityId, 1, t, me.email, t, me.email] },
      audit(me.email, b.imported ? "va-import-assessment" : "va-new-assessment", { name, authority: authorityId === me.authorityId ? me.authorityName : authoritySlug }),
    ]);
    newId = r[0].lastId || 0;
  }
  return json({ saved: true, id: newId, version, updated: t, updated_by: me.email });
}

export async function pruneVersions(c: Config, assessmentId: number): Promise<void> {
  const old = await q(c, "SELECT id, file_key FROM va_versions WHERE assessment_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?", assessmentId, c.keepVersions);
  for (const v of old) await storageDelete(c, v.file_key);
  if (old.length) await exec(c, [{ sql: `DELETE FROM va_versions WHERE id IN (${old.map(() => "?").join(", ")})`, args: old.map((v) => v.id) }]);
}

export async function handleAssessmentShare(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = await assessmentFor(c, me, Number(b.id) || 0);
  const shared = b.shared ? 1 : 0;
  await exec(c, [{ sql: "UPDATE va_assessments SET shared = ? WHERE id = ?", args: [shared, a.id] }, audit(me.email, "va-share-assessment", { name: a.name, shared: !!shared })]);
  return json({ ok: true, shared: !!shared });
}

export async function handleAssessmentDelete(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = await assessmentFor(c, me, Number(b.id) || 0);
  if (!me.siteAdmin && me.role !== "lead" && a.created_by !== me.email) throw new FriendlyError("Only the person who created this assessment, or your authority's lead, can delete it.", 403);
  await storageDelete(c, a.file_key);
  const versions = await q(c, "SELECT file_key FROM va_versions WHERE assessment_id = ?", a.id);
  for (const v of versions) await storageDelete(c, v.file_key);
  await exec(c, [
    { sql: "DELETE FROM va_assessments WHERE id = ?", args: [a.id] },
    { sql: "DELETE FROM va_versions WHERE assessment_id = ?", args: [a.id] },
    audit(me.email, "va-delete-assessment", { id: a.id, name: a.name, authority: a.authority_name }),
  ]);
  return json({ deleted: true });
}

export async function handleVersions(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = await assessmentFor(c, me, Number(b.id) || 0);
  const rows = await q(c, "SELECT id, version, bytes, saved, saved_by, reason FROM va_versions WHERE assessment_id = ? ORDER BY id DESC", a.id);
  return json({ versions: rows, keep: c.keepVersions });
}

export async function handleRestore(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = await assessmentFor(c, me, Number(b.id) || 0);
  const v = (await q(c, "SELECT * FROM va_versions WHERE id = ? AND assessment_id = ?", Number(b.versionId) || 0, a.id))[0];
  if (!v) throw new FriendlyError("That earlier version wasn't found.", 404);
  const text = await storageText(c, v.file_key);
  if (text === null) throw new FriendlyError("That version's file is missing from storage.", 404);
  // the page reopens it and saves it as the current version (which keeps today's version in the history)
  return json({ va2: text, version: v });
}
