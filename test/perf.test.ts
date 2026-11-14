// 性能附录的单测：相位解析、确定性分层抽样、比值汇总。

import { describe, expect, test } from "bun:test";
import {
  buildPerfReport,
  parseExtendedDiagnostics,
  sampleKey,
  selectPerfSample,
  type ReferenceRun,
} from "../src/perf.ts";

describe("parseExtendedDiagnostics", () => {
  test("解析 tsc 的秒级相位与计数", () => {
    const text = [
      "Files:              91",
      "Lines:           59748",
      "Symbols:         59807",
      "Types:           34893",
      "Parse time:     0.026s",
      "Bind time:      0.012s",
      "Check time:     0.148s",
      "Emit time:      0.000s",
      "Total time:     0.190s",
    ].join("\n");
    const stats = parseExtendedDiagnostics(text);
    expect(stats).not.toBeNull();
    expect(stats!.parseMs).toBeCloseTo(26, 5);
    expect(stats!.bindMs).toBeCloseTo(12, 5);
    expect(stats!.checkMs).toBeCloseTo(148, 5);
    expect(stats!.totalMs).toBeCloseTo(190, 5);
    expect(stats!.counts).toEqual({ Files: 91, Lines: 59748, Symbols: 59807, Types: 34893 });
  });

  test("没有相位行时返回 null", () => {
    expect(parseExtendedDiagnostics("no timings here\n")).toBeNull();
  });
});

describe("selectPerfSample", () => {
  const ids = [
    ...Array.from({ length: 50 }, (_, i) => `compiler/c${i}.ts`),
    ...Array.from({ length: 10 }, (_, i) => `conformance/x${i}.ts`),
  ];

  test("同一 seed 结果稳定，不同 seed 变化", () => {
    const a = selectPerfSample(ids, 12, "seed-a");
    expect(a).toEqual(selectPerfSample(ids, 12, "seed-a"));
    expect(a).not.toEqual(selectPerfSample(ids, 12, "seed-b"));
    expect(a.length).toBe(12);
    expect(new Set(a).size).toBe(a.length);
  });

  test("按 suite 分层：两个 suite 都抽到", () => {
    const sample = selectPerfSample(ids, 12, "seed-a");
    expect(sample.some((id) => id.startsWith("compiler/"))).toBe(true);
    expect(sample.some((id) => id.startsWith("conformance/"))).toBe(true);
  });

  test("size 超过总数时全取", () => {
    expect(selectPerfSample(ids, 1000, "s").length).toBe(ids.length);
    expect(selectPerfSample([], 10, "s")).toEqual([]);
  });

  test("sampleKey 与 id/seed 绑定", () => {
    expect(sampleKey("s", "a")).not.toBe(sampleKey("s", "b"));
    expect(sampleKey("s", "a")).not.toBe(sampleKey("t", "a"));
  });
});

