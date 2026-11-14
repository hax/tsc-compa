// --bench 计时模式的单元/集成测试：头条指标是 check-only（语料 − 空程序基线）。

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_PROGRAM_ID,
  EMPTY_PROGRAM_SOURCE,
  formatBenchSummary,
  linesOfCase,
  median,
  orderedIndices,
  runBench,
} from "../src/bench.ts";
import { parseCase } from "../src/case.ts";

test("median 处理奇偶长度与空数组", () => {
  expect(median([])).toBe(0);
  expect(median([3])).toBe(3);
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("linesOfCase 按虚拟文件文本行数求和，空文件记 0", () => {
  const parsed = parseCase("let a = 1;\nlet b = 2;\nexport {};\n", "x.ts");
  expect(linesOfCase(parsed)).toBe(3);
  const multi = parseCase(
    "// @filename: a.ts\nlet a = 1;\n\n// @filename: b.ts\nlet b = 2;\nexport {};\n",
    "multi.ts",
  );
  expect(linesOfCase(multi)).toBe(3);
  const empty = parseCase("// @filename: empty.ts\n\nexport {};\n", "e.ts");
  expect(linesOfCase(empty)).toBe(1);
});

test("orderedIndices 逐轮正反交替", () => {
  expect(orderedIndices(4, 0)).toEqual([0, 1, 2, 3]);
  expect(orderedIndices(4, 1)).toEqual([3, 2, 1, 0]);
  expect(orderedIndices(4, 2)).toEqual([0, 1, 2, 3]);
});

test("空程序基线常量保持无诊断的最小程序", () => {
  const parsed = parseCase(EMPTY_PROGRAM_SOURCE, "empty.ts");
  expect(parsed.skip).toBeNull();
  expect(parsed.options.length).toBe(0);
  expect(EMPTY_PROGRAM_ID.length).toBeGreaterThan(0);
});

test("runBench（warm，none 适配器）产出 check-only 口径的 bench.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsc-compa-bench-test-"));
  try {
    const corpus = join(root, "corpus");
    mkdirSync(join(corpus, "compiler"), { recursive: true });
    writeFileSync(join(corpus, "compiler", "a.ts"), "// @strict: true\nlet a: number = 1;\nexport {};\n");
    writeFileSync(join(corpus, "compiler", "b.ts"), "export const b = 1;\n");
    const outDir = join(root, "out");
    const report = await runBench({
      corpus,
      caseIds: ["compiler/a.ts", "compiler/b.ts"],
      adapterSpecs: ["none"],
      mode: "official",
      reps: 2,
      cold: false,
      expectationArgs: [],
      tscBin: "tsc",
      tscVersion: "test",
      expectationSource: "tsc",
      skipExpectations: true,
      outDir,
    });
    expect(report.meta.suite).toBe("bench");
    expect(report.meta.cache).toBe("warm");
    expect(report.meta.casesTimed).toBe(2);
    expect(report.adapters).toHaveLength(1);
    const adapter = report.adapters[0]!;
    expect(adapter.emptyBaselineRuns.length).toBeGreaterThan(0);
    expect(adapter.checkOnlyTotalMs).toBeGreaterThanOrEqual(0);
    expect(adapter.checkSumMs).toBeGreaterThanOrEqual(adapter.checkOnlyTotalMs);
    const summary = formatBenchSummary(report);
    expect(summary).toContain("check-only");
    expect(summary).toContain("空程序基线");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBench（cold，none 适配器）每案新建适配器且结果可复现同量级", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsc-compa-bench-cold-"));
  try {
    const corpus = join(root, "corpus");
    mkdirSync(join(corpus, "conformance"), { recursive: true });
    writeFileSync(join(corpus, "conformance", "a.ts"), "let a = 1;\nexport {};\n");
    const opts = {
      corpus,
      caseIds: ["conformance/a.ts"],
      adapterSpecs: ["none"],
      mode: "official" as const,
      reps: 2,
      cold: true,
      expectationArgs: [],
      tscBin: "tsc",
      tscVersion: "test",
      expectationSource: "tsc" as const,
      skipExpectations: true,
      outDir: join(root, "out1"),
    };
    const first = await runBench(opts);
    const second = await runBench({ ...opts, outDir: join(root, "out2") });
    expect(first.meta.cache).toBe("cold");
    expect(first.adapters[0]!.adapterInitKind).toBe("per-case");
    expect(first.adapters[0]!.emptyBaselineMs).toBeGreaterThanOrEqual(0);
    // 同配置两次跑，check-only 应处于同量级（极小的 none 检查，允许 10ms 抖动）。
    expect(Math.abs(first.adapters[0]!.checkOnlyTotalMs - second.adapters[0]!.checkOnlyTotalMs)).toBeLessThan(10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
