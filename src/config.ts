// Value Analyser's settings. They are environment variables set in Magic Containers: Container settings >
// Environment variables. Type the names by hand (a pasted name can carry an invisible character); the
// server logs which names arrived, never their values.
//   Secrets:   STORAGE_ACCESS_KEY            the storage zone's password (not the read-only one)
//              BUNNY_DATABASE_URL            the FHRG website's database, and its read-and-write token (the va_* tables live
//              BUNNY_DATABASE_AUTH_TOKEN       there). Database > Access > "Add Secrets to Magic Container App" sets both
//              SESSION_SECRET                long random text used to sign sign-ins, used by nothing else:
//                                              never the website's own
//   Variables: STORAGE_ZONE (required), STORAGE_HOST (default storage.bunnycdn.com),
//              ROOT_FOLDER (default value-analyser), WEBSITE_URL (default https://fhrg.co.uk, for joining and
//              password resets), SITE_ADMINS (emails, separated by commas; the website's site administrators
//              count too), KEEP_VERSIONS (default 0 = off; for example 10 keeps the ten most recent earlier
//              saves), MIN_PEERS (default 3: the fewest other authorities a live peer comparison may show),
//              MAX_UPLOAD_MB (default 5)

import process from "node:process";

export type Config = {
  storageKey: string;
  storageZone: string;
  storageHost: string;
  root: string;
  dbUrl: string;
  dbToken: string;
  sessionSecret: string;
  siteAdmins: string[];
  fhrgSite: string;
  keepVersions: number;
  minPeers: number;
  maxUpload: number;
};

// Settings are pasted in by hand, so be forgiving: ignore stray spaces, invisible characters and
// wrapping quotes, in names as well as values.
const ODD_CHARS = /[\u0000-\u001F\u007F ​-‍⁠﻿]/g;
function tidy(v: string): string {
  let t = String(v).replace(ODD_CHARS, " ").trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) t = t.slice(1, -1).trim();
  return t;
}
function env(name: string, fallback = "", keepEmpty = false): string {
  const exact = process.env[name];
  if (exact !== undefined && tidy(exact) !== "") return tidy(exact);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== name && tidy(k).toUpperCase() === name && tidy(v) !== "") return tidy(v);
  return exact !== undefined && keepEmpty ? "" : fallback;
}

// For the start-up log: which settings arrived (names only, never values)
const SECRET_SETTINGS = ["STORAGE_ACCESS_KEY", "BUNNY_DATABASE_URL", "BUNNY_DATABASE_AUTH_TOKEN", "SESSION_SECRET"];
const VARIABLE_SETTINGS = ["STORAGE_ZONE", "STORAGE_HOST", "ROOT_FOLDER", "WEBSITE_URL", "SITE_ADMINS", "KEEP_VERSIONS", "MIN_PEERS", "MAX_UPLOAD_MB"];

function folder(name: string, fallback: string): string {
  const f = env(name, fallback, true).replace(/^\/+|\/+$/g, "");
  return f ? f + "/" : "";
}

function pipelineUrl(v: string): string {
  const u = v.replace(/^libsql:\/\//i, "https://").replace(/\/+$/, "");
  return u && !/\/v2\/pipeline$/.test(u) ? u + "/v2/pipeline" : u;
}

export function getConfig(): Config {
  return {
    storageKey: env("STORAGE_ACCESS_KEY"),
    storageZone: env("STORAGE_ZONE"),
    storageHost: env("STORAGE_HOST", "storage.bunnycdn.com").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    root: folder("ROOT_FOLDER", "value-analyser"),
    dbUrl: pipelineUrl(env("BUNNY_DATABASE_URL")),
    dbToken: env("BUNNY_DATABASE_AUTH_TOKEN"),
    sessionSecret: env("SESSION_SECRET"),
    siteAdmins: env("SITE_ADMINS").split(/[;,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
    fhrgSite: (env("WEBSITE_URL") || "https://fhrg.co.uk").replace(/\/+$/, ""),
    keepVersions: Math.max(0, Math.min(100, Math.round(Number(env("KEEP_VERSIONS", "0")) || 0))),
    minPeers: Math.max(3, Math.min(50, Math.round(Number(env("MIN_PEERS", "3")) || 3))),
    maxUpload: Math.max(1, Math.min(20, Number(env("MAX_UPLOAD_MB", "5")) || 5)) * 1024 * 1024,
  };
}

export function missingSettings(c: Config): string[] {
  const m: string[] = [];
  if (!c.storageKey) m.push("STORAGE_ACCESS_KEY");
  if (!c.storageZone) m.push("STORAGE_ZONE");
  if (!c.dbUrl) m.push("BUNNY_DATABASE_URL");
  if (!c.dbToken) m.push("BUNNY_DATABASE_AUTH_TOKEN");
  if (!c.sessionSecret) m.push("SESSION_SECRET");
  return m;
}

export function settingsReport(): string[] {
  const c = getConfig();
  const names = [...SECRET_SETTINGS, ...VARIABLE_SETTINGS];
  const missing = missingSettings(c);
  return [
    `[info] settings received: ${names.filter((n) => env(n) !== "").join(", ") || "none"}`,
    `[info] not set (defaults or off): ${names.filter((n) => env(n) === "").join(", ") || "none"}`,
    missing.length ? `[error] required settings missing: ${missing.join(", ")}` : "[info] all required settings are present",
  ];
}
