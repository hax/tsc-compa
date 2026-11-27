// tsc 期望的诊断：调用指定版本的 tsc CLI，按用例口径生成期望并缓存。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { materializeCase } from "./case.ts";
import { containsOnlyKnownAuxiliaryLines, looksLikePrettyDiagnostics, parsePlainDiagnostics, rejectsCompilerOptions, unsupportedCliDiagnostics } from "./adapters/plain-diagnostics.ts";
import type { CaseFile, CompilerOptions, Diagnostic } from "./types.ts";

export interface ExpectationResult {
  status: "ok" | "syntax" | "unsupported" | "crash" | "timeout";
  diagnostics: Diagnostic[];
  message?: string;
  /** 与 diagnostics 同一原始顺序的诊断副本（严格比较用）。 */
  original?: Diagnostic[];
  /** 参考实现输出中的完整诊断摘要流；空串 = 明确无诊断。 */
  fullText?: string;
  /** 参考进程原始退出码；null = 无退出码/未采集。 */
  exitCode?: number | null;
  /** 参考原始 stdout/stderr，供采集问题归因，不参与比较。 */
  rawOutput?: { stdout?: string; stderr?: string };
  /** 参考端解析出的诊断原始对象，仅供采集归因。 */
  rawDiagnostics?: unknown[];
}

export interface ExpectationOptions {
  tscBin: string;
  tscVersion: string;
  args: string[];
  cacheDir: string;
  timeoutMs?: number;
  /** 参考编译器二进制的稳定身份（例如 sha256）；runner 填。 */
  compilerIdentity?: string;
}

/** 缓存布局/解析管线版本：不兼容时自动改用新键，旧结果不会被读回。 */
export const EXPECTATION_SCHEMA_VERSION = 2;
export const EXPECTATION_PIPELINE = "plain-diagnostics-v1";

/** 解析 tsc 可执行文件：显式参数 → TSC_BIN 环境变量 → PATH 上的 tsc。 */
export function resolveTscPath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return absIfPath(explicit);
  const env = process.env.TSC_BIN;
  if (env !== undefined && env.length > 0) return absIfPath(env);
  const probe = spawnSync("tsc", ["--version"], { encoding: "utf8" });
  if (probe.error === undefined && probe.status === 0) return "tsc";
  throw new Error("找不到 tsc：请用 --tsc 或环境变量 TSC_BIN 指定一个 tsc 可执行文件");
}

/**
 * 带路径分隔符的可执行文件转绝对路径。子进程以临时目录为 cwd 运行，
 * 相对路径会解析错位置；纯命令名（走 PATH）保持原样。
 */
export function absIfPath(bin: string): string {
  return bin.includes("/") ? resolve(bin) : bin;
}

export function tscVersionOf(tscBin: string): string {
  const r = spawnSync(tscBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const m = /(?:Version|version)\s+(\S+)/.exec(out);
  if (r.status !== 0 || m === null) throw new Error(`无法获取 tsc 版本：${out || r.error || r.status}`);
  return m[1]!;
}

function cacheKeyOf(files: CaseFile[], args: string[], tscVersion: string, compilerIdentity?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: EXPECTATION_SCHEMA_VERSION,
      pipeline: EXPECTATION_PIPELINE,
      files,
      args,
      tscVersion,
      compilerIdentity: compilerIdentity ?? null,
    }))
    .digest("hex");
}

interface CachedExpectation extends ExpectationResult {
  schemaVersion?: number;
  pipeline?: string;
}

function readCache(path: string): ExpectationResult | null {
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as CachedExpectation;
    // 旧缓存没有版本标记，或来自旧解析管线时不采用。
    if (cached.schemaVersion !== EXPECTATION_SCHEMA_VERSION || cached.pipeline !== EXPECTATION_PIPELINE) return null;
    if (cached.status !== "ok" && cached.status !== "syntax") return null;
    return { ...cached, original: cached.original ?? cached.diagnostics.slice() };
  } catch {
    return null;
  }
}

/**
 * 生成（或从缓存读）一个用例的期望诊断。
 *
 * 口径：--noEmit + 用例指令推导出的选项；没有指令外加重钉。诊断按
 * 「文件 + 行 + 列 + 码」记录，宽度 tsc CLI 不提供。语法错误（TS1xxx 与
 * 17006/17007）仍保留完整原始诊断，但 status 归 syntax，因为此后 tsc 不再产出
 * 可比的语义诊断；不能把语法错误错误地记为“零诊断”。
 */
