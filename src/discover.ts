// 语料发现：读 manifest，或扫描官方 corpus 的 tests/cases 目录。
//
// 读用例时按 TS7 Go vfs 的 BOM 规则解码：UTF-16LE / UTF-16BE 先按 BOM
// 选择字节序，再转成普通 UTF-8 文本交给编译器；UTF-8 BOM 不进入内容。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseCase, type ParsedCase } from "./case.ts";

/** manifest ID 必须是 corpus 内的 POSIX 相对路径。 */
export function isValidCaseId(id: string): boolean {
  if (id.length === 0 || id.trim() !== id) return false;
  if (/[\u0000-\u001f]/.test(id) || id.includes("\\")) return false;
  if (id.startsWith("/") || /^[A-Za-z]:/.test(id)) return false;
  const segments = id.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** manifest 是一个按序存放用例相对路径的 JSON 数组。 */
export function loadManifest(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(`manifest 必须是字符串数组：${path}`);
  }
  const ids = parsed as string[];
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (!isValidCaseId(id)) {
      throw new Error(`manifest 第 ${index + 1} 项不是合法的 corpus 相对路径：${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`manifest 含重复用例 ID：${id}（第 ${index + 1} 项）`);
    }
    seen.add(id);
  }
  return ids;
}

/** 递归列出 corpus 里所有 .ts 用例文件（相对 tests/cases 的路径）。 */
export function scanCorpus(corpusRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out.push(relative(corpusRoot, full));
    }
  };
  walk(corpusRoot);
  return out.sort();
}

export function readCase(corpusRoot: string, id: string): ParsedCase {
  if (!isValidCaseId(id)) throw new Error(`非法用例 ID：${JSON.stringify(id)}`);
  const full = join(corpusRoot, id);
  let bytes: Buffer;
  try {
    bytes = readFileSync(full);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取用例文件 ${id}（${full}）：${reason}`);
  }
  return parseCase(decodeCaseText(bytes), id);
}

/** 按 BOM 解码用例文件；与 TS7 Go `vfs/internal.decodeBytes` 保持一致。 */
function decodeCaseText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}
