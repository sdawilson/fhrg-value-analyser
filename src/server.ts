// Value Analyser's server, for a bunny.net Magic Container: Node's own web server in front of the
// app (src/app.ts), which works on standard web Requests and Responses.
//   GET /health   {"ok":true} for the container's health check
// Everything else goes to the app. Run as one copy (minimum and maximum 1), so the app's in-memory
// caches and its record of used sign-in passes are shared by every request.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { handleRequest, setPage } from "./app";
import { getConfig, settingsReport } from "./config";

// Nothing the app accepts is bigger than an assessment, with room for its summary, at three bytes a character
const maxRequestBytes = () => (getConfig().maxUpload + 300_000) * 3;

export function startServer(port: number, pageFile = path.resolve(process.cwd(), "public/index.html")): http.Server {
  if (fs.existsSync(pageFile)) setPage(fs.readFileSync(pageFile, "utf8"));
  else console.log(`[warn] ${pageFile} wasn't found`);
  for (const line of settingsReport()) console.log(line);

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => fail(res, e)); });
  server.requestTimeout = 60_000; // time to receive a whole request 
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, () => console.log(`[info] listening on ${port}`));
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.url === "/health" || req.url?.startsWith("/health?")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end('{"ok":true}');
    return;
  }
  if (Number(req.headers["content-length"] || 0) > maxRequestBytes()) {
    res.writeHead(413, { "content-type": "application/json", connection: "close" });
    res.end('{"error":"Request too large."}');
    req.resume();
    return;
  }
  // The app only uses the path and query, so the host part is fixed: no visitor-supplied host is trusted.
  let address: string;
  try { address = new URL(req.url || "/", "https://value-analyser.invalid").href; } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"Bad address."}');
    return;
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const request = new Request(address, {
    method, headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    // @ts-expect-error: Node needs this to stream a request body
    duplex: hasBody ? "half" : undefined,
  });
  const response = await handleRequest(request);
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  // a request answered before all its body arrived: close the connection, or the rest would be read as the next request
  if (response.status === 413 || (hasBody && !req.complete)) out["connection"] = "close";
  res.writeHead(response.status, out);
  if (!response.body || method === "HEAD") { res.end(); return; }
  // pipeline stops reading (for example a storage download) if the visitor goes away
  pipeline(Readable.fromWeb(response.body as any), res, (e) => { if (e && (e as any).code !== "ERR_STREAM_PREMATURE_CLOSE") console.log(`[warn] response not finished: ${e.message}`); });
}

function fail(res: http.ServerResponse, e: unknown): void {
  console.log(`[error] ${(e as Error)?.stack || e}`);
  if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
  res.end('{"error":"Something went wrong. Please try again."}');
}

// Started directly (node dist/server.js); the tests import startServer instead
if (process.argv[1] && /dist[\\/]server\.js$/.test(process.argv[1])) {
  const server = startServer(Number(process.env.PORT) || 8080);
  const stop = () => { console.log("[info] stopping"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("unhandledRejection", (e) => console.log(`[error] unhandled: ${(e as Error)?.stack || e}`));
}
