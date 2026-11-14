// tsc 期望的诊断：调用指定版本的 tsc CLI，按用例口径生成期望并缓存。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { materializeCase } from "./case.ts";
import type { CaseFile, CompilerOptions, Diagnostic } from "./types.ts";

export interface ExpectationResult {
  status: "ok" | "syntax" | "crash" | "timeout";
  diagnostics: Diagnostic[];
  message?: string;
}

export interface ExpectationOptions {
  tscBin: string;
  tscVersion: string;
  args: string[];
  cacheDir: string;
  timeoutMs?: number;
}

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
  const r = spawnSync(tscBin, ["--version"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const m = /(?:Version|version)\s+(\S+)/.exec(out);
  if (m === null) throw new Error(`无法解析 tsc 版本：${out}`);
  return m[1]!;
}

const CLI_DIAG = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s?(.*)$/;

function cacheKeyOf(files: CaseFile[], args: string[], tscVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ files, args, tscVersion }))
    .digest("hex");
}

function readCache(path: string): ExpectationResult | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ExpectationResult;
  } catch {
    return null;
  }
}

/**
 * 生成（或从缓存读）一个用例的期望诊断。
 *
 * 口径：--noEmit + 用例指令推导出的选项；没有指令外加重钉。诊断按
 * 「文件 + 行 + 列 + 码」记录，宽度 tsc CLI 不提供。语法错误（TS1xxx 与
 * 17006/17007）整体归 syntax，因为此后 tsc 不再产出可比的语义诊断。
 */
export function expectationOf(
  id: string,
  files: CaseFile[],
  options: CompilerOptions,
  expect: ExpectationOptions,
): ExpectationResult {
  const key = cacheKeyOf(files, expect.args, expect.tscVersion);
  const cachePath = join(expect.cacheDir, `${key}.json`);
  const cached = readCache(cachePath);
  if (cached !== null) return cached;

  const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-expect-"));
  const paths = materializeCase(tmp, files);
  let result: ExpectationResult;
  try {
    const r = spawnSync(expect.tscBin, [...expect.args, ...paths], {
      cwd: tmp,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: expect.timeoutMs ?? 30_000,
    });
    if (r.error !== undefined) {
      const timeout = /ETIMEDOUT|timed out/i.test(String(r.error));
      // 崩溃/超时不落缓存：临时故障不能被持久成 SKIP。
      return { status: timeout ? "timeout" : "crash", diagnostics: [], message: String(r.error) };
    }
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const diagnostics: Diagnostic[] = [];
    let syntax = false;
    for (const line of text.split(/\r?\n/)) {
      const m = CLI_DIAG.exec(line);
      if (m === null) continue;
      const abs = resolve(tmp, m[1]!);
      const rel = abs.startsWith(`${tmp}/`) ? abs.slice(tmp.length + 1) : null;
      if (rel === null) continue; // lib 与其它环境文件不计
      const code = Number(m[5]);
      if ((code >= 1000 && code < 2000) || code === 17006 || code === 17007) syntax = true;
      diagnostics.push({
        file: rel,
        line: Number(m[2]) - 1,
        col: Number(m[3]) - 1,
        code,
        severity: m[4] === "warning" ? "warning" : "error",
        message: m[6] ?? undefined,
      });
    }
    diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.code - b.code);
    result = syntax
      ? { status: "syntax", diagnostics: [] }
      : { status: "ok", diagnostics };
  } catch (e) {
    result = { status: "crash", diagnostics: [], message: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  mkdirSync(expect.cacheDir, { recursive: true });
  const tmpPath = join(expect.cacheDir, `${key}.${process.pid}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(result));
  renameSync(tmpPath, cachePath);
  return result;
}

/** 给日志用：用例名取语料内相对路径的最后两段。 */
export function shortCaseName(id: string): string {
  const parts = id.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : basename(id);
}
