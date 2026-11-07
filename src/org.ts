// The organisation map: each authority's organisation, its services, their functions and, if wanted, processes.
// Each item has a weight (its share among its siblings) and a property sheet of named facts. Standard items keep
// fixed keys (std_key), so they can be compared across authorities later, even once renamed. The map lives in
// the database only: the Excel tool has no organisation map.
import type { Me } from "./accounts";
import { requireMe } from "./accounts";
import type { Config } from "./config";
import type { Row, Stmt } from "./db";
import { audit, exec, q } from "./db";
import { DEFAULT_SERVICE, checkServiceName, cleanService, listedService, serviceKey } from "./services";
import { cleanLevels } from "./templates";
import { FriendlyError, json, now, readJsonBody } from "./util";

export const LEVEL_BELOW: Record<string, string> = { organisation: "service", service: "function", function: "process" };
const MAX_ITEMS = 600, MAX_FACTS = 40;

// The standard highways functions a new map starts with (Simon, 6 November 2026). Their keys never change.
// a standard function's key as a file states it: one of the FHRG's, or none
export const functionKey = (v: unknown): string | null => { const k = String(v ?? "").trim(); return STANDARD_FUNCTIONS.some(([key]) => key === k) ? k : null; };
// the function a template is for counts only on a Highways template that can be used on functions or processes
export function templateFunction(key: unknown, levels: string, service: string): string | null {
  const fn = functionKey(key);
  return fn && serviceKey(service) === serviceKey(DEFAULT_SERVICE) && /(^|,)(function|process)(,|$)/.test(levels) ? fn : null;
}
export const STANDARD_FUNCTIONS: [string, string][] = [
  ["hw.asset-management", "Asset management and strategy"], ["hw.carriageways", "Carriageways"], ["hw.footways", "Footways and cycleways"],
  ["hw.drainage", "Drainage"], ["hw.structures", "Structures"], ["hw.street-lighting", "Street lighting and illuminated signs"],
  ["hw.traffic-signals", "Traffic signals and ITS"], ["hw.winter", "Winter service"], ["hw.inspections", "Safety inspections and reactive repairs"],
  ["hw.network-management", "Network management and street works"], ["hw.road-safety", "Road safety"], ["hw.rights-of-way", "Public rights of way"],
  ["hw.verges", "Verges, trees and grass cutting"], ["hw.design", "Highway design and capital schemes"], ["hw.development", "Development management"],
];

// a name on the map: one line of plain text a file could hold
export function cleanItemName(v: unknown): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 80) throw new FriendlyError("Give it a name of 2 to 80 characters.", 400, "name");
  return s;
}

// the authority whose map this is: your own, or any authority there is for a site administrator who asks
async function authorityOf(c: Config, me: Me, b: any): Promise<number> {
  const asked = Number(b.authorityId) || 0;
  if (!me.siteAdmin || !asked || asked === me.authorityId) return me.authorityId;
  if (!(await q(c, "SELECT id FROM authorities WHERE id = ?", asked))[0]) throw new FriendlyError("That authority wasn't found.", 404);
  return asked;
}
// a service named on the map joins the authority's own services, unless the FHRG's list or its own has it already
const listService = (aid: number, name: string, who: string, t: string): Stmt => ({
  sql: "INSERT OR IGNORE INTO va_services (scope_id, name, name_key, created, created_by) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM va_services WHERE name_key = ? AND (scope_id = 0 OR scope_id = ?))",
  args: [aid, name, name.toLowerCase(), t, who, name.toLowerCase(), aid],
});