describe("buildPerfReport", () => {
  const mkRun = (wallMs: number, checkMs?: number): ReferenceRun => ({
    status: "ok",
    wallMs,
    stats: checkMs === undefined ? undefined : { checkMs },
  });

  test("wall-adjusted 与一致子集比值", () => {
    const sampleIds = ["compiler/a.ts", "compiler/b.ts", "compiler/c.ts", "conformance/d.ts"];
    const implWalls = new Map<string, number>([
      ["compiler/a.ts", 10],
      ["compiler/b.ts", 20],
      ["compiler/c.ts", 30],
      ["conformance/d.ts", 40],
    ]);
    const reference = new Map<string, ReferenceRun>([
      ["__empty__", mkRun(100)],
      ["compiler/a.ts", mkRun(110)],
      ["compiler/b.ts", mkRun(120)],
      ["compiler/c.ts", mkRun(130)],
      ["conformance/d.ts", mkRun(90)], // 参考失败/慢态无关，这里只看成功样本
    ]);
    const report = buildPerfReport({
      seed: "s",
      requested: 4,
      sampleIds,
      implWalls,
      implEmptyWallMs: 50,
      reference,
      implCheckMs: new Map(),
      agreementIds: new Set(["compiler/a.ts", "compiler/b.ts"]),
      warnings: [],
    });
    // 实现：100 − 4×50 = −100（负偏移）；参考：450 − 4×100 = 50；比值不可用，要求 null。
    expect(report.ratio.wallAdjusted).toBeNull();
    expect(report.sample.size).toBe(4);
    expect(report.metric).toBe("wall-adjusted");
    expect(report.warnings.some((w) => w.includes("Check 相位"))).toBe(true);

    const better = buildPerfReport({
      seed: "s",
      requested: 4,
      sampleIds,
      implWalls: new Map(sampleIds.map((id) => [id, 30])),
      implEmptyWallMs: 5,
      reference,
      implCheckMs: new Map(),
      agreementIds: new Set(["compiler/a.ts", "compiler/b.ts"]),
      warnings: [],
    });
    // 实现：120 − 4×5 = 100；参考：450 − 4×100 = 50 → 2.0
    expect(better.ratio.wallAdjusted).toBeCloseTo(2, 5);
    // 一致子集：实现 60 − 2×5 = 50；参考 230 − 2×100 = 30 → 1.666…
    expect(better.ratio.agreementSubset.cases).toBe(2);
    expect(better.ratio.agreementSubset.wallAdjusted).toBeCloseTo(50 / 30, 5);
  });

  test("参考失败样本被剔除，check 相位有就报", () => {
    const sampleIds = ["a/x.ts", "a/y.ts"];
    const implWalls = new Map<string, number>([
      ["a/x.ts", 10],
      ["a/y.ts", 20],
    ]);
    const reference = new Map<string, ReferenceRun>([
      ["__empty__", mkRun(50, 10)],
      ["a/x.ts", mkRun(100, 40)],
      ["a/y.ts", { status: "timeout", wallMs: 999 }],
    ]);
    const report = buildPerfReport({
      seed: "s",
      requested: 2,
      sampleIds,
      implWalls,
      implEmptyWallMs: 5,
      reference,
      implCheckMs: new Map(),
      agreementIds: new Set(["a/x.ts"]),
      warnings: [],
    });
    expect(report.sample.size).toBe(1);
    expect(report.sample.referenceFailed).toBe(1);
    expect(report.reference.checkSumMs).toBeCloseTo(40, 5);
    expect(report.warnings.some((w) => w.includes("未成功"))).toBe(true);
  });
});


describe("buildPerfReport：Check 相位口径", () => {
  test("两侧都有 Check 时用累加比，不再依赖空程序基线", () => {
    const sampleIds = ["a/x.ts", "a/y.ts"];
    const mkRun = (wallMs: number, checkMs: number): ReferenceRun => ({ status: "ok", wallMs, stats: { checkMs } });
    const implWalls = new Map([
      ["a/x.ts", 100],
      ["a/y.ts", 100],
    ]);
    const implCheckMs = new Map([
      ["a/x.ts", 10],
      ["a/y.ts", 10],
    ]);
    const reference = new Map<string, ReferenceRun>([
      ["__empty__", mkRun(80, 1)],
      ["a/x.ts", mkRun(90, 5)],
      ["a/y.ts", mkRun(95, 5)],
    ]);
    const report = buildPerfReport({
      seed: "s",
      requested: 2,
      sampleIds,
      implWalls,
      implCheckMs,
      implEmptyWallMs: 5,
      reference,
      agreementIds: new Set(sampleIds),
      warnings: [],
    });
    expect(report.metric).toBe("check");
    expect(report.ratio.check).toBeCloseTo(20 / 10, 5);
    expect(report.ratio.agreementSubset.check).toBeCloseTo(2, 5);
    expect(report.impl.checkSumMs).toBeCloseTo(20, 5);
  });
});
