// 参考实现适配器：直接用真实 tsc 命令行跑用例。
//
// 用途：验证 harness 自身正确性——期望源与适配器用同一个 tsc 时，指标应当
// 接近「覆盖 100%、假阳性 0、错锚 0」。它也是「任意 TSC 兼容实现」协议的一个
// 活样例：适配器只负责把实现的输出翻译成 Diagnostic[]。
//
// 与 tsc.ts 生成期望的路径保持同一解析规则（同一条 CLI_DIAG 正则、同样按
// cwd 解析相对路径、同样忽略临时目录外的 lib 诊断），否则自比会出现假差异。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compilerOptionsFromArgs } from "./bun-check.ts";
import { materializeCase } from "../case.ts";
import { parseExtendedDiagnostics } from "../perf.ts";
import type { Adapter, CaseInput, CaseOutcome, Diagnostic } from "../types.ts";
import { containsOnlyKnownAuxiliaryLines, looksLikePrettyDiagnostics, parsePlainDiagnostics, rejectsCompilerOptions, unsupportedCliDiagnostics } from "./plain-diagnostics.ts";

export interface ParsedTscOutput {
  diagnostics: Diagnostic[];
  /**
   * 完整诊断摘要流（与官方 `.errors.txt` 摘要区同口径）：每条诊断的首行 + 其
   * 缩进续行，按实现输出顺序拼接；临时目录之外的文件（lib 等）整体剔除，连带
   * 其续行。空串 = 已成功输出且无诊断。
   */
  rendered: string;
  /** 识别到的诊断首行数（含被剔除的 lib 诊断）。 */
  headerLines: number;
  /** 诊断存在但路径不在临时目录内、被剔除的数量。 */
  outsideHeaders: number;
  /** 没有文件位置的 TS 诊断。 */
  unpositioned: { severity: "error" | "warning"; code: number; message?: string; text: string }[];
  /** 是否含 TS1xxx / TS17006 / TS17007。 */
  syntaxError: boolean;
}

/**
 * 解析 tsc `--pretty false` 输出，同时保留多行阐述与顺序。
 *
 * 首行用「用例内相对路径 + 行列 + 码 + message」重建（实现可能打印临时目录的
 * 绝对路径，不能原样进基线比对）；续行原样保留缩进。临时目录之外的文件（lib
 * 等）不计，其续行一并丢弃。行列按 UTF-16 code unit 从 1-based 转 0-based。
 */
export function parseTscOutputDetailed(tmp: string, text: string): ParsedTscOutput {
  const parsed = parsePlainDiagnostics(tmp, text);
  return {
    diagnostics: parsed.diagnostics,
    rendered: parsed.rendered,
    headerLines: parsed.headerLines,
    outsideHeaders: parsed.outsideHeaders,
    unpositioned: parsed.unpositioned,
    syntaxError: parsed.syntaxError,
  };
}

/** 解析 tsc `--pretty false` 输出；临时目录之外的文件（lib 等）不计。 */
export function parseTscOutput(tmp: string, text: string): Diagnostic[] {
  return parseTscOutputDetailed(tmp, text).diagnostics;
}

export interface TscCliAdapterOptions {
  name?: string;
  /** tsc 可执行文件路径。 */
  bin: string;
  /**
   * 放在用例参数之前的默认参数（case 指令仍可覆盖）。用于跨版本对照时
   * 对齐版本默认值（例如 6.0/7.1 默认 strict=true、5.9 默认 false，加
   * --strict false；默认 target 也从 ES5 变成 ES2015，可加 --target es5）。
   */
  extraArgs?: string[];
  timeoutMs?: number;
  /** Explicit project invocation for releases with a restricted direct CLI. */
  project?: boolean;
}

export class TscCliAdapter implements Adapter {
  readonly name: string;
  readonly kind = "per-case" as const;
  /** tsc 接受任意编译选项，因此 official 模式下的结果是可比的。 */
  readonly supportsOptions = true;
  private readonly bin: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;
  private readonly project: boolean;