// A new map, in one request to the database. The standard items are made by the toolkit, not by whoever happened
// to open the map first, so only the lead or the FHRG team can remove them; and each is there at most once
// (va_org_items_standard), so starting twice adds nothing.
async function seed(c: Config, me: Me, aid: number): Promise<void> {
  const name = (await q(c, "SELECT name FROM authorities WHERE id = ?", aid))[0]?.name || me.authorityName || "Our organisation";
  const t = now(), by = "toolkit";
  const parent = (key: string) => `(SELECT id FROM va_org_items WHERE authority_id = ${Number(aid)} AND std_key = '${key}')`;
  await exec(c, [
    { sql: "INSERT OR IGNORE INTO va_org_items (authority_id, parent_id, level, name, std_key, weight, sort, created, created_by, updated, updated_by) VALUES (?, NULL, 'organisation', ?, 'org', 100, 0, ?, ?, ?, ?)", args: [aid, name, t, by, t, by] },
    { sql: `INSERT OR IGNORE INTO va_org_items (authority_id, parent_id, level, name, std_key, service, weight, sort, created, created_by, updated, updated_by) SELECT ?, ${parent("org")}, 'service', ?, 'svc.highways', ?, 100, 0, ?, ?, ?, ?`, args: [aid, DEFAULT_SERVICE, DEFAULT_SERVICE, t, by, t, by] },
    ...STANDARD_FUNCTIONS.map(([key, fn], i): Stmt => ({ sql: `INSERT OR IGNORE INTO va_org_items (authority_id, parent_id, level, name, std_key, weight, sort, created, created_by, updated, updated_by) SELECT ?, ${parent("svc.highways")}, 'function', ?, ?, 100, ?, ?, ?, ?, ?`, args: [aid, fn, key, i, t, by, t, by] })),
    audit(me.email, "va-org-start", { authority: aid }),
  ]);
}

async function mapOf(c: Config, aid: number) {
  const items = await q(c, "SELECT id, parent_id, level, name, std_key, service, weight, sort, created_by, updated, updated_by FROM va_org_items WHERE authority_id = ? ORDER BY sort, id", aid);
  const properties = await q(c, "SELECT id, scope_id, key, name, kind, unit, choices FROM va_properties WHERE scope_id = 0 OR scope_id = ? ORDER BY scope_id <> 0, sort, id", aid);
  const ids = new Set(items.map((x) => x.id));
  const rows = items.length ? await q(c, "SELECT v.item_id, v.property_id, v.value FROM va_property_values v JOIN va_org_items i ON i.id = v.item_id WHERE i.authority_id = ?", aid) : [];
  const values: Record<string, Record<string, string>> = {};
  for (const r of rows) if (ids.has(r.item_id)) (values[r.item_id] ??= {})[r.property_id] = r.value;
  return {
    items: items.map((x) => ({ ...x, service: x.level === "service" ? cleanService(x.service || x.name) : undefined })),
    properties: properties.map((p) => ({ id: p.id, fhrg: p.scope_id === 0, key: p.key, name: p.name, kind: p.kind, unit: p.unit || "", choices: p.choices ? JSON.parse(p.choices) : [] })),
    values,
  };
}

const seeding = new Map<number, Promise<void>>();
export async function handleOrgGet(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const aid = await authorityOf(c, me, b);
  if (!(await q(c, "SELECT id FROM va_org_items WHERE authority_id = ? AND std_key = 'org'", aid))[0]) {
    // one start at a time for each authority (the container is a single instance)
    if (!seeding.has(aid)) seeding.set(aid, seed(c, me, aid).finally(() => seeding.delete(aid)));
    await seeding.get(aid);
  }
  const authority = (await q(c, "SELECT name FROM authorities WHERE id = ?", aid))[0]?.name || me.authorityName;
  return json({ authority, ...(await mapOf(c, aid)) });
}

// an item of this authority's map, or nothing at all (as if it weren't there)
async function itemFor(c: Config, aid: number, id: unknown): Promise<Row> {
  const it = (await q(c, "SELECT * FROM va_org_items WHERE id = ?", Number(id) || 0))[0];
  if (!it || it.authority_id !== aid) throw new FriendlyError("That isn't on your map. It may have been removed.", 404);
  return it;
}

