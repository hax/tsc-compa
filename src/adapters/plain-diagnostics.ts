// 非 pretty 诊断文本的共享解析：参考 tsc 期望与 tsc-cli 适配器必须用同一口径。
//
// `Diagnostic.fullText` / `CaseOutcome.fullText` 的契约是「诊断摘要流」，不是
// 进程的完整 stdout/stderr：
// - 每条诊断一个块，首行重建为 `用例内路径(1-based 行,列): severity TS码: 文本`；
// - 保留该诊断的缩进续行（message chain / related 的文本形态），行内空白原样；
// - 块与块按实际输出顺序用 LF 连接，不含空行、计时、调试日志或源码标注；
// - 空串表示「已成功取得输出且没有诊断」；undefined 表示未提供，不能互相替代。
//
// 行列单位为 UTF-16 code unit；tsc CLI 的 `(line,col)` 本身即为 1-based UTF-16，
// 这里只减 1 转成接口的 0-based，不做字节/码点换算。

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../types.ts";

/** tsc `--pretty false` 的诊断首行。 */
export const PLAIN_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s?(.*)$/;

/** 没有文件位置的诊断，例如配置错误 `error TS6046: ...`。 */
export const UNPOSITIONED_DIAGNOSTIC = /^\s*(error|warning)\s+TS(\d+):\s?(.*)$/;

/** 缩进开头的是后续说明/related 文本；空行不并入上一个诊断块。 */
const CONTINUATION = /^\s+\S/;

export interface UnpositionedDiagnostic {
  severity: "error" | "warning";
  code: number;
  message?: string;
  /** 原样诊断行，供 rawOutput 之外的高层摘要使用。 */
  text: string;
}

export interface ParsedPlainDiagnostics {
  diagnostics: Diagnostic[];
  /** 归一化后的完整诊断摘要流；空串是明确的空结果。 */
  rendered: string;
  /** 识别到的诊断首行数（含临时目录之外、最终被剔除的诊断）。 */
  headerLines: number;
  /** 诊断首行存在，但路径不在用例临时目录内而被剔除的数量。 */
  outsideHeaders: number;
  /** 没有文件位置的 TS 诊断；不能伪装成零诊断。 */
  unpositioned: UnpositionedDiagnostic[];
  /** 含 TS1xxx / TS17006 / TS17007（与期望源语法即 SKIP 的口径一致）。 */
  syntaxError: boolean;
}

// These CLI diagnostics explicitly reject an option or option combination.
// Unknown positionless errors (such as a missing file) are execution failures.
const UNSUPPORTED_OPTION_CODES = new Set([5023, 5042, 5052, 5069, 5070, 5071, 5095, 5102, 5107, 5108, 5110, 6046]);

export function rejectsCompilerOptions(exitCode: number | null, parsed: ParsedPlainDiagnostics): boolean {
  return (exitCode === 1 || exitCode === 2) && parsed.headerLines === 0 && parsed.unpositioned.length > 0 &&
    parsed.unpositioned.every((d) => UNSUPPORTED_OPTION_CODES.has(d.code));
}

/**
 * tsc/tsrs 的 `--extendedDiagnostics` 与统计输出版式。
 * 这不是诊断；clean 用例只输出这些行时，fullText 必须是明确的空串。
 */
const KNOWN_AUXILIARY_LINES: RegExp[] = [
  // 识别范围内的 `time:` 行：tsc 5.9/6.0/7.1、tsrs、tsz 的相位名混用大小写、
  // 空格、斜杠和连字符（I/O Read time、ResolveLibrary time、printTime time 等）。
  /^\s*[A-Za-z][\w /&-]*\s*time:\s*\d+(?:\.\d+)?\s*s\s*$/,
  // 计数行（含 Lines of Library/Definitions、* cache size）。
  /^\s*(?:Files|Lines(?: of [A-Za-z]+)?|Identifiers|Symbols|Types|Instantiations|Memory used|Memory allocs|(?:Assignability|Identity|Subtype|Strict subtype) cache size):\s*[0-9]+(?:\s*K)?\s*$/,
  // tsrs 的 Program/Checkers/Diagnostics 明细与汇总。
  /^\s*(?:Program|Checkers|Diagnostics|Emit|List files|Error summary|Statistics):\s*.+$/,
  /^\s*(?:Found|No)\s+\d+\s+errors?\b.*$/,
  /^\s*Version\s+\S+\s*$/,
  /^\s*$/,
];

