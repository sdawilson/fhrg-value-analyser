// Value Analyser: the web edition of the Value Analyser II Excel workbook, a balanced-scorecard toolkit for value
// for money, best practice and strategic options, for members of the Future Highways Research Group. These are
// its routes, on standard web Requests and Responses. Sign-in uses the FHRG website's accounts. Only approved
// members of approved authorities can use it.
//
//   GET  /  /assessments  /a/<id>/...  /templates/...  /benchmarks/...  /guidance  /signin  /admin ...
//                                  the toolkit page
//   GET  /demo                     the Northbridge demonstration: the same page on fictional data, in the browser
//   GET  /api/boot                 the signed-in person and the toolkit's switches
//   GET  /download/assessment/<id> | template/<id> | version/<id>
//   GET  /export/assessments.csv | dimensions.csv            site administrators, for Excel
//   POST /api/login | logout
//   POST /api/templates/list | get | save | delete
//   POST /api/assessments/list | open | save | delete | versions | restore | share
//   POST /api/benchmarks/list | get | peers
//   POST /api/admin/overview | assessments | authorities | templates | template-action | benchmarks | benchmark-build
//        /api/admin/benchmark-save | benchmark-delete | activity
//                                  site administrators
//
// Bunny Database: the website's authorities, users and audit tables, plus the toolkit's va_* tables, created
// automatically on first use. Files are in storage (see storage.ts).

import { handleBoot, handleLogin, handleLogout } from "./accounts";
import { handleActivity, handleAdminAssessments, handleAdminAuthorities, handleAdminTemplates, handleOverview, handleTemplateAction } from "./admin";
import { handleAssessmentDelete, handleAssessmentList, handleAssessmentOpen, handleAssessmentSave, handleAssessmentShare, handleRestore, handleVersions } from "./assessments";
import { handleAdminBenchmarks, handleBenchmarkBuild, handleBenchmarkDelete, handleBenchmarkGet, handleBenchmarkList, handleBenchmarkSave, handlePeers } from "./benchmarks";
import type { Config } from "./config";
import { getConfig, missingSettings } from "./config";
import { DbError } from "./db";
import { handleDownload, handleExport } from "./downloads";
import { handleOrgFact, handleOrgFactAdd, handleOrgGet, handleOrgItem } from "./org";
import { handleServiceAdd, handleServiceDelete, handleServiceList } from "./services";
import { handleTemplateDelete, handleTemplateGet, handleTemplateHide, handleTemplateList, handleTemplateSave } from "./templates";
import { FriendlyError, escapeHtml, json } from "./util";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// The page travels in the container, read once at start-up. It runs on fictional data unless it's served live.
let page: string | null = null, demoPage: string | null = null;
export function setPage(html: string | null): void { demoPage = html; page = html ? html.replace("const LIVE = false;", "const LIVE = true;") : null; }

function servePage(c: Config): Response {
  const missing = missingSettings(c);
  if (missing.length) return new Response(`<p>The toolkit is not set up yet. Missing settings: ${escapeHtml(missing.join(", "))}.</p>`, { status: 500, headers: PAGE_HEADERS });
  if (!page) return new Response("<p>The toolkit's page wasn't found.</p>", { status: 500, headers: PAGE_HEADERS });
  return new Response(page, { headers: PAGE_HEADERS });
}

const PAGE_PATH = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/i;