export async function handleOrgItem(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const aid = await authorityOf(c, me, b);
  const t = now();
  switch (b.action) {
    case "add": {
      const parent = await itemFor(c, aid, b.parentId);
      const level = LEVEL_BELOW[parent.level];
      if (!level) throw new FriendlyError("Processes are the last level of the map, so nothing goes below one.");
      if ((await q(c, "SELECT COUNT(*) AS n FROM va_org_items WHERE authority_id = ?", aid))[0].n >= MAX_ITEMS) throw new FriendlyError(`A map can hold up to ${MAX_ITEMS} items.`);
      let name = level === "service" ? checkServiceName(b.name) : cleanItemName(b.name), service: string | null = null;
      if (level === "service") {
        // a service on the map is one of the services templates are for: added to the authority's list if it's new
        name = await listedService(c, name, aid);
        service = name;
        await exec(c, [listService(aid, name, me.email, t)]);
      }
      const sort = (await q(c, "SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM va_org_items WHERE parent_id = ?", parent.id))[0].s;
      const r = await exec(c, [
        { sql: "INSERT INTO va_org_items (authority_id, parent_id, level, name, service, weight, sort, created, created_by, updated, updated_by) VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?)", args: [aid, parent.id, level, name, service, sort, t, me.email, t, me.email] },
        audit(me.email, "va-org-add", { authority: aid, level, name }),
      ]);
      return json({ ok: true, id: r[0].lastId });
    }
    case "rename": {
      const it = await itemFor(c, aid, b.id);
      let name = it.level === "service" ? checkServiceName(b.name) : cleanItemName(b.name);
      if (it.level === "service") name = await listedService(c, name, aid);
      await exec(c, [
        ...(it.level === "service" ? [listService(aid, name, me.email, t)] : []),
        { sql: "UPDATE va_org_items SET name = ?, service = CASE WHEN level = 'service' THEN ? ELSE service END, updated = ?, updated_by = ? WHERE id = ?", args: [name, name, t, me.email, it.id] },
      ]);
      return json({ ok: true });
    }
    case "weight": {
      const it = await itemFor(c, aid, b.id);
      const w = Number(b.weight);
      if (!Number.isFinite(w) || w < 0 || w > 100) throw new FriendlyError("A weighting is a number from 0 to 100.", 400, "weight");
      await exec(c, [{ sql: "UPDATE va_org_items SET weight = ?, updated = ?, updated_by = ? WHERE id = ?", args: [Math.round(w * 100) / 100, t, me.email, it.id] }]);
      return json({ ok: true });
    }
    case "move": {
      const it = await itemFor(c, aid, b.id);
      if (!it.parent_id) throw new FriendlyError("The organisation stays in the middle.");
      const sibs = await q(c, "SELECT id, sort FROM va_org_items WHERE parent_id = ? ORDER BY sort, id", it.parent_id);
      const i = sibs.findIndex((x) => x.id === it.id), j = i + (Number(b.dir) < 0 ? -1 : 1);
      if (j < 0 || j >= sibs.length) return json({ ok: true });
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      await exec(c, sibs.map((x, k): Stmt => ({ sql: "UPDATE va_org_items SET sort = ? WHERE id = ?", args: [k, x.id] })));
      return json({ ok: true });
    }
    case "remove": {
      const it = await itemFor(c, aid, b.id);
      if (!it.parent_id) throw new FriendlyError("The organisation can't be removed.");
      if (!me.siteAdmin && me.role !== "lead" && it.created_by !== me.email) throw new FriendlyError("Only your authority's lead, or whoever added it, can remove this.", 403);
      const all = await q(c, "SELECT id, parent_id, created_by FROM va_org_items WHERE authority_id = ?", aid);
      const gone = new Set<number>([it.id]);
      for (let grew = true; grew; ) { grew = false; for (const x of all) if (!gone.has(x.id) && gone.has(x.parent_id)) { gone.add(x.id); grew = true; } }
      if (gone.size > 1 && b.withEverything !== true) throw new FriendlyError(`${it.name} has ${gone.size - 1} item${gone.size === 2 ? "" : "s"} below it.`, 409, undefined, { below: gone.size - 1 });
      // what others added below it goes only with the lead's or the FHRG team's say-so
      if (!me.siteAdmin && me.role !== "lead" && all.some((x) => gone.has(x.id) && x.created_by !== me.email)) throw new FriendlyError("Someone else added items below this, so only your authority's lead can remove it.", 403);
      const list = [...gone];
      await exec(c, [
        ...list.map((id): Stmt => ({ sql: "DELETE FROM va_property_values WHERE item_id = ?", args: [id] })),
        // assessments on what's removed stay, off the map
        ...list.map((id): Stmt => ({ sql: "UPDATE va_assessments SET org_item_id = NULL WHERE org_item_id = ? AND authority_id = ?", args: [id, aid] })),
        ...list.map((id): Stmt => ({ sql: "DELETE FROM va_org_items WHERE id = ?", args: [id] })),
        audit(me.email, "va-org-remove", { authority: aid, name: it.name, items: list.length }),
      ]);
      return json({ ok: true, removed: list.length });
    }
    default: throw new FriendlyError("Unknown action.");
  }
}

