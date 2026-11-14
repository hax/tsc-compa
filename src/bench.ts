// 逐案计时演示（--bench 的次要路径）：把「正确性验证」与「性能计量」分开。
// 真实项目上的头条口径（Check 相位）见 bench-project.ts；本文件只做逐案管线演示。
//
// 验证跑大量使用缓存来加速（期望缓存、进程复用、JIT 预热），这些缓存对性能
// 测量有决定性影响；因此本模块在计时前先把期望生成（可能 spawn tsc）与用例
// 读取全部做完，计时区只包含「检查器执行」与必要的进程启停。
//
// 头条指标是 check-only（lib 建好之后的纯检查时间），不是进程总时间：
// - 同一执行模式跑两次：「空程序基线」（`export {};`，无诊断）与「语料」；
// - check-only ≈ 语料合计 − 轮数 × 空程序基线；进程启动、lib 解析等固定
//   开销由空程序基线代表并单独展示，不与检查时间混成一个数；
// - 若适配器在结果里自报 checkMs（协议可选字段），直接采用自报值，并单列；
// - cold（每案新建适配器/进程）与 warm（整个 case 集复用、lib 已建好）分开
//   报告，跨实现比较只在同一执行模式 + 同一缓存档位下进行；
// - 诊断条数与「是否渲染 message」写进 meta：报错多导致慢必须能分离。
//
// 输出 <out>/bench.json（meta + 每实现汇总 + 每案逐轮原始毫秒）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapter } from "./adapters/index.ts";
import { toTscArgs } from "./case.ts";
import type { ParsedCase } from "./case.ts";
import { readCase } from "./discover.ts";
import { expectationFromOfficialBaseline } from "./officialBaseline.ts";
import { expectationOf } from "./tsc.ts";
import type { Adapter, CaseInput, CompilerOptions } from "./types.ts";

export interface BenchOptions {
  /** 语料根（tests/cases 的绝对/相对路径）。 */
  corpus: string;
  /** 用例 id 列表（相对语料根）。 */
  caseIds: string[];
  /** 一个或多个适配器 spec（见 adapters/index.ts）。 */
  adapterSpecs: string[];
  mode: "official" | "fixed";
  /** 每案重复轮数（>=1）。 */
  reps: number;
  /** true = 每案新建适配器；false = 整个 case 集复用。 */
  cold: boolean;
  /** 期望侧基础参数（case 指令之上的 tsc 参数）。 */
  expectationArgs: string[];
  tscBin: string;
  tscVersion: string;
  expectationSource: "tsc" | "official-baseline";
  /** 跳过期望预生成（测试用；不产出 coverageProxy）。 */
  skipExpectations?: boolean;
  baseline?: string;
  corpusRef?: string;
  outDir: string;
}

interface BenchCase {
  index: number;
  id: string;
  parsed: ParsedCase;
  lines: number;
  /** 非 null 时该用例不参与计时。 */
  skip: string | null;
  expectedCount: number | null;
}

interface Sample {
  rep: number;
  /** adapter.check 的耗时（不含 cold 模式下适配器创建/关闭）。 */
  ms: number;
  /** 实现自报的检查时间（协议可选字段），没有则 undefined。 */
  checkMs?: number;
  diag: number;
  status: string;
}

interface CaseTiming {
  id: string;
  lines: number;
  skip: string | null;
  expected: number | null;
  samples: Sample[];
}