export async function handleRequest(request: Request): Promise<Response> {
  const c = getConfig();
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
      if (path === "/demo") return c.demo && demoPage ? new Response(demoPage, { headers: PAGE_HEADERS }) : new Response("Not found", { status: 404 });
      if (missingSettings(c).length && (path.startsWith("/api/") || path.startsWith("/download/"))) throw new FriendlyError(`The toolkit is not set up yet. Missing settings: ${missingSettings(c).join(", ")}.`, 500);
      if (path === "/api/boot") return await handleBoot(c, request);
      const dl = path.match(/^\/download\/(assessment|template|version)\/(\d+)$/);
      if (dl) return await handleDownload(c, request, dl[1], Number(dl[2]));
      const ex = path.match(/^\/export\/(assessments\.csv|dimensions\.csv)$/);
      if (ex) return await handleExport(c, request, ex[1]);
      if (path.startsWith("/api/")) return json({ error: "Not found." }, 404);
      if (PAGE_PATH.test(path)) return servePage(c);
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "POST" && path.startsWith("/api/")) {
      // every call from the page carries this header; another site's form can't send it
      if (request.headers.get("x-fhrg") !== "1") throw new FriendlyError("Request not allowed.", 403);
      if (missingSettings(c).length && path !== "/api/logout") throw new FriendlyError(`The toolkit is not set up yet. Missing settings: ${missingSettings(c).join(", ")}.`, 500);
      switch (path) {
        case "/api/login": return await handleLogin(c, request);
        case "/api/logout": return handleLogout();
        case "/api/templates/list": return await handleTemplateList(c, request);
        case "/api/templates/get": return await handleTemplateGet(c, request);
        case "/api/templates/save": return await handleTemplateSave(c, request);
        case "/api/templates/delete": return await handleTemplateDelete(c, request);
        case "/api/templates/hide": return await handleTemplateHide(c, request);
        case "/api/services/list": return await handleServiceList(c, request);
        case "/api/org/get": return await handleOrgGet(c, request);
        case "/api/org/item": return await handleOrgItem(c, request);
        case "/api/org/fact": return await handleOrgFact(c, request);
        case "/api/org/fact-add": return await handleOrgFactAdd(c, request);
        case "/api/services/add": return await handleServiceAdd(c, request);
        case "/api/admin/service-delete": return await handleServiceDelete(c, request);
        case "/api/assessments/list": return await handleAssessmentList(c, request);
        case "/api/assessments/open": return await handleAssessmentOpen(c, request);
        case "/api/assessments/save": return await handleAssessmentSave(c, request);
        case "/api/assessments/delete": return await handleAssessmentDelete(c, request);
        case "/api/assessments/versions": return await handleVersions(c, request);
        case "/api/assessments/restore": return await handleRestore(c, request);
        case "/api/assessments/share": return await handleAssessmentShare(c, request);
        case "/api/benchmarks/list": return await handleBenchmarkList(c, request);
        case "/api/benchmarks/get": return await handleBenchmarkGet(c, request);
        case "/api/benchmarks/peers": return await handlePeers(c, request);
        case "/api/admin/overview": return await handleOverview(c, request);
        case "/api/admin/assessments": return await handleAdminAssessments(c, request);
        case "/api/admin/authorities": return await handleAdminAuthorities(c, request);
        case "/api/admin/templates": return await handleAdminTemplates(c, request);
        case "/api/admin/template-action": return await handleTemplateAction(c, request);
        case "/api/admin/benchmarks": return await handleAdminBenchmarks(c, request);
        case "/api/admin/benchmark-build": return await handleBenchmarkBuild(c, request);
        case "/api/admin/benchmark-save": return await handleBenchmarkSave(c, request);
        case "/api/admin/benchmark-delete": return await handleBenchmarkDelete(c, request);
        case "/api/admin/activity": return await handleActivity(c, request);
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (e) {
    if (e instanceof FriendlyError) return json({ error: e.message, ...(e.field ? { field: e.field } : {}), ...(e.extra || {}) }, e.status);
    console.log(`[ERROR] ${request.method} ${path}: ${(e as Error)?.stack ?? e}`);
    const message = (e as Error)?.message ?? "";
    if (e instanceof DbError) return json({ error: /UNIQUE/i.test(message) ? "That already exists." : message }, 500);
    return json({ error: /storage/i.test(message) ? message : "Something went wrong. Please try again." }, 500);
  }
}