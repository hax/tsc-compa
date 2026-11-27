// Bun 内置类型检查器（`bun check`）的专用逐案适配器。
//
// Bun 1.4.x 的 `bun check` 没有 JSON/机器可读输出。非 pretty 时诊断行是
// `path(line,col): error TSxxxx: message`，但 stdout/stderr 的分配随调用环境
// （本地 native、管道/CI 包装）可能变化；这里把两路都解析成一个多重集：
// 每条诊断的出现次数保留，只有跨流重复的同一行才按多重集抵消一次。
//
// Bun 1.4.x 实测退出码为 0/1；不把它当成 tsc 的 0/1/2 三段约定，诊断以输出
// 为准，null 或 >1 视为 crash。`--ignoreConfig` 是 harness 控制项，Bun 不认识；
// 这里物化独立 tsconfig 并 `-p` 指向它，只剥离 harness/输出选项。
// `target=es2026` 在 Bun 1.4.x 被拒绝；这里显式 skip，绝不替换成 esnext。
//
// 该适配器只接受显式二进制（`bun-check:<bin>` 或 `BUN_CHECK_BIN`），避免把
// 当前 runner 的 Bun 版本误当成被评估的候选。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_STRICT_ESNEXT, materializeCase } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome, CompilerOptions, Diagnostic } from "../types.ts";
import { parsePlainDiagnostics } from "./plain-diagnostics.ts";

/** 只控制 harness/输出、不属于 tsconfig 的 CLI 选项。 */
const HARNESS_ONLY = new Set([
  "ignoreconfig", "noemit", "pretty", "extendeddiagnostics", "project",
  "no-script", "no-pretty", "all", "timing", "threads",
]);

/** tsconfig 里必须是数组的选项；CLI 用逗号连接。 */
const LIST_OPTIONS = new Set(["lib", "types", "typeroots"]);

/** 这些值在 Bun 1.4.x 被移除/拒绝；不替换，直接让用例显式 skip。 */
const REMOVED_TARGETS = new Set(["es3", "es5", "es2026"]);
const REMOVED_RESOLUTIONS = new Set(["node", "node10", "classic"]);
const REMOVED_MODULES = new Set(["amd", "umd", "system"]);

const CONFIG_ERROR = /(?:^|\n)(?:.*\/)?tsconfig\.json\(\d+,\d+\):\s+error TS(\d+):\s*([^\n]*)/;
const CLI_ERROR = /^error:\s*(.+)$/m;
/** 只有这些配置错误代码能证明是「选项不受支持」，不能把坏 JSON/程序错误也 skip。 */
const OPTION_CONFIG_CODES = new Set([5023, 5095, 5102, 5108, 6046]);
/** Bun 参数解析器对未知 flag / 非法选项值的错误。 */
const OPTION_CLI_ERROR = /^error:\s*(?:Unknown (?:flag|option)|--\S+ (?:must be|takes|does not take))/i;

/** Bun 的汇总/计时/文件计数/提示行；不能当成上一条诊断的缩进续行。 */
const SUMMARY_LINE = /^(?:Found\s+\d+\s+error|✓\s+No type errors|note:)|^\s*(?:\d+\s+files?\s+loaded|\d+\s+\S+:\d+\s*$)/i;

function withoutSummaryLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !SUMMARY_LINE.test(line))
    .join("\n");
}

function diagnosticKey(d: Diagnostic): string {
  return `${d.file}\u0000${d.line}\u0000${d.col}\u0000${d.code}\u0000${d.severity}\u0000${d.fullText ?? d.message ?? ""}`;
}

/**
 * 合并 stdout 与 stderr 的诊断流。
 *
 * 同一个流里的重复是真实的诊断重复（例如两个文件各报同一条），必须保留；
 * 只有跨流出现的同一行才视为同一个诊断被两路各打印一次，并按多重集取
 * max(count_stdout, count_stderr)，不把整段拼接后跨流去重。
 * 顺序以 stdout 为主，stderr 中 stdout 没有出现的诊断追加在后面。
 */