// one fact on an item's property sheet; an empty value clears it
export async function handleOrgFact(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const aid = await authorityOf(c, me, b);
  const it = await itemFor(c, aid, b.itemId);
  const p = (await q(c, "SELECT * FROM va_properties WHERE id = ?", Number(b.propertyId) || 0))[0];
  if (!p || (p.scope_id !== 0 && p.scope_id !== aid)) throw new FriendlyError("That fact isn't available.", 404);
  let v = String(b.value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (v) {
    if (p.kind === "money" || p.kind === "number") {
      const bare = v.replace(/[£,\s]/g, ""), n = Number(bare);
      if (!/^\d+(\.\d+)?$/.test(bare) || n > 1e13) throw new FriendlyError(p.kind === "money" ? "Give an amount in pounds, such as 2,500,000." : "Give a number, such as 120.", 400, "value");
      v = String(Math.round(n * 100) / 100);
    } else if (p.kind === "choice") {
      const choices: string[] = p.choices ? JSON.parse(p.choices) : [];
      const hit = choices.find((x) => x.toLowerCase() === v.toLowerCase());
      if (!hit) throw new FriendlyError(`Choose one of: ${choices.join(", ")}.`, 400, "value");
      v = hit;
    } else if (v.length > 200) throw new FriendlyError("Keep it to 200 characters.", 400, "value");
  }
  await exec(c, [v
    ? { sql: "INSERT INTO va_property_values (item_id, property_id, value, updated, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id, property_id) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by", args: [it.id, p.id, v, now(), me.email] }
    : { sql: "DELETE FROM va_property_values WHERE item_id = ? AND property_id = ?", args: [it.id, p.id] }]);
  return json({ ok: true, value: v });
}

// a fact of the authority's own, for every item on its map
export async function handleOrgFactAdd(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const aid = await authorityOf(c, me, b);
  const name = String(b.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) throw new FriendlyError("Give the fact a name of 2 to 60 characters.", 400, "name");
  const kind = ["money", "number", "text", "choice"].includes(b.kind) ? b.kind : "text";
  const choices = kind === "choice" ? [...new Set((Array.isArray(b.choices) ? b.choices : String(b.choices ?? "").split(",")).map((x: unknown) => String(x).replace(/\s+/g, " ").trim()).filter((x: string) => x && x.length <= 40))].slice(0, 12) : [];
  if (kind === "choice" && choices.length < 2) throw new FriendlyError("Give at least two choices, separated by commas.", 400, "choices");
  const key = `own.${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "fact"}`;
  const have = await q(c, "SELECT id, key, name FROM va_properties WHERE scope_id = 0 OR scope_id = ?", aid);
  if (have.some((x) => String(x.name).toLowerCase() === name.toLowerCase())) throw new FriendlyError("There's already a fact with that name.", 409, "name");
  if (have.filter((x) => x.key.startsWith("own.")).length >= MAX_FACTS) throw new FriendlyError(`An authority can add up to ${MAX_FACTS} facts of its own.`);
  const unit = String(b.unit ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 20);
  const r = await exec(c, [
    { sql: "INSERT INTO va_properties (scope_id, key, name, kind, unit, choices, sort, created, created_by) VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?)", args: [aid, `${key}-${Date.now().toString(36)}`, name, kind, unit || null, choices.length ? JSON.stringify(choices) : null, now(), me.email] },
    audit(me.email, "va-org-fact-add", { authority: aid, name }),
  ]);
  return json({ ok: true, id: r[0].lastId });
}

// ------------------------------------------------------------- assessments on the map
// An assessment can be put on one item of its own authority's map, at a level its template allows (an assessment
// with no template, such as one brought in from the Excel tool, can go at any level), and, below the organisation,
// only within its own service: a Waste assessment doesn't go on a Highways function.
export async function placeFor(c: Config, a: Row, itemId: unknown): Promise<Row> {
  const it = await itemFor(c, a.authority_id, itemId);
  const tpl = a.template_id ? (await q(c, "SELECT levels, scope_id, std_function FROM va_templates WHERE id = ?", a.template_id))[0] : null;
  const levels = tpl ? cleanLevels(tpl.levels).split(",") : null;
  const word = (l: string) => (l === "organisation" ? "the organisation" : `a ${l}`);
  if (levels && !levels.includes(it.level)) {
    const how = tpl!.scope_id === 0 ? "The FHRG team sets the levels of its templates." : "A template's levels are set in the template editor.";
    throw new FriendlyError(`${a.name} is from a template for ${levels.join(", ")} level, so it can't go on ${word(it.level)}. ${how}`, 400, "itemId");
  }
  if (it.level !== "organisation") {
    const all = await q(c, "SELECT id, parent_id, level, service, std_key FROM va_org_items WHERE authority_id = ?", a.authority_id);
    let up: Row | undefined = all.find((x) => x.id === it.id);
    while (up && up.level !== "service") up = all.find((x) => x.id === up!.parent_id);
    const service = up ? cleanService(up.service) : DEFAULT_SERVICE;
    if (serviceKey(service) !== serviceKey(a.service)) throw new FriendlyError(`${a.name} is for ${cleanService(a.service)}, and ${it.name} is part of ${service}.`, 400, "itemId");
    // a template for one standard function: only that function and the processes within it (an authority's own
    // functions can use any)
    const fn = functionKey(tpl?.std_function);
    if (fn && (it.level === "function" || it.level === "process")) {
      let up: Row | undefined = all.find((x) => x.id === it.id);
      while (up && up.level === "process") up = all.find((x) => x.id === up!.parent_id);
      const own = up ? functionKey(up.std_key) : null;
      const name = STANDARD_FUNCTIONS.find(([k]) => k === fn)![1];
      if (own && own !== fn) throw new FriendlyError(`${a.name} is from a template for ${name}, so it goes on that function or a process within it.`, 400, "itemId");
    }
  }
  return it;
}

// Putting an assessment on the map, moving it, or taking it off (itemId 0). Anyone who can save it can place it.
export async function handleAttach(c: Config, request: Request): Promise<Response> {
  const me = await requireMe(c, request);
  const b = await readJsonBody(request);
  const a = (await q(c, "SELECT id, authority_id, name, template_id, service, org_item_id FROM va_assessments WHERE id = ?", Number(b.id) || 0))[0];
  if (!a || (a.authority_id !== me.authorityId && !me.siteAdmin)) throw new FriendlyError("That assessment wasn't found. It may have been deleted.", 404);
  const it = Number(b.itemId) ? await placeFor(c, a, b.itemId) : null;
  await exec(c, [
    // written only while the item is still on the authority's map
    it ? { sql: "UPDATE va_assessments SET org_item_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM va_org_items WHERE id = ? AND authority_id = ?)", args: [it.id, a.id, it.id, a.authority_id] }
      : { sql: "UPDATE va_assessments SET org_item_id = NULL WHERE id = ?", args: [a.id] },
    audit(me.email, it ? "va-place-assessment" : "va-unplace-assessment", { id: a.id, name: a.name, item: it ? it.name : null }),
  ]);
  return json({ ok: true, itemId: it ? it.id : null });
}
