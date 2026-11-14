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

test("命中、漏报、假阳性与错锚分别计数", () => {
  const expected = [d({ line: 1, col: 2 }), d({ line: 3, col: 0, code: 2345 })];
  const actual = [d({ line: 1, col: 2 }), d({ line: 9, col: 0, code: 2339 }), d({ line: 3, col: 5, code: 2345 })];
  const record = compareCase("case-a", expected, actual);
  expect(record.hits).toBe(1);
  expect(record.missed.length).toBe(1);
  expect(record.fp.length).toBe(2);
  // 同文件同码不同位置：TS2345 计入错锚
  expect(record.misanchor).toBe(1);
});

test("warning 不进分母：只比较 error", () => {
  const expected = [d({ code: 2322 })];
  const actual = [d({ code: 2322 }), d({ code: 9999, severity: "warning" })];
  const record = compareCase("case-b", expected, actual);
  expect(record.hits).toBe(1);
  expect(record.fp.length).toBe(0);
});

test("汇总：覆盖率为空期望时记 null，skip 按原因分类", () => {
  const record = compareCase("case-c", [], []);
  const metrics = summarize([record, skipRecord("case-d", "@jsx")], meta);
  expect(metrics.totals.passCases).toBe(1);
  expect(metrics.totals.coverage).toBeNull();
  expect(metrics.skips).toEqual([["@jsx", 1]]);
});
