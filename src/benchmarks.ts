// Benchmarks are averages, never another authority's own answers. They come from:
//  - composites the FHRG team builds from members' shared assessments (and any uploaded .va2 benchmark files)
//  - a live peer comparison: other authorities' latest shared assessment of the same type, shown only
//    when at least MIN_PEERS authorities are in it
import { requireMe, requireSiteAdmin } from "./accounts";
import { assessmentFor, cleanSummary } from "./assessments";
import type { Config } from "./config";
import type { Row, Val } from "./db";
import { audit, exec, q } from "./db";
import { FriendlyError, cleanText, json, now, readJsonBody, safeParse } from "./util";

// A figure stands only on enough authorities, factor by factor: an average of one is that authority's own answer.
// The middle half needs more still, because with three authorities it and the mean would give away all three.
export const MIN_FOR_RANGE = 5;
export function aggregate(summaries: any[], statistic: string, minimum: number): any {
  const isN = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const pick = (vals: unknown[]) => {
    const v = vals.filter(isN);
    if (!v.length) return null;
    if (statistic === "median") { const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  const qt = (vals: unknown[], p: number) => {
    const v = vals.filter(isN).sort((a, b) => a - b);
    if (!v.length) return null;
    const pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  const enough = (vals: unknown[]) => vals.filter(isN).length >= minimum;
  const middle = (vals: unknown[]) => (vals.filter(isN).length >= MIN_FOR_RANGE ? { q1: r3(qt(vals, 0.25)), q3: r3(qt(vals, 0.75)) } : {});
  const keys = [...new Set(summaries.flatMap((s) => Object.keys(s.factors || {})))];
  const factors: Record<string, any> = {};
  for (const k of keys) {
    const rows = summaries.map((s) => s.factors?.[k]).filter(Boolean);
    const sc = rows.map((x: any) => x[0]);
    if (!enough(sc)) continue;
    factors[k] = { score: r3(pick(sc)), conf: r3(pick(rows.map((x: any) => x[1]))), opp: r3(pick(rows.map((x: any) => x[2]))), n: sc.filter(isN).length, ...middle(sc) };
  }
  const dimNames = [...new Set(summaries.flatMap((s) => (s.dims || []).map((d: any) => d.name)))];
  const dims = dimNames.flatMap((name) => {
    const ds = summaries.map((s) => (s.dims || []).find((d: any) => d.name === name)).filter(Boolean);
    const sc = ds.map((d: any) => d.score);
    return enough(sc) ? [{ name, score: r3(pick(sc)), conf: r3(pick(ds.map((d: any) => d.conf))), opp: r3(pick(ds.map((d: any) => d.opp))), n: sc.filter(isN).length, ...middle(sc) }] : [];
  });
  const all = summaries.map((s) => s.totals?.score);
  return {
    statistic, n: summaries.length,
    totals: { score: enough(all) ? r3(pick(all)) : null, conf: r3(pick(summaries.map((s) => s.totals?.conf))), opp: r3(pick(summaries.map((s) => s.totals?.opp))), ...middle(all) },
    dims, factors,
  };
}

// Composites built before the rule above are held to it as they're read
function heldToMinimum(s: any, minimum: number): any {
  if (!s) return s;
  const keep = (x: any) => { const { min, max, q1, q3, ...rest } = x; return x.n >= MIN_FOR_RANGE ? { ...rest, q1, q3 } : rest; };
  const { min, max, q1, q3, ...totals } = s.totals || {};
  return {
    ...s,
    totals: s.n >= MIN_FOR_RANGE ? { ...totals, q1, q3 } : totals,
    dims: (s.dims || []).filter((d: any) => d.n >= minimum).map(keep),
    factors: Object.fromEntries(Object.entries(s.factors || {}).filter(([, f]: any) => f.n >= minimum).map(([k, f]) => [k, keep(f)])),
  };
}

export function publicBenchmark(r: Row, withSummary = false, admin = false, minimum = 0) {
  const { summary, member_list, ...rest } = r;
  const parsed = withSummary ? safeParse(summary) : null;
  return { ...rest, visible: !!r.visible, ...(withSummary ? { summary: r.source === "composite" && minimum ? heldToMinimum(parsed, minimum) : parsed } : {}), ...(admin ? { member_list: safeParse(member_list) } : {}) };
}

export async function handleBenchmarkList(c: Config, request: Request): Promise<Response> {
  await requireMe(c, request);
  const rows = await q(c, "SELECT id, name, description, profile_type, reporting_year, authority_profile, template_name, structure, statistic, members, source, updated FROM va_benchmarks WHERE visible = 1 ORDER BY profile_type, reporting_year DESC, name");
  return json({ benchmarks: rows });
}

export async function handleBenchmarkGet(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const r = (await q(c, "SELECT * FROM va_benchmarks WHERE id = ?", Number(b.id) || 0))[0];
  if (!r || (!r.visible && !me.siteAdmin)) throw new FriendlyError("That benchmark isn't available.", 404);
  return json({ benchmark: publicBenchmark(r, true, me.siteAdmin, c.minPeers) });
}

// the latest shared assessment from each authority that matches
export async function peerSummaries(c: Config, f: { profileType: string; structure?: string; year?: string; authorityProfile?: string; excludeAuthority?: number; excludeId?: number }): Promise<Row[]> {
  const where = ["a.shared = 1", "a.summary IS NOT NULL", "a.profile_type = ?"];
  const args: Val[] = [f.profileType];
  if (f.structure) { where.push("a.structure = ?"); args.push(f.structure); }
  if (f.year) { where.push("a.reporting_year = ?"); args.push(f.year); }
  if (f.authorityProfile) { where.push("a.authority_profile = ?"); args.push(f.authorityProfile); }
  if (f.excludeAuthority) { where.push("a.authority_id <> ?"); args.push(f.excludeAuthority); }
  if (f.excludeId) { where.push("a.id <> ?"); args.push(f.excludeId); }
  const rows = await q(c, `SELECT a.id, a.authority_id, a.name, a.updated, a.reporting_year, a.summary, au.name AS authority_name
    FROM va_assessments a JOIN authorities au ON au.id = a.authority_id WHERE ${where.join(" AND ")} ORDER BY a.updated DESC LIMIT 2000`, ...args);
  const latest = new Map<number, Row>();
  for (const r of rows) if (!latest.has(r.authority_id)) latest.set(r.authority_id, r);
  return [...latest.values()].map((r) => ({ ...r, summary: safeParse(r.summary) })).filter((r) => r.summary && r.summary.totals);
}

export async function handlePeers(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = await assessmentFor(c, me, Number(b.assessmentId) || 0);
  if (!a.profile_type) throw new FriendlyError("Choose the assessment's type on the Profile tab, and save it, to compare it with other authorities.");
  const filters = {
    profileType: a.profile_type,
    structure: b.sameTemplate === false ? "" : a.structure || "",
    year: b.sameYear ? a.reporting_year || "" : "",
    authorityProfile: b.sameProfile ? a.authority_profile || "" : "",
    excludeAuthority: a.authority_id,
  };
  const peers = await peerSummaries(c, filters);
  const statistic = b.statistic === "median" ? "median" : "mean";
  if (peers.length < c.minPeers) {
    return json({ ok: false, count: peers.length, minPeers: c.minPeers, filters: { ...filters, excludeAuthority: undefined },
      message: `${peers.length ? `Only ${peers.length} other authorit${peers.length === 1 ? "y has" : "ies have"}` : "No other authority has"} shared a matching assessment. At least ${c.minPeers} are needed before averages are shown, so no authority's own answers can be worked out.` });
  }
  return json({ ok: true, count: peers.length, minPeers: c.minPeers, filters: { ...filters, excludeAuthority: undefined }, benchmark: aggregate(peers.map((p) => p.summary), statistic, c.minPeers) });
}

export async function handleAdminBenchmarks(c: Config, request: Request): Promise<Response> {
  await requireSiteAdmin(c, request);
  const rows = await q(c, "SELECT * FROM va_benchmarks ORDER BY profile_type, reporting_year DESC, name");
  const options = await q(c, `SELECT profile_type, reporting_year, authority_profile, template_name, structure, COUNT(DISTINCT authority_id) AS authorities
    FROM va_assessments WHERE shared = 1 AND summary IS NOT NULL GROUP BY profile_type, reporting_year, authority_profile, structure ORDER BY profile_type, reporting_year DESC`);
  return json({ benchmarks: rows.map((r) => publicBenchmark(r, true, true)), options });
}

// A composite of the latest shared assessment from each authority: the mean (or median) of every factor
// and dimension. The members are recorded so the composite can be audited.
export async function handleBenchmarkBuild(c: Config, request: Request): Promise<Response> {
  const me = await requireSiteAdmin(c, request);
  const b = await readJsonBody(request);
  const profileType = cleanText(b.profile_type, 100);
  if (!profileType) throw new FriendlyError("Choose an assessment type.", 400, "profile_type");
  const year = cleanText(b.reporting_year, 20);
  const authorityProfile = cleanText(b.authority_profile, 100);
  const structure = cleanText(b.structure, 40);
  const statistic = b.statistic === "median" ? "median" : "mean";
  const peers = await peerSummaries(c, { profileType, year, authorityProfile, structure });
  const min = Math.max(c.minPeers, Number(b.min_members) || 0);
  if (peers.length < min) throw new FriendlyError(`Only ${peers.length} authorit${peers.length === 1 ? "y has" : "ies have"} shared a matching assessment. At least ${min} are needed.`);
  const summary = aggregate(peers.map((p) => p.summary), statistic, c.minPeers);
  const templateName = cleanText(b.template_name, 150) || null;
  const name = cleanText(b.name, 150) || `${profileType}${year ? ` ${year}` : ""}${authorityProfile ? ` (${authorityProfile})` : ""} benchmark`;
  const t = now();
  const r = await exec(c, [
    { sql: `INSERT INTO va_benchmarks (name, description, profile_type, reporting_year, authority_profile, template_name, structure, statistic, members, source, summary, member_list, visible, created, created_by, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'composite', ?, ?, ?, ?, ?, ?)`,
      args: [name, cleanText(b.description, 300) || `${statistic === "median" ? "Median" : "Mean"} of ${peers.length} ${peers.length === 1 ? "authority" : "authorities"}`, profileType, year || null, authorityProfile || null,
        templateName, structure || null, statistic, peers.length, JSON.stringify(summary), JSON.stringify(peers.map((p) => ({ authority: p.authority_name, name: p.name, year: p.reporting_year, saved: p.updated }))),
        b.visible === false ? 0 : 1, t, me.email, t] },
    audit(me.email, "va-build-benchmark", { name, members: peers.length, statistic }),
  ]);
  return json({ saved: true, id: r[0].lastId, members: peers.length });
}

// an uploaded benchmark (a .va2 read by the page, e.g. a composite made in the Excel tool), or changes to a benchmark's details
export async function handleBenchmarkSave(c: Config, request: Request): Promise<Response> {
  const me = await requireSiteAdmin(c, request);
  const b = await readJsonBody(request, 1_500_000);
  const id = Number(b.id) || 0;
  const name = cleanText(b.name, 150);
  if (!name) throw new FriendlyError("Give the benchmark a name.", 400, "name");
  const fields = [name, cleanText(b.description, 300) || null, cleanText(b.profile_type, 100) || null, cleanText(b.reporting_year, 20) || null, cleanText(b.authority_profile, 100) || null, b.visible === false || b.visible === 0 ? 0 : 1];
  const t = now();
  if (id) {
    const r = (await q(c, "SELECT id FROM va_benchmarks WHERE id = ?", id))[0];
    if (!r) throw new FriendlyError("That benchmark wasn't found.", 404);
    await exec(c, [{ sql: "UPDATE va_benchmarks SET name = ?, description = ?, profile_type = ?, reporting_year = ?, authority_profile = ?, visible = ?, updated = ? WHERE id = ?", args: [...fields, t, id] }, audit(me.email, "va-save-benchmark", { id, name })]);
    return json({ saved: true, id });
  }
  const summaries = (Array.isArray(b.summaries) ? b.summaries : [b.summary]).map(cleanSummary).filter((s: any) => s && Object.keys(s.factors || {}).length);
  if (!summaries.length) throw new FriendlyError("That file has no answered factors to use as a benchmark.");
  const statistic = b.statistic === "median" ? "median" : "mean";
  const summary = aggregate(summaries, statistic, 1); // the FHRG team chooses what it uploads
  const r = await exec(c, [
    { sql: `INSERT INTO va_benchmarks (name, description, profile_type, reporting_year, authority_profile, visible, template_name, structure, statistic, members, source, summary, member_list, created, created_by, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?)`,
      args: [...fields, cleanText(b.template_name, 150) || null, cleanText(b.structure, 40) || null, statistic, Number(b.members) || summaries.length, JSON.stringify(summary),
        JSON.stringify((Array.isArray(b.files) ? b.files : []).slice(0, 200).map((f: unknown) => ({ file: cleanText(f, 200) }))), t, me.email, t] },
    audit(me.email, "va-add-benchmark", { name }),
  ]);
  return json({ saved: true, id: r[0].lastId });
}

export async function handleBenchmarkDelete(c: Config, request: Request): Promise<Response> {
  const me = await requireSiteAdmin(c, request);
  const b = await readJsonBody(request);
  const r = (await q(c, "SELECT id, name FROM va_benchmarks WHERE id = ?", Number(b.id) || 0))[0];
  if (!r) throw new FriendlyError("That benchmark wasn't found.", 404);
  await exec(c, [{ sql: "DELETE FROM va_benchmarks WHERE id = ?", args: [r.id] }, audit(me.email, "va-delete-benchmark", { name: r.name })]);
  return json({ deleted: true });
}