/** 是否为已知的诊断辅助输出（计时、计数、tsrs 明细统计）。 */
export function isKnownAuxiliaryLine(line: string): boolean {
  return KNOWN_AUXILIARY_LINES.some((pattern) => pattern.test(line));
}

/** 文本是否只包含已知辅助输出；用于区分 clean 的空结果和无法解析的输出。 */
export function containsOnlyKnownAuxiliaryLines(text: string): boolean {
  return text.split(/\r?\n/).every(isKnownAuxiliaryLine);
}

/** 是否像 pretty 诊断输出（ANSI 颜色或 `file:line:col - error TS` 首行）。 */
export function looksLikePrettyDiagnostics(text: string): boolean {
  if (/\x1b\[[0-9;]*m/.test(text)) return true;
  return /^[^\n]+:\d+:\d+\s+-\s+(?:error|warning)\s+TS\d+:/m.test(text);
}

/** 把实现输出的路径映射为用例内相对路径；目录外返回 undefined。 */
export function caseRelativePath(root: string, file: string): string | undefined {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * 解析非 pretty 诊断文本。
 *
 * `root` 是本次用例物化的临时目录。lib / 其它环境文件位于目录之外，整体剔除，
 * 连带其续行；但 headerLines/outsideHeaders 保留，调用方据此区分「确实零诊断」
 * 与「诊断存在却无法映射」。
 */
export function parsePlainDiagnostics(root: string, text: string): ParsedPlainDiagnostics {
  const diagnostics: Diagnostic[] = [];
  const blocks: string[] = [];
  const unpositioned: UnpositionedDiagnostic[] = [];
  let current: { diagnostic: Diagnostic; lines: string[] } | null = null;
  let headerLines = 0;
  let outsideHeaders = 0;
  let syntaxError = false;

  const flush = (): void => {
    if (current === null) return;
    const fullText = current.lines.join("\n");
    current.diagnostic.fullText = fullText;
    diagnostics.push(current.diagnostic);
    blocks.push(fullText);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = PLAIN_DIAGNOSTIC.exec(line);
    if (match !== null) {
      flush();
      headerLines++;
      const rel = caseRelativePath(root, match[1]!);
      if (rel === undefined) {
        outsideHeaders++;
        continue;
      }
      const lineNumber = Number(match[2]);
      const colNumber = Number(match[3]);
      const code = Number(match[5]);
      if ((code >= 1000 && code < 2000) || code === 17006 || code === 17007) syntaxError = true;
      const message = match[6] !== undefined && match[6]!.length > 0 ? match[6]! : undefined;
      const diagnostic: Diagnostic = {
        file: rel,
        line: lineNumber - 1,
        col: colNumber - 1,
        code,
        severity: match[4] === "warning" ? "warning" : "error",
        message,
        raw: { line, file: match[1], lineNumber, colNumber, code, severity: match[4], text: message },
      };
      const firstLine = `${rel}(${lineNumber},${colNumber}): ${match[4]} TS${match[5]}:${message === undefined ? "" : ` ${message}`}`;
      current = { diagnostic, lines: [firstLine] };
      continue;
    }
    const bare = UNPOSITIONED_DIAGNOSTIC.exec(line);
    if (bare !== null) {
      flush();
      const code = Number(bare[2]);
      if ((code >= 1000 && code < 2000) || code === 17006 || code === 17007) syntaxError = true;
      const message = bare[3] !== undefined && bare[3]!.length > 0 ? bare[3]! : undefined;
      unpositioned.push({ severity: bare[1] === "warning" ? "warning" : "error", code, message, text: line });
      continue;
    }
    if (current !== null && CONTINUATION.test(line)) current.lines.push(line);
  }
  flush();
  return { diagnostics, rendered: blocks.join("\n"), headerLines, outsideHeaders, unpositioned, syntaxError };
}
