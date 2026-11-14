// 语料发现：读 manifest，或扫描官方 corpus 的 tests/cases 目录。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseCase, type ParsedCase } from "./case.ts";

/** manifest 是一个按序存放用例相对路径的 JSON 数组。 */
export function loadManifest(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(`manifest 必须是字符串数组：${path}`);
  }
  return parsed as string[];
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
  const raw = readFileSync(join(corpusRoot, id), "utf8");
  return parseCase(raw, id);
}