export interface BenchAdapterResult {
  spec: string;
  name: string;
  kind: Adapter["kind"];
  supportsOptions: boolean;
  cache: "cold" | "warm";
  reps: number;
  /** 计时区内每轮的挂钟（含适配器内部循环开销）。 */
  passWallMs: number[];
  /** 每案 check 毫秒合计（所有轮相加，不含 cold 模式的创建/关闭）。 */
  checkSumMs: number;
  /** 每轮平均的检查毫秒。 */
  perRepMeanMs: number;
  /** 每案 check 毫秒中位数（先按案取轮中位，再取所有案中位）。 */
  perCaseMedianMs: number;
  /** 空程序基线（单次运行的中位毫秒）：进程启动 + lib 解析 + 空检查。 */
  emptyBaselineMs: number;
  emptyBaselineRuns: number[];
  /** check-only = checkSum − reps × emptyBaseline，下限 0。 */
  checkOnlyTotalMs: number;
  checkOnlyPerCaseMs: number;
  checkOnlyUsPerLine: number;
  /** 总毫秒（cold 模式下含适配器创建/关闭的固定开销）。 */
  totalWallMs: number;
  /** 适配器创建/初始化开销：cold 为每案中位，warm 为一次性。 */
  adapterInitMs: number;
  adapterInitKind: "per-case" | "one-time";
  usPerLine: number;
  cpuMs: number;
  diagTotal: number;
  expectedTotal: number | null;
  coverageProxy: number | null;
  /** 全部样本都自报 checkMs 时，给出自报合计；否则 null。 */
  selfReportedCheckMs: number | null;
  cases: CaseTiming[];
}

export interface BenchReport {
  meta: {
    suite: "bench";
    schema: 2;
    corpus: string;
    baseline?: string;
    corpusRef?: string;
    tscVersion: string;
    tscBin: string;
    mode: "official" | "fixed";
    expectationSource: "tsc" | "official-baseline";
    generatedAt: string;
    reps: number;
    cache: "cold" | "warm";
    /** check-only 的定义，写进结果方便跨实现对齐。 */
    headlineMetric: "check-only (corpus − empty-program baseline)";
    baselineProgram: "export {};（无诊断空程序）";
    messageRendering: "adapter-default";
    caseOrderRotation: "alternating-forward-reverse";
    parallel: 1;
    workerRecycle: null;
    casesSelected: number;
    casesTimed: number;
    casesSkipped: number;
    totalLines: number;
    harnessOverheadMs: number;
    noopPerCaseMs: number;
  };
  adapters: BenchAdapterResult[];
  skips: [string, number][];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 单个用例的代码行数（按虚拟文件文本行数求和；末尾换行不额外计一行）。 */
export function linesOfCase(parsed: ParsedCase): number {
  let total = 0;
  for (const file of parsed.files) {
    if (file.text.length === 0) continue;
    const parts = file.text.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    total += parts.length;
  }
  return total;
}

/** 轮间交替正反序：减少「同一后缀缓存」「文件顺序」带来的系统性偏置。 */
export function orderedIndices(count: number, rep: number): number[] {
  const forward = Array.from({ length: count }, (_, i) => i);
  return rep % 2 === 0 ? forward : forward.reverse();
}

/** 空程序基线：无诊断、无 import，lib 解析之外的检查工作量可忽略。 */
export const EMPTY_PROGRAM_SOURCE = "export {};\n";
export const EMPTY_PROGRAM_ID = "__bench_empty__";

function emptyCaseInput(adapter: Adapter, mode: "official" | "fixed"): CaseInput {
  const options: CompilerOptions = mode === "fixed" ? adapter.fixedOptions! : [];
  return {
    id: EMPTY_PROGRAM_ID,
    files: [{ path: "empty.ts", text: EMPTY_PROGRAM_SOURCE }],
    options,
    args: toTscArgs(options, []),
  };
}

function prepareCases(opts: BenchOptions): BenchCase[] {
  const out: BenchCase[] = [];
  for (let i = 0; i < opts.caseIds.length; i++) {
    const id = opts.caseIds[i]!;
    const parsed = readCase(opts.corpus, id);
    const lines = linesOfCase(parsed);
    let skip: string | null = parsed.skip;
    if (skip === null && parsed.unknown.length > 0) skip = `未知指令 ${parsed.unknown[0]}`;
    let expectedCount: number | null = null;
    if (skip === null && opts.skipExpectations !== true) {
      if (opts.expectationSource === "official-baseline") {
        const official = expectationFromOfficialBaseline(opts.corpus, id, parsed);
        if (official.status === "skip") skip = `官方基线:${official.reason}`;
        else expectedCount = official.diagnostics.length;
      } else {
        const expectation = expectationOf(id, parsed.files, parsed.options, {
          tscBin: opts.tscBin,
          tscVersion: opts.tscVersion,
          args: toTscArgs(parsed.options, opts.expectationArgs),
          cacheDir: join(".cache", "expectations"),
        });
        if (expectation.status !== "ok") skip = `期望不可用:${expectation.status}`;
        else expectedCount = expectation.diagnostics.length;
      }
    }
    out.push({ index: i, id, parsed, lines, skip, expectedCount });
  }
  return out;
}

function inputFor(adapter: Adapter, caseData: BenchCase, opts: BenchOptions): CaseInput {
  const options: CompilerOptions =
    opts.mode === "fixed" ? adapter.fixedOptions! : caseData.parsed.options;
  return {
    id: caseData.id,
    files: caseData.parsed.files,
    options,
    args: toTscArgs(options, []),
  };
}

/** 用 none 适配器测「harness 循环 + 计时框架」本身的开销（不含检查器）。 */
async function measureHarnessOverhead(
  opts: BenchOptions,
  cases: BenchCase[],
): Promise<{ totalMs: number; perCaseMs: number }> {
  const samples: number[] = [];
  for (let rep = 0; rep < opts.reps; rep++) {
    for (const index of orderedIndices(cases.length, rep)) {
      const caseData = cases[index]!;
      if (caseData.skip !== null) continue;
      const adapter = await createAdapter("none");
      const start = performance.now();
      await adapter.check({
        id: caseData.id,
        files: caseData.parsed.files,
        options: [],
        args: [],
      });
      samples.push(performance.now() - start);
    }
  }
  const totalMs = samples.reduce((a, b) => a + b, 0);
  return { totalMs, perCaseMs: samples.length === 0 ? 0 : totalMs / samples.length };
}

async function measureOneAdapter(
  spec: string,
  opts: BenchOptions,
  cases: BenchCase[],
  repStart: number,
): Promise<BenchAdapterResult> {
  const timed = cases.filter((c) => c.skip === null);
  if (timed.length === 0) throw new Error(`适配器 ${spec} 没有可计时的用例（全部跳过）`);

  let referenceName = spec;
  let referenceKind: Adapter["kind"] = "per-case";
  let supportsOptions = true;
  const checkSamples = new Map<number, Sample[]>();
  const passWallMs: number[] = [];
  const emptyRuns: number[] = [];
  const initTimes: number[] = [];

  let warmAdapter: Adapter | null = null;
  if (!opts.cold) {
    const initStart = performance.now();
    warmAdapter = await createAdapter(spec);
    await warmAdapter.init?.();
    initTimes.push(performance.now() - initStart);
    referenceName = warmAdapter.name;
    referenceKind = warmAdapter.kind;
    supportsOptions = warmAdapter.supportsOptions;
    if (opts.mode === "fixed" && warmAdapter.fixedOptions === undefined) {
      throw new Error(`适配器 ${spec} 没有声明 fixedOptions，不能用 fixed 口径计时`);
    }
    // warm 基线：第一次空程序会把 lib 建起来，取后续两次的中位作为「lib 已建好」的基线。
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await warmAdapter.check(emptyCaseInput(warmAdapter, opts.mode));
      const ms = performance.now() - start;
      if (i > 0) emptyRuns.push(ms);
    }
  }