export function expectationOf(
  id: string,
  files: CaseFile[],
  options: CompilerOptions,
  expect: ExpectationOptions,
): ExpectationResult {
  const key = cacheKeyOf(files, expect.args, expect.tscVersion, expect.compilerIdentity);
  const cachePath = join(expect.cacheDir, `${key}.json`);
  const cached = readCache(cachePath);
  if (cached !== null) return cached;

  const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-expect-"));
  let result: ExpectationResult;
  try {
    const paths = materializeCase(tmp, files);
    const r = spawnSync(expect.tscBin, [...expect.args, ...paths], {
      cwd: tmp,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: expect.timeoutMs ?? 30_000,
    });
    if (r.error !== undefined) {
      const timeout = /ETIMEDOUT|timed out/i.test(String(r.error));
      // 崩溃/超时不落缓存：临时故障不能被持久成 SKIP。
      return { status: timeout ? "timeout" : "crash", diagnostics: [], message: String(r.error),
        exitCode: null, rawOutput: { stdout: r.stdout ?? "", stderr: r.stderr ?? "" } };
    }
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const rawOutput = { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    const parsed = parsePlainDiagnostics(tmp, text);
    const rawDiagnostics = parsed.diagnostics.map((d) => d.raw);
    const rejectedOptions = rejectsCompilerOptions(r.status, parsed);
    const unsupported = unsupportedCliDiagnostics(r.status, parsed, text);
    // pretty 诊断包含源码标注/ANSI，不能可靠恢复 UTF-16 位置和顺序；明确标为不支持。
    if (parsed.headerLines === 0 && parsed.diagnostics.length === 0 && looksLikePrettyDiagnostics(text)) {
      result = {
        status: r.status !== null && r.status <= 2 ? "unsupported" : "crash",
        diagnostics: [],
        fullText: parsed.rendered,
        exitCode: r.status,
        rawOutput,
        rawDiagnostics,
        message: "参考输出为 pretty 诊断（暂不支持可靠解析）",
      };
    } else if (parsed.unpositioned.length > 0) {
      // 明确不受支持的配置单独记录；未识别的无位置错误不能被隐藏成跳过。
      result = {
        status: rejectedOptions ? "unsupported" : "crash",
        diagnostics: [],
        fullText: parsed.rendered,
        exitCode: r.status,
        rawOutput,
        rawDiagnostics,
        message: `参考输出含无文件位置的诊断（无法比较）：${parsed.unpositioned.map((d) => d.text).join("\n").slice(0, 500)}`,
      };
    } else if (unsupported !== null) {
      result = { status: "unsupported", diagnostics: parsed.diagnostics, message: unsupported, exitCode: r.status, rawOutput, rawDiagnostics };
    } else if (parsed.diagnostics.length === 0 && (r.status === null || r.status !== 0)) {
      result = {
        status: "crash",
        diagnostics: [],
        fullText: parsed.rendered,
        exitCode: r.status,
        rawOutput,
        rawDiagnostics,
        message: `参考退出 status=${r.status} 但没有可比较诊断：${text.slice(0, 300)}`,
      };
    } else if (parsed.diagnostics.length === 0 && !containsOnlyKnownAuxiliaryLines(text) && text.trim().length > 0) {
      result = {
        status: "crash",
        diagnostics: [],
        fullText: parsed.rendered,
        exitCode: r.status,
        rawOutput,
        rawDiagnostics,
        message: `参考输出无法解析为诊断：${text.slice(0, 500)}`,
      };
    } else if (r.status === null || r.status > 2) {
      result = {
        status: "crash",
        diagnostics: [],
        fullText: parsed.rendered,
        exitCode: r.status,
        rawOutput,
        rawDiagnostics,
        message: `参考异常退出（status=${r.status}）：${text.slice(0, 300)}`,
      };
    } else {
      // 诊断数组保持参考输出原始顺序：严格一致的「诊断集合与顺序」要靠它。
      result = parsed.syntaxError
        ? {
            status: "syntax",
            // 原始全诊断保留在记录中；status=syntax 只表示该案不进入语义比较。
            diagnostics: parsed.diagnostics,
            original: parsed.diagnostics.slice(),
            fullText: parsed.rendered,
            exitCode: r.status,
            rawOutput,
            rawDiagnostics,
          }
        : {
            status: "ok",
            diagnostics: parsed.diagnostics,
            original: parsed.diagnostics.slice(),
            fullText: parsed.rendered,
            exitCode: r.status,
            rawOutput,
            rawDiagnostics,
          };
    }
  } catch (e) {
    result = { status: "crash", diagnostics: [], message: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (result.status !== "ok" && result.status !== "syntax") return result;
  mkdirSync(expect.cacheDir, { recursive: true });
  const stored: CachedExpectation = { ...result, schemaVersion: EXPECTATION_SCHEMA_VERSION, pipeline: EXPECTATION_PIPELINE };
  const tmpPath = join(expect.cacheDir, `${key}.${process.pid}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(stored));
  renameSync(tmpPath, cachePath);
  return result;
}

/** 给日志用：用例名取语料内相对路径的最后两段。 */
export function shortCaseName(id: string): string {
  const parts = id.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : basename(id);
}
