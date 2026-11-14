// 官方基线期望源：直接消费 TypeScript 仓库的 errors 基线，与「现场跑 tsc CLI
// 生成期望」并列，指标层不变。
//
// 两种语料布局（都是 tests/cases 与 baselines/reference 相对平级）：
// - strada / 6.0 线：基线按 basename 平铺（`baselines/reference/Foo.errors.txt`）；
// - TS7 Go 布局：基线按用例相对目录分层（`baselines/reference/compiler/Foo.errors.txt`）。
//
// 官方 harness 只在用例有诊断时才写 `.errors.txt`，因此**基线文件缺失等价于
// 「该用例没有期望错误」**（不是跳过）：这既让无错用例参与假阳性检查，也让
// 整个语料都能进指标分母。
//
// 基线文件 = 官方 harness 的输出快照，只对满足下列条件的子集开放（v0）：
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

export type OfficialBaselineOutcome =
  | {
      status: "ok";
      diagnostics: Diagnostic[];
      /**
       * 原始基线文件内容（含 `====` 正文块）；缺失基线（无错用例）时为 null。
       * T3「整份 .errors.txt 字节相等」需要它。
       */
      text: string | null;
    }
  | { status: "skip"; reason: string };

export type ParsedOfficialBaseline =
  | { status: "ok"; diagnostics: Diagnostic[]; text: string }
  | { status: "unsupported"; reason: string };

const DIAG = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s?(.*)$/;
const CONFIG_ERROR = /^error TS\d+:/;
const CASE_HEADER = /^====/;

/**
 * 语料目录（.../tests/cases）对应的官方基线目录。
 *
 * 两种布局的基线位置不同：
 * - strada / 6.0：`tests/baselines/reference`（与 cases 同在 tests/ 下）；
 * - TS7 Go：`testdata/baselines/reference`（与 testdata/tests/ 平级）。
 */
export function officialBaselineDirOf(corpusDir: string): string {
  const insideTests = join(corpusDir, "..", "baselines", "reference");
  if (existsSync(insideTests)) return insideTests;
  const besideTestData = join(corpusDir, "..", "..", "baselines", "reference");
  if (existsSync(besideTestData)) return besideTestData;
  return insideTests;
}

/** 摘出摘要块（第一个 `====` 之前的部分），供 T3 字节比对使用。 */
export function summaryBlockOf(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (CASE_HEADER.test(line)) break;
    lines.push(line);
  }
  // 归一：去掉末尾空行，行尾空白保留（字节比对口径，跨平台只容忍行尾差异）。
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  return lines.join("\n");
}

/** 解析基线文件的错误摘要块（第一个 `====` 之前的部分）。 */
export function parseOfficialBaselineText(text: string): ParsedOfficialBaseline {
  const diagnostics: Diagnostic[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (CASE_HEADER.test(line)) break;
    if (line.trim().length === 0) continue;
    const m = DIAG.exec(line);
    if (m !== null) {
      diagnostics.push({
        file: m[1]!,
        line: Number(m[2])! - 1,
        col: Number(m[3])! - 1,
        code: Number(m[5]),
        severity: m[4] === "warning" ? "warning" : "error",
        message: m[6] !== undefined && m[6]!.length > 0 ? m[6]! : undefined,
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
  return { status: "ok", diagnostics, text };
}

const errorsNameOf = (file: string): string => file.replace(/\.(tsx?|mts|cts)$/, ".errors.txt");

/**
 * 查一个用例对应的基线文件路径：先按相对目录（TS7 Go 布局），再按 basename
 * （strada 平铺布局）。没有基线文件返回 null（= 该用例没有期望错误）。
 */
export function baselineFileOf(corpusDir: string, id: string): string | null {
  const dir = officialBaselineDirOf(corpusDir);
  const nested = join(dir, errorsNameOf(id));
  if (existsSync(nested)) return nested;
  const flat = join(dir, errorsNameOf(basename(id)));
  if (existsSync(flat)) return flat;
  return null;
}

/** 为一个已解析用例查找并读取官方基线。 */
export function expectationFromOfficialBaseline(
  corpusDir: string,
  id: string,
  parsed: ParsedCase,
): OfficialBaselineOutcome {
  if (parsed.multiValueDirectives.length > 0) {
    return { status: "skip", reason: `多值指令变体（${parsed.multiValueDirectives.join(",")}）` };
  }
  if (parsed.absoluteFiles.length > 0) {
    return { status: "skip", reason: "用例含绝对路径 @filename" };
  }
  if (id.endsWith(".d.ts")) {
    return { status: "skip", reason: "d.ts 用例暂不接官方基线" };
  }
  const file = baselineFileOf(corpusDir, id);
  if (file === null) {
    // 官方只在有诊断时写 .errors.txt：缺基线 = 期望零错误。
    return { status: "ok", diagnostics: [], text: null };
  }
  const raw = readFileSync(file, "utf8");
  const parsedBaseline = parseOfficialBaselineText(raw);
  if (parsedBaseline.status === "unsupported") return { status: "skip", reason: parsedBaseline.reason };
  return { status: "ok", diagnostics: parsedBaseline.diagnostics, text: raw };
}
