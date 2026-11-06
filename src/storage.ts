// Bunny Storage, inside ROOT_FOLDER. Files are in the Excel workbook's own format and encoding
// (Windows-1252), so any of them opens in the Excel tool:
//   templates/fhrg/<name>.vt2                the FHRG's scorecard templates (shared with every member)
//   templates/<authority>/<name>.vt2         an authority's own templates
//   assessments/<authority>/<name>.va2       saved assessments
//   versions/<authority>/<name>/<yyyymmdd_hhnnss> v<n>.va2    earlier saves, with KEEP_VERSIONS
import type { Config } from "./config";
import { decodeBytes } from "./vafile";
import { fetchWithTimeout } from "./util";

const STORAGE_MS = 60_000;

export function storageUrl(c: Config, path: string): string {
  const p = (c.root + path).split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `https://${c.storageHost}/${encodeURIComponent(c.storageZone)}/${p}`;
}

export async function storageGet(c: Config, path: string): Promise<Response | null> {
  const res = await fetchWithTimeout(storageUrl(c, path), { headers: { AccessKey: c.storageKey } }, STORAGE_MS);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Storage returned ${res.status} for ${c.root}${path}. Check STORAGE_ZONE, STORAGE_HOST and STORAGE_ACCESS_KEY.`);
  return res;
}

export async function storageText(c: Config, path: string): Promise<string | null> {
  const res = await storageGet(c, path);
  return res ? decodeBytes(new Uint8Array(await res.arrayBuffer())) : null;
}

export async function storagePut(c: Config, path: string, body: Uint8Array | string, contentType: string): Promise<void> {
  const res = await fetchWithTimeout(storageUrl(c, path), { method: "PUT", headers: { AccessKey: c.storageKey, "Content-Type": contentType }, body: body as BodyInit }, STORAGE_MS);
  if (!res.ok) throw new Error(`Storage refused to save ${c.root}${path} (status ${res.status}). The storage password may be the read-only one.`);
}

export async function storageDelete(c: Config, path: string): Promise<void> {
  const res = await fetchWithTimeout(storageUrl(c, path), { method: "DELETE", headers: { AccessKey: c.storageKey } }, STORAGE_MS);
  if (!res.ok && res.status !== 404) throw new Error(`Storage refused to delete ${c.root}${path} (status ${res.status}).`);
}

export async function storageList(c: Config, folder: string): Promise<{ name: string; size: number }[]> {
  const res = await fetchWithTimeout(storageUrl(c, folder.replace(/\/?$/, "/")), { headers: { AccessKey: c.storageKey, accept: "application/json" } }, STORAGE_MS);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Storage returned ${res.status} listing ${c.root}${folder}.`);
  const items: any[] = await res.json().catch(() => []);
  return items.filter((x) => !x.IsDirectory).map((x) => ({ name: String(x.ObjectName), size: Number(x.Length) || 0 }));
}

// file names in storage: the name as typed, made safe for every operating system
export function fileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/[. ]+$/, "").slice(0, 150) || "assessment";
}

export const VA_TYPE = "application/octet-stream";