  constructor(options: TscCliAdapterOptions) {
    this.name = options.name ?? "tsc-cli";
    this.bin = options.bin;
    // 适配器侧不再继承期望基线的 baseArgs（跨版本时必须用实现自己的默认值），
    // 因此这里自带解析输出所必需的两个参数：不 emit、pretty false。
    // --extendedDiagnostics 让参考实现自报 Parse/Bind/Check 相位；诊断解析会忽略
    // 这些统计行，性能附录则用它拿 Check 时间（缺失时退 wall 口径）。
    this.extraArgs = ["--noEmit", "--pretty", "false", "--extendedDiagnostics", ...(options.extraArgs ?? [])];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.project = options.project === true;
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-tsc-"));
    try {
      const paths = materializeCase(tmp, input.files);
      // extraArgs 放在用例参数之前：它们只提供「版本默认值」，case 指令优先。
      let invocation = [...this.extraArgs, ...input.args, ...paths];
      let generatedConfig: string | undefined;
      if (this.project) {
        // The v0.1.0 direct CLI does not expose the full compiler option
        // catalog or timing switch. Keep effective option values in an
        // explicit project; never substitute another target for ES2026.
        const compilerOptions = { ...compilerOptionsFromArgs(input.args), noEmit: true };
        const config = join(mkdtempSync(join(tmp, "tsc-compa-project-")), "tsconfig.json");
        writeFileSync(config, JSON.stringify({ compilerOptions, files: paths.map((path) => relative(join(config, ".."), path)) }));
        generatedConfig = relative(tmp, config);
        invocation = ["--noEmit", "--pretty", "false", ...this.extraArgs.slice(4), "-p", config];
      }
      const r = spawnSync(this.bin, invocation, {
        cwd: tmp,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: this.timeoutMs,
      });
      if (r.error !== undefined) {
        const timeout = /ETIMEDOUT|timed out/i.test(String(r.error));
        return {
          id: input.id,
          status: timeout ? "timeout" : "crash",
          diagnostics: [],
          skipReason: timeout ? "实现超时（30s）" : "实现崩溃",
          message: String(r.error),
          exitCode: r.status,
          rawOutput: { stdout: r.stdout ?? "", stderr: r.stderr ?? "" },
        };
      }
      // tsc/tsrs 的退出码 0/1/2 都表示进程正常完成（1 常见于 noEmit + 诊断）；
      // 3 及以上是 InvalidProject / NotImplemented 一类命令失败，不能当零诊断。
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      // 退出码 3+ 是 InvalidProject/NotImplemented/ProjectReferenceCycle 一类
      // 命令失败；不是可比较诊断，也不能落成零诊断。
      if (r.status === null || r.status > 2) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: `实现异常退出（status=${r.status}）`,
          message: text.slice(0, 200),
          exitCode: r.status,
          rawOutput: { stdout: r.stdout ?? "", stderr: r.stderr ?? "" },
        };
      }
      const parsed = parseTscOutputDetailed(tmp, text);
      const rawOutput = { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      const exitCode = r.status;

      // pretty 诊断带有源码标注/ANSI，当前不能可靠恢复 UTF-16 位置、续行和顺序；
      // 明确报告 unsupported，绝不把非空的 pretty 输出当成零诊断。
      if (parsed.headerLines === 0 && parsed.diagnostics.length === 0 && looksLikePrettyDiagnostics(text)) {
        return {
          id: input.id,
          status: "skip",
          diagnostics: [],
          skipReason: "实现输出为 pretty 诊断（暂不支持可靠解析）",
          message: text.slice(0, 500),
          exitCode,
          rawOutput,
        };
      }

      if (generatedConfig && parsed.diagnostics.some((d) => d.file === generatedConfig)) {
        const rejectedOptions = parsed.headerLines === parsed.diagnostics.length && parsed.unpositioned.length === 0 &&
          parsed.diagnostics.every((d) => d.file === generatedConfig) && rejectsCompilerOptions(exitCode, {
            ...parsed, headerLines: 0, unpositioned: parsed.diagnostics.map((d) => ({ severity: "error", code: d.code, text: "" })),
          });
        return { id: input.id, status: rejectedOptions ? "skip" : "crash", diagnostics: [],
          skipReason: rejectedOptions ? "候选拒绝生成的 tsconfig 编译选项" : "候选未能读取或执行生成的 tsconfig", exitCode, rawOutput };
      }

      // 只有明确拒绝该配置时把无位置诊断记成 skip；命令失败仍要阻断。
      if (parsed.unpositioned.length > 0) {
        return {
          id: input.id,
          status: rejectsCompilerOptions(exitCode, parsed) ? "skip" : "crash",
          diagnostics: [],
          skipReason: "实现输出含无文件位置的诊断",
          message: parsed.unpositioned.map((d) => d.text).join("\n").slice(0, 500),
          exitCode,
          rawOutput,
        };
      }

      const unsupported = unsupportedCliDiagnostics(exitCode, parsed, text);
      if (unsupported !== null) {
        return { id: input.id, status: "skip", diagnostics: parsed.diagnostics, skipReason: unsupported, exitCode, rawOutput };
      }

      // 非零退出却没有可比较诊断：这是采集/命令失败，不是零诊断。
      if (parsed.diagnostics.length === 0 && (exitCode === null || exitCode !== 0)) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: `实现退出状态 ${exitCode} 且没有可比较诊断`,
          message: text.slice(0, 500),
          exitCode,
          rawOutput,
        };
      }

      // 正常退出且没有诊断时，`--extendedDiagnostics` 的计数/相位/明细统计
      // 是已知辅助输出，绝不能因此判成解析失败。只有无法解释的残留文本才按
      // 采集失败处理；fullText 只包含诊断摘要，不含这些统计。
      const explained = parsed.headerLines > 0 || parsed.outsideHeaders > 0 ||
        parsed.unpositioned.length > 0 || containsOnlyKnownAuxiliaryLines(text);
      if (parsed.diagnostics.length === 0 && !explained && text.trim().length > 0) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: "实现输出无法解析为诊断",
          message: text.slice(0, 500),
          exitCode,
          rawOutput,
        };
      }
      return {
        id: input.id,
        status: "ok",
        diagnostics: parsed.diagnostics,
        fullText: parsed.rendered,
        exitCode,
        checkMs: parseExtendedDiagnostics(text)?.checkMs,
        rawOutput,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
