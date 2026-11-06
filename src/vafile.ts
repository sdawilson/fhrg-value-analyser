// The Excel workbook's file format. The page reads and writes .va2 / .vt2 files; here they are checked,
// kept in the workbook's own encoding (Windows-1252, as its VBA writes them), and read just enough to list them.
import { FriendlyError } from "./util";

export const CP1252_HIGH = [0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178];
export const CP1252_REVERSE = new Map<number, number>(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i] as [number, number]).filter(([cp]) => cp !== 0));

export function encodeCp1252(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out[n++] = cp;
    else out[n++] = CP1252_REVERSE.get(cp) ?? 0x3f;
  }
  return out.slice(0, n);
}

export function decodeBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b >= 0x80 && b < 0xa0 ? (CP1252_HIGH[b - 0x80] || b) : b);
    text = s;
  }
  return text.replace(/^\ufeff/, "");
}

// checks a file from the page: it starts "Begin Header" and has the assessment table
export function checkVaFile(text: unknown, what: string, limit: number): string {
  if (typeof text !== "string" || !text) throw new FriendlyError(`The ${what} is empty.`);
  if (text.length > limit) throw new FriendlyError(`The ${what} is too large.`, 413);
  const t = text.replace(/^\ufeff/, "");
  const first = t.split(/\r?\n/).find((l) => l.trim());
  if (!first || first.trim() !== "Begin Header") throw new FriendlyError("That isn't a Value Analyser file. Its first line should be Begin Header.");
  if (!/\r?\nBegin Table: VA_Assessment\r?\n/.test(t)) throw new FriendlyError("That Value Analyser file has no VA_Assessment table.");
  return t.replace(/\r?\n/g, "\r\n");
}

// The rows' ID, Dimension and Factor_Name, enough for a template's counts and its fingerprint
// (the page's VA.structureKey, which matches assessments made from the same template).
export function vaRows(text: string): { id: string; dimension: string; factor: string }[] {
  // found in steps, not one pattern: this runs on files from outside, and one slow file would hold up everyone
  const at = text.search(/\r?\nBegin Table: VA_Assessment\r?\n/);
  if (at < 0) return [];
  const rest = text.slice(text.indexOf("\n", text.indexOf("Begin Table", at)) + 1);
  const end = rest.search(/\r?\nEnd Section/);
  if (end < 0) return [];
  const out: { id: string; dimension: string; factor: string }[] = [];
  for (const line of rest.slice(0, end).split(/\r?\n/)) {
    if (!/^\s*\|c\|/.test(line)) continue;
    const cell = (name: string) => {
      const part = line.split("|c|").find((p) => p.startsWith(name + "|e|"));
      if (!part) return "";
      const bits = part.split("|e|");
      return bits[1] === "{B}" ? "" : bits.slice(2, Math.max(3, bits.length - 2)).join("|e|");
    };
    out.push({ id: cell("ID"), dimension: cell("Dimension").trim(), factor: cell("Factor_Name") });
  }
  return out;
}
export const normKey = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function structureKey(rows: { id: string; dimension: string; factor: string }[]): string {
  const s = rows.map((r) => {
    const n = Number(String(r.id).trim());
    return `${normKey(r.dimension)}|${String(r.id).trim() !== "" && Number.isFinite(n) ? n : ""}|${normKey(r.factor)}`;
  }).join("\n");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
export function headerValue(text: string, key: string): string {
  const m = text.match(new RegExp(`\\r?\\n[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:= ?([^\\r\\n]*)`));
  return m ? m[1].trim() : "";
}