  const cpuStart = process.cpuUsage();
  try {
    for (let rep = 0; rep < opts.reps; rep++) {
      const wallStart = performance.now();
      if (warmAdapter === null) {
        // cold：每案新建适配器；空程序基线也按同一模式单独测一次。
        const emptyAdapter = await createAdapter(spec);
        const initStart = performance.now();
        await emptyAdapter.init?.();
        initTimes.push(performance.now() - initStart);
        if (opts.mode === "fixed" && emptyAdapter.fixedOptions === undefined) {
          throw new Error(`适配器 ${spec} 没有声明 fixedOptions，不能用 fixed 口径计时`);
        }
        const emptyStart = performance.now();
        await emptyAdapter.check(emptyCaseInput(emptyAdapter, opts.mode));
        emptyRuns.push(performance.now() - emptyStart);
        await emptyAdapter.close?.();
      }
      for (const index of orderedIndices(cases.length, rep)) {
        const caseData = cases[index]!;
        if (caseData.skip !== null) continue;
        let adapter: Adapter;
        let initMs = 0;
        if (warmAdapter !== null) {
          adapter = warmAdapter;
        } else {
          const initStart = performance.now();
          adapter = await createAdapter(spec);
          await adapter.init?.();
          initMs = performance.now() - initStart;
          initTimes.push(initMs);
          referenceName = adapter.name;
          referenceKind = adapter.kind;
          supportsOptions = adapter.supportsOptions;
          if (opts.mode === "fixed" && adapter.fixedOptions === undefined) {
            throw new Error(`适配器 ${spec} 没有声明 fixedOptions，不能用 fixed 口径计时`);
          }
        }
        const input = inputFor(adapter, caseData, opts);
        const start = performance.now();
        const outcome = await adapter.check(input);
        const ms = performance.now() - start;
        const checkMs = outcome.checkMs;
        if (warmAdapter === null) await adapter.close?.();
        let list = checkSamples.get(index);
        if (list === undefined) {
          list = [];
          checkSamples.set(index, list);
        }
        list.push({ rep: rep + repStart, ms, checkMs, diag: outcome.diagnostics.length, status: outcome.status });
      }
      passWallMs.push(performance.now() - wallStart);
    }
  } finally {
    await warmAdapter?.close?.();
  }
  const cpu = process.cpuUsage(cpuStart);