function mergeDiagnostics(tmp: string, stdout: string, stderr: string): Diagnostic[] {
  const fromStdout = parsePlainDiagnostics(tmp, withoutSummaryLines(stdout)).diagnostics;
  const fromStderr = parsePlainDiagnostics(tmp, withoutSummaryLines(stderr)).diagnostics;
  // 以诊断条数更多的流作为权威顺序；相等时 stdout 优先（Bun 文档口径）。
  const authoritative = fromStderr.length > fromStdout.length ? fromStderr : fromStdout;
  const secondary = authoritative === fromStderr ? fromStdout : fromStderr;
  const countOf = (diagnostics: Diagnostic[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const d of diagnostics) counts.set(diagnosticKey(d), (counts.get(diagnosticKey(d)) ?? 0) + 1);
    return counts;
  };
  const authoritativeCounts = countOf(authoritative);
  const secondaryCounts = countOf(secondary);
  const merged: Diagnostic[] = [];
  const emitted = new Map<string, number>();
  const push = (d: Diagnostic): void => {
    const key = diagnosticKey(d);
    const limit = Math.max(authoritativeCounts.get(key) ?? 0, secondaryCounts.get(key) ?? 0);
    const used = emitted.get(key) ?? 0;
    if (used >= limit) return;
    emitted.set(key, used + 1);
    merged.push(d);
  };
  // 权威流决定顺序；另一流只补它没有的诊断和额外出现次数。
  for (const d of authoritative) push(d);
  for (const d of secondary) push(d);
  return merged;
}

export interface BunCheckPlan {
  tsconfig: { compilerOptions: Record<string, unknown>; files: string[] };
  filePaths: string[];
  /** 非 null 时不对该用例启动 Bun。 */
  skipReason: string | null;
}

function valueOf(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "") return "";
  return raw;
}

/**
 * 把 tsc 风格 CLI 参数折叠成 tsconfig compilerOptions（last-wins）。
 *
 * 输入是 run.ts 已经归一化的 `CaseInput.args`：布尔项可能是裸 flag（如基线里的
 * `--noErrorTruncation`），也可能是显式 `--strict true`。这里不猜测类型语义，
 * 只按「下一个 token 不是另一个 --flag 就当作值」解析；列出数组的选项按逗号拆。
 */
export function compilerOptionsFromArgs(args: string[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    let name: string;
    let value: unknown = true;
    if (eq > 2) {
      name = arg.slice(2, eq);
      value = valueOf(arg.slice(eq + 1));
    } else {
      name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = valueOf(next);
        i++;
      }
    }
    if (name.length === 0) continue;
    if (HARNESS_ONLY.has(name.toLowerCase())) continue;
    if (LIST_OPTIONS.has(name.toLowerCase()) && typeof value === "string") {
      options[name] = value.length === 0 ? [] : value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else {
      options[name] = value;
    }
  }
  return options;
}

/** Bun 1.4.x 的已知口径差异；返回可读原因而不是静默改值。 */
function compatibilitySkip(options: Record<string, unknown>): string | null {
  if (options.declaration === true || options.emitDeclarationOnly === true || options.composite === true) {
    return "Bun check 不生成声明文件，无法比较声明生成阶段的诊断";
  }
  const target = typeof options.target === "string" ? options.target.toLowerCase() : undefined;
  if (target !== undefined && REMOVED_TARGETS.has(target)) {
    return `Bun 1.4.x 不支持 target=${target}（不替换为 esnext）`;
  }
  const resolution = typeof options.moduleResolution === "string" ? options.moduleResolution.toLowerCase() : undefined;
  if (resolution !== undefined && REMOVED_RESOLUTIONS.has(resolution)) {
    return `Bun 1.4.x 不支持 moduleResolution=${resolution}（不替换为 bundler）`;
  }
  const moduleKind = typeof options.module === "string" ? options.module.toLowerCase() : undefined;
  if (moduleKind !== undefined && REMOVED_MODULES.has(moduleKind)) {
    return `Bun 1.4.x 不支持 module=${moduleKind}`;
  }
  if (Object.hasOwn(options, "baseUrl")) return "Bun 1.4.x 不支持 baseUrl";
  if (options.downlevelIteration === true) return "Bun 1.4.x 不支持 downlevelIteration=true";
  if (options.esModuleInterop === false) return "Bun 1.4.x 不支持 esModuleInterop=false";
  if (options.alwaysStrict === false) return "Bun 1.4.x 不支持 alwaysStrict=false";
  return null;
}

/** 生成一次用例的 tsconfig 与 Bun 调用计划；供 adapter 与单测共用。 */
export function planBunCheck(input: CaseInput, extraArgs: string[] = []): BunCheckPlan {
  // extraArgs（registry 的固定参数）在前，用例选项在后：last-wins 与 CLI 一致。
  const options = compilerOptionsFromArgs([...extraArgs, ...input.args]);
  const skipReason = compatibilitySkip(options);
  const filePaths = input.files.map((f) => f.path);
  return {
    tsconfig: { compilerOptions: options, files: filePaths },
    filePaths,
    skipReason,
  };
}

function renderedOf(diagnostics: Diagnostic[]): string {
  return diagnostics.map((d) => d.fullText ?? `${d.file}(${d.line + 1},${d.col + 1}): ${d.severity} TS${d.code}: ${d.message ?? ""}`).join("\n");
}

