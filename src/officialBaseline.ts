// 官方基线期望源：直接消费 microsoft/TypeScript 仓库的
// tests/baselines/reference/<case>.errors.txt，与「现场跑 tsc CLI 生成期望」
// 并列，指标层不变。
//
// 基线文件 = 官方 harness 的输出快照，因此只对满足下列条件的子集开放（v0）：
// - 用例没有多值指令（多值会产生带 (key=value) 配置后缀的基线，见 DESIGN §3.3）；
// - 用例不含绝对路径 @filename（官方虚拟 FS 根，磁盘物化不安全）；
// - 基线摘要块只有带文件位置的 `file(line,col): error TSxxxx: ...` 行；
//   配置错误（无位置）与语法错误（TS1xxx）整体跳过——它们和当前期望源的
//   「语法即整案 SKIP」口径不兼容。
//
// 已知偏差：官方基线来自仓库源码快照，不一定和 npm 上发布的 tsc 补丁版本
// 逐条一致（2026-11-15 的冒烟样本里 116 例中 111 例完全一致，5 例不同）。

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ParsedCase } from "./case.ts";
import type { Diagnostic } from "./types.ts";

export type OfficialBaselineOutcome = { status: "ok"; diagnostics: Diagnostic[] } | { status: "skip"; reason: string };

export type ParsedOfficialBaseline = { status: "ok"; diagnostics: Diagnostic[] } | { status: "unsupported"; reason: string };

const DIAG = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s?(.*)$/;
const CONFIG_ERROR = /^error TS\d+:/;

/** 语料目录（.../tests/cases）对应的官方基线目录。 */
export function officialBaselineDirOf(corpusDir: string): string {
  return join(corpusDir, "..", "baselines", "reference");
}

/** 解析基线文件的错误摘要块（第一个 `====` 之前的部分）。 */
export function parseOfficialBaselineText(text: string): ParsedOfficialBaseline {
  const diagnostics: Diagnostic[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith("====")) break;
    if (line.trim().length === 0) continue;
    const m = DIAG.exec(line);
    if (m !== null) {
      diagnostics.push({
        file: m[1]!,
        line: Number(m[2]) - 1,
        col: Number(m[3]) - 1,
        code: Number(m[4]),
        severity: "error",
        message: m[5] !== undefined && m[5].length > 0 ? m[5] : undefined,
      });
      continue;
    }
    // 无位置的配置错误无法映射到文件诊断，整个用例跳过。
    if (CONFIG_ERROR.test(line)) return { status: "unsupported", reason: "官方基线含配置错误（无文件位置）" };
    // 其余是 elaboration 续行（tsc 多行错误说明），不是新诊断。
  }
  if (diagnostics.some((d) => (d.code >= 1000 && d.code < 2000) || d.code === 17006 || d.code === 17007)) {
    return { status: "unsupported", reason: "官方基线含语法错误" };
  }
  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.code - b.code);
  return { status: "ok", diagnostics };
}

/** 为一个已解析用例查找并读取官方基线。 */
export function expectationFromOfficialBaseline(corpusDir: string, id: string, parsed: ParsedCase): OfficialBaselineOutcome {
  if (parsed.multiValueDirectives.length > 0) {
    return { status: "skip", reason: `多值指令变体（${parsed.multiValueDirectives.join(",")}）` };
  }
  if (parsed.absoluteFiles.length > 0) {
    return { status: "skip", reason: "用例含绝对路径 @filename" };
  }
  if (id.endsWith(".d.ts")) {
    return { status: "skip", reason: "d.ts 用例暂不接官方基线" };
  }
  const caseBase = basename(id).replace(/\.(tsx?|mts|cts)$/, "");
  const file = join(officialBaselineDirOf(corpusDir), `${caseBase}.errors.txt`);
  if (!existsSync(file)) return { status: "skip", reason: "没有官方 errors 基线" };
  const parsedBaseline = parseOfficialBaselineText(readFileSync(file, "utf8"));
  if (parsedBaseline.status === "unsupported") return { status: "skip", reason: parsedBaseline.reason };
  return { status: "ok", diagnostics: parsedBaseline.diagnostics };
}