  const caseTiming: CaseTiming[] = cases.map((caseData) => ({
    id: caseData.id,
    lines: caseData.lines,
    skip: caseData.skip,
    expected: caseData.expectedCount,
    samples: checkSamples.get(caseData.index) ?? [],
  }));
  const checkSumMs = caseTiming.reduce(
    (sum, c) => sum + c.samples.reduce((s, x) => s + x.ms, 0),
    0,
  );
  const perCaseMs = caseTiming
    .filter((c) => c.samples.length > 0)
    .map((c) => median(c.samples.map((s) => s.ms)));
  const linesChecked = timed.reduce((sum, c) => sum + c.lines, 0);
  const perRepMean = checkSumMs / opts.reps;
  const emptyBaselineMs = median(emptyRuns);
  const checkOnlyTotalMs = Math.max(0, checkSumMs - opts.reps * emptyBaselineMs);
  const checkOnlyPerCaseMs = checkOnlyTotalMs / opts.reps / timed.length;
  const usPerLine = linesChecked === 0 ? 0 : (perRepMean * 1000) / linesChecked;
  const checkOnlyUsPerLine = linesChecked === 0 ? 0 : ((checkOnlyTotalMs / opts.reps) * 1000) / linesChecked;
  const diagTotal = caseTiming.reduce((sum, c) => sum + median(c.samples.map((s) => s.diag)), 0);
  const expectedValues = timed.map((c) => c.expectedCount).filter((v): v is number => v !== null);
  const expectedTotal = expectedValues.length > 0 ? expectedValues.reduce((a, b) => a + b, 0) : null;
  const selfReported = caseTiming.flatMap((c) => c.samples.map((s) => s.checkMs));
  const selfReportedCheckMs =
    selfReported.length > 0 && selfReported.every((v): v is number => v !== undefined)
      ? selfReported.reduce((a, b) => a + b, 0)
      : null;

  return {
      spec,
      name: referenceName,
      kind: referenceKind,
      supportsOptions,
      cache: opts.cold ? "cold" : "warm",
      reps: opts.reps,
      passWallMs: passWallMs.map(round2),
      checkSumMs: round2(checkSumMs),
      perRepMeanMs: round2(perRepMean),
      perCaseMedianMs: round2(median(perCaseMs)),
      emptyBaselineMs: round2(emptyBaselineMs),
      emptyBaselineRuns: emptyRuns.map(round2),
      checkOnlyTotalMs: round2(checkOnlyTotalMs),
      checkOnlyPerCaseMs: round2(checkOnlyPerCaseMs),
      checkOnlyUsPerLine: round2(checkOnlyUsPerLine),
      totalWallMs: round2(checkSumMs + initTimes.reduce((a, b) => a + b, 0)),
      adapterInitMs: round2(median(initTimes)),
      adapterInitKind: opts.cold ? "per-case" : "one-time",
      usPerLine: round2(usPerLine),
      cpuMs: round2((cpu.user + cpu.system) / 1000),
      diagTotal: round2(diagTotal),
      expectedTotal,
      coverageProxy: expectedTotal === null || expectedTotal === 0 ? null : round2(diagTotal / expectedTotal),
      selfReportedCheckMs: selfReportedCheckMs === null ? null : round2(selfReportedCheckMs),
      cases: caseTiming,
  };
}

