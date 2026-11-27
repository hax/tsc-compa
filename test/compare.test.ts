// 匹配规则与指标汇总的单测。

import { expect, test } from "bun:test";
import { compareCase, skipRecord, summarize, type RunMeta } from "../src/compare.ts";
import type { Diagnostic } from "../src/types.ts";

const meta: RunMeta = {
  suite: "test",
  corpus: "/tmp/corpus",
  adapter: "test",
  mode: "official",
  verdictEligible: true,
  tscVersion: "0",
  tscBin: "tsc",
  generatedAt: "2026-01-01T00:00:00.000Z",
  selectedCases: 2,
};

const d = (patch: Partial<Diagnostic>): Diagnostic => ({
  file: "a.ts",
  line: 0,
  col: 0,
  code: 2322,
  severity: "error",
  ...patch,
});

test("精确命中、漏报、假阳性与错锚分别计数", () => {
  const expected = [d({ line: 1, col: 2 }), d({ line: 3, col: 0, code: 2345 })];
  const actual = [d({ line: 1, col: 2 }), d({ line: 9, col: 0, code: 2339 }), d({ line: 3, col: 5, code: 2345 })];
  const record = compareCase("case-a", expected, actual);
  expect(record.hits).toBe(1);
  expect(record.missed.length).toBe(0);
  expect(record.fp.length).toBe(1);
  // 同文件同码不同位置：TS2345 成对归入错锚，不进 fp/miss
  expect(record.misanchor).toBe(1);
});

test("多个候选位置无法归因时保留漏报和多报，不虚构位置对应", () => {
  const expected = [d({ line: 1 }), d({ line: 2 })];
  const actual = [d({ line: 1 }), d({ line: 5 }), d({ line: 6 })];
  const record = compareCase("case-x", expected, actual);
  expect(record.hits).toBe(1);
  expect(record.misanchor).toBe(0);
  expect(record.missed.length).toBe(1);
  expect(record.fp.length).toBe(2);
  expect(record.comparison?.compatibility).toBe("fail");
});

test("warning 保留；额外 warning 不计多报，error 降级仍算命中", () => {
  const expected = [d({ code: 2322 })];
  const actual = [d({ code: 2322, severity: "warning" }), d({ code: 9999, severity: "warning" })];
  const record = compareCase("case-b", expected, actual);
  expect(record.actual).toEqual(actual);
  expect(record.hits).toBe(1);
  expect(record.fp.length).toBe(0);
  expect(record.comparison?.compatibility).toBe("pass");
  expect(record.comparison?.strict).toBe("fail");
});

test("汇总：覆盖率为空期望时记 null，skip 按原因分类，按类聚合", () => {
  const record = compareCase("case-c", [], [], ["suite:compiler", "files:single"]);
  const metrics = summarize([record, skipRecord("case-d", "@jsx", ["suite:conformance", "files:single"])], meta);
  expect(metrics.totals.passCases).toBe(1);
  expect(metrics.totals.coverage).toBeNull();
  expect(metrics.skips).toEqual([["@jsx", 1]]);
  expect(metrics.byClass["suite:compiler"]!.ran).toBe(1);
  expect(metrics.byClass["suite:conformance"]!.skipped).toBe(1);
  expect(metrics.byClass["files:single"]!.cases).toBe(2);
});

test("完全通过要求 fp、漏报、错锚都为 0", () => {
  const misaligned = compareCase("case-e", [d({ line: 1 })], [d({ line: 2 })]);
  const metrics = summarize([misaligned], meta);
  expect(metrics.totals.passCases).toBe(0);
  expect(metrics.totals.misanchorCases).toBe(1);
  expect(metrics.totals.misanchorTotal).toBe(1);
  expect(metrics.totals.fpTotal).toBe(0);
  expect(metrics.totals.missTotal).toBe(0);
});
