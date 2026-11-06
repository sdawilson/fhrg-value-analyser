// Downloads of a saved file, and the FHRG team's exports for Excel.
import { getMe } from "./accounts";
import { assessmentFor } from "./assessments";
import type { Config } from "./config";
import { q } from "./db";
import { VA_TYPE, fileName, storageGet } from "./storage";
import { templateFor } from "./templates";
import { FriendlyError, csv, excelDate, fileHeaders, now, safeParse, textPage } from "./util";

export async function handleDownload(c: Config, request: Request, kind: string, id: number): Promise<Response> {
  const me = await getMe(c, request);
  if (!me) return new Response(null, { status: 302, headers: { location: `/signin?next=${encodeURIComponent(`/download/${kind}/${id}`)}`, "cache-control": "no-store" } });
  try {
    let key = "", name = "";
    if (kind === "assessment") {
      const a = await assessmentFor(c, me, id);
      key = a.file_key; name = `${fileName(a.name)}.va2`;
    } else if (kind === "template") {
      const t = await templateFor(c, me, id);
      key = t.file_key; name = `${fileName(t.name)}.vt2`;
    } else if (kind === "version") {
      const v = (await q(c, "SELECT * FROM va_versions WHERE id = ?", id))[0];
      if (!v) throw new FriendlyError("That version wasn't found.", 404);
      const a = await assessmentFor(c, me, v.assessment_id);
      key = v.file_key; name = `${fileName(a.name)} (version ${v.version}).va2`;
    } else return new Response("Not found", { status: 404 });
    const res = await storageGet(c, key);
    if (!res) return textPage("File missing", "The file is missing from storage. Please let the FHRG team know.", 404);
    const headers = fileHeaders(name, VA_TYPE);
    const len = res.headers.get("content-length");
    if (len && !res.headers.get("content-encoding")) headers["content-length"] = len;
    return new Response(res.body, { headers });
  } catch (e) {
    if (e instanceof FriendlyError) return textPage("Not available", e.message, e.status);
    throw e;
  }
}

export async function handleExport(c: Config, request: Request, which: string): Promise<Response> {
  const me = await getMe(c, request);
  if (!me) return new Response(null, { status: 302, headers: { location: `/signin?next=${encodeURIComponent(`/export/${which}`)}` } });
  if (!me.siteAdmin) return textPage("Not allowed", "Only the FHRG team can export this.", 403);
  let body: string;
  if (which === "assessments.csv") {
    const rows = await q(c, `SELECT a.*, au.name AS authority_name FROM va_assessments a JOIN authorities au ON au.id = a.authority_id ORDER BY au.name, a.name`);
    body = csv(["Authority", "Assessment", "Type", "Reporting year", "Authority profile", "Template", "Overall score", "Confidence", "Opportunity", "Score of answered factors", "Complete %", "Factors answered", "Factors", "Shared for benchmarking", "Saved", "Saved by"],
      rows.map((a) => [a.authority_name, a.name, a.profile_type, a.reporting_year, a.authority_profile, a.template_name, a.score, a.confidence, a.opportunity, a.answered_score,
        a.completeness === null ? "" : Math.round(a.completeness * 1000) / 10, a.answered, a.factors, a.shared ? "Yes" : "No", excelDate(a.updated), a.updated_by]));
  } else if (which === "dimensions.csv") {
    const rows = await q(c, `SELECT a.name, a.profile_type, a.reporting_year, a.authority_profile, a.template_name, a.summary, a.updated, au.name AS authority_name FROM va_assessments a JOIN authorities au ON au.id = a.authority_id ORDER BY au.name, a.name`);
    const out: unknown[][] = [];
    for (const a of rows) for (const d of safeParse(a.summary)?.dims || []) out.push([a.authority_name, a.name, a.profile_type, a.reporting_year, a.authority_profile, a.template_name, d.name, d.score, d.conf, d.opp, d.share, d.answered, d.factors, excelDate(a.updated)]);
    body = csv(["Authority", "Assessment", "Type", "Reporting year", "Authority profile", "Template", "Dimension", "Score", "Confidence", "Opportunity", "Share of weighting", "Factors answered", "Factors", "Saved"], out);
  } else return new Response("Not found", { status: 404 });
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="value-analyser-${which.replace(".csv", "")}-${now().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}