export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  if (opts.reps < 1) throw new Error("--reps 需要 >=1");
  if (opts.adapterSpecs.length === 0) throw new Error("bench 需要至少一个适配器");
  const cases = prepareCases(opts);
  const timed = cases.filter((c) => c.skip === null);
  if (timed.length === 0) throw new Error("没有可计时的用例（全部被跳过）");
  const totalLines = timed.reduce((sum, c) => sum + c.lines, 0);

  const overhead = await measureHarnessOverhead(opts, cases);

  // 多实现：逐轮轮转实现顺序（每个实现自身在轮次内保持 warm 实例存活）。
  const results: BenchAdapterResult[] = [];
  for (let specIndex = 0; specIndex < opts.adapterSpecs.length; specIndex++) {
    const spec = opts.adapterSpecs[specIndex]!;
    const result = await measureOneAdapter(spec, opts, cases, specIndex * opts.reps);
    results.push(result);
  }
  const skipCounts = new Map<string, number>();
  for (const c of cases) {
    if (c.skip !== null) skipCounts.set(c.skip, (skipCounts.get(c.skip) ?? 0) + 1);
  }
  const report: BenchReport = {
    meta: {
      suite: "bench",
      schema: 2,
      corpus: opts.corpus,
      baseline: opts.baseline,
      corpusRef: opts.corpusRef,
      tscVersion: opts.tscVersion,
      tscBin: opts.tscBin,
      mode: opts.mode,
      expectationSource: opts.expectationSource,
      generatedAt: new Date().toISOString(),
      reps: opts.reps,
      cache: opts.cold ? "cold" : "warm",
      headlineMetric: "check-only (corpus − empty-program baseline)",
      baselineProgram: "export {};（无诊断空程序）",
      messageRendering: "adapter-default",
      caseOrderRotation: "alternating-forward-reverse",
      parallel: 1,
      workerRecycle: null,
      casesSelected: cases.length,
      casesTimed: timed.length,
      casesSkipped: cases.length - timed.length,
      totalLines,
      harnessOverheadMs: round2(overhead.totalMs),
      noopPerCaseMs: round2(overhead.perCaseMs),
    },
    adapters: results,
    skips: [...skipCounts.entries()].sort((a, b) => b[1] - a[1]),
  };

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "bench.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** 控制台摘要：每实现一行，头条是 check-only（总时间与空程序基线单列）。 */
export function formatBenchSummary(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(
    `bench: ${report.meta.casesTimed} 例计时 / ${report.meta.casesSkipped} 例跳过，reps=${report.meta.reps}，` +
      `cache=${report.meta.cache}，harness 开销 ${report.meta.harnessOverheadMs}ms（${report.meta.noopPerCaseMs}ms/例）`,
  );
  const header = [
    "适配器",
    "cache",
    "总 check ms",
    "空程序基线 ms",
    "check-only ms",
    "check-only/例",
    "μs/行",
    "诊断/期望",
  ];
  const rows = report.adapters.map((a) => [
    a.spec,
    a.cache,
    a.checkSumMs.toFixed(1),
    a.emptyBaselineMs.toFixed(1),
    a.checkOnlyTotalMs.toFixed(1),
    a.checkOnlyPerCaseMs.toFixed(2),
    a.checkOnlyUsPerLine.toFixed(2),
    a.expectedTotal === null
      ? String(Math.round(a.diagTotal))
      : `${Math.round(a.diagTotal)}/${Math.round(a.expectedTotal)}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  lines.push(fmt(header));
  for (const row of rows) lines.push(fmt(row));
  lines.push(
    "check-only ≈ 语料 check 合计 − reps × 空程序基线；空程序基线≈进程启动+lib 解析+空检查。诊断/期望用于标注「查得少」，不是兼容性结论。",
  );
  return lines.join("\n");
}