function checkMsOf(text: string): number | undefined {
  const m = /checked in\s+([\d.]+)ms/i.exec(text);
  return m === null ? undefined : Number(m[1]);
}

export interface BunCheckAdapterOptions {
  name?: string;
  /** 固定版本的 Bun 可执行文件。 */
  bin: string;
  /** registry 的固定 CLI 参数（如并行度）；放在用例选项之前。 */
  extraArgs?: string[];
  timeoutMs?: number;
}

export class BunCheckAdapter implements Adapter {
  readonly name: string;
  readonly kind = "per-case" as const;
  /** 接受用例选项：写入独立 tsconfig，而不是忽略 directive。 */
  readonly supportsOptions = true;
  readonly fixedOptions: CompilerOptions = FIXED_STRICT_ESNEXT;
  private readonly bin: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;

  constructor(options: BunCheckAdapterOptions) {
    this.name = options.name ?? "bun-check";
    this.bin = options.bin;
    this.extraArgs = options.extraArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    const plan = planBunCheck(input, this.extraArgs);
    if (plan.skipReason !== null) {
      // 没启动进程：fullText/exitCode/rawOutput 都保持「未采集」，不伪造空输出。
      return {
        id: input.id,
        status: "skip",
        diagnostics: [],
        skipReason: plan.skipReason,
      };
    }

    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-bun-"));
    try {
      materializeCase(tmp, input.files);
      writeFileSync(join(tmp, "tsconfig.json"), `${JSON.stringify(plan.tsconfig, null, 2)}\n`);

      const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
      delete env.FORCE_COLOR;
      const r = spawnSync(
        this.bin,
        ["check", "--no-script", "--no-pretty", "--all", "--timing", "-p", "tsconfig.json", ...plan.filePaths],
        { cwd: tmp, encoding: "utf8", maxBuffer: 1 << 28, timeout: this.timeoutMs, env },
      );
      const stdout = r.stdout ?? "";
      const stderr = r.stderr ?? "";
      const rawOutput = { stdout, stderr };
      const exitCode = r.error === undefined ? r.status : null;
      const fail = (status: "skip" | "crash" | "timeout", skipReason: string, message?: string): CaseOutcome => ({
        id: input.id,
        status,
        diagnostics: [],
        skipReason,
        message,
        exitCode,
        rawOutput,
      });
      if (r.error !== undefined) {
        const timeout = /ETIMEDOUT|timed out/i.test(String(r.error));
        return fail(timeout ? "timeout" : "crash", timeout ? "Bun check 超时（30s）" : "Bun check 崩溃", String(r.error));
      }

      // 同一个流内的重复诊断是真实重复，保留；只有跨流重复按多重集抵消。
      const merged = mergeDiagnostics(tmp, stdout, stderr);
      const known = new Set(input.files.map((f) => f.path));
      const diagnostics = merged.filter((d) => known.has(d.file));

      const text = `${stdout}\n${stderr}`;
      // 只有「可证明的选项/配置不受支持」才 skip；运行失败或输出不可解析是 crash，
      // 否则门禁会把漏掉的执行错误当成正常静默。
      const config = CONFIG_ERROR.exec(text);
      if (config !== null) {
        const code = Number(config[1]);
        return OPTION_CONFIG_CODES.has(code)
          ? fail("skip", `Bun 配置不兼容（TS${code}）：${config[2]!.trim()}`, text.slice(0, 500))
          : fail("crash", `Bun 配置输出无法处理（TS${code}）：${config[2]!.trim()}`, text.slice(0, 500));
      }
      if (r.status === null) {
        return fail("crash", "Bun check 未正常退出", text.slice(0, 300));
      }
      if (r.status > 1) {
        return fail("crash", `Bun check 异常退出（status=${r.status}）`, text.slice(0, 300));
      }
      if (diagnostics.length === 0) {
        const hasUnmapped = parsePlainDiagnostics(tmp, withoutSummaryLines(text)).headerLines > 0;
        if (hasUnmapped) {
          return fail("crash", "Bun 诊断无法映射到用例文件", text.slice(0, 300));
        }
        if (r.status === 1) {
          const cli = CLI_ERROR.exec(stderr) ?? CLI_ERROR.exec(stdout);
          const message = cli?.[1]?.trim() ?? "Bun check 报告错误但没有可解析诊断";
          return OPTION_CLI_ERROR.test(cli?.[0] ?? "")
            ? fail("skip", `Bun check 拒绝不支持的选项：${message}`, text.slice(0, 300))
            : fail("crash", message, text.slice(0, 300));
        }
      }

      return {
        id: input.id,
        status: "ok",
        diagnostics,
        fullText: renderedOf(diagnostics),
        exitCode,
        rawOutput,
        checkMs: checkMsOf(text),
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
