// 性能附录的单测：相位解析、确定性分层抽样、比值汇总。

import { describe, expect, test } from "bun:test";
import {
  aggregateRatios,
  buildPerfReport,
  lineBucketOf,
  parseExtendedDiagnostics,
  planPerfOrder,
  sampleKey,
  selectPerfSample,
  type PerfCaseMeta,
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
    expect(report.warnings.some((w) => w.includes("没有成功取得参考侧计时"))).toBe(true);
  });
  test("候选缺失的计时不会归因给已成功的参考", () => {
    const sampleIds = ["compiler/a.ts", "compiler/b.ts"];
    const report = buildPerfReport({
      seed: "s", requested: 2, sampleIds, implWalls: new Map([[sampleIds[0]!, 50]]),
      implEmptyWallMs: 1, reference: new Map(sampleIds.map((id) => [id, mkRun(100, 10)])),
      implCheckMs: new Map(), agreementIds: new Set(sampleIds), warnings: [],
    });
    expect(report.sample).toMatchObject({ size: 1, referenceOk: 2, referenceFailed: 0 });
    expect(report.ratio.wall).toBe(0.5);
    expect(report.ratio.agreementSubset).toMatchObject({
      wall: 0.5, implWallMs: report.impl.sumWallMs, referenceWallMs: report.reference.sumWallMs,
    });
    expect(report.warnings.some((w) => w.includes("候选侧计时"))).toBe(true);
    expect(report.ratio.agreementSubset.cases).toBe(1);
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


describe("分层抽样与顺序对冲", () => {
  const ids = [
    ...Array.from({ length: 20 }, (_, i) => `compiler/small${i}.ts`),
    ...Array.from({ length: 20 }, (_, i) => `compiler/big${i}.ts`),
    ...Array.from({ length: 20 }, (_, i) => `conformance/clean${i}.ts`),
    ...Array.from({ length: 20 }, (_, i) => `conformance/err${i}.ts`),
  ];
  const meta = new Map<string, PerfCaseMeta>();
  for (const id of ids) {
    if (id.includes("big")) meta.set(id, { lines: 500, hasErrors: true });
    else if (id.includes("small")) meta.set(id, { lines: 10, hasErrors: false });
    else if (id.includes("clean")) meta.set(id, { lines: 120, hasErrors: false });
    else meta.set(id, { lines: 1200, hasErrors: true });
  }

  test("行数档分档", () => {
    expect(lineBucketOf(10)).toBe("<=50");
    expect(lineBucketOf(120)).toBe("51-200");
    expect(lineBucketOf(500)).toBe("201-1000");
    expect(lineBucketOf(5000)).toBe(" >1000");
  });

  test("suite × 行数档 × 有无错误 都进入样本", () => {
    const sample = selectPerfSample(ids, 24, "seed", meta);
    expect(sample.length).toBe(24);
    const buckets = new Set(sample.map((id) => lineBucketOf(meta.get(id)!.lines)));
    const suites = new Set(sample.map((id) => id.split("/")[0]));
    const errs = new Set(sample.map((id) => meta.get(id)!.hasErrors));
    expect(buckets.size).toBe(4);
    expect(suites.size).toBe(2);
    expect(errs.size).toBe(2);
  });

  test("顺序对半对冲且确定", () => {
    const sample = selectPerfSample(ids, 10, "seed", meta);
    const plan = planPerfOrder(sample, "seed");
    const values = [...plan.values()];
    expect(values.filter((v) => v === "ref-first")).toHaveLength(5);
    expect(values.filter((v) => v === "impl-first")).toHaveLength(5);
    expect(planPerfOrder(sample, "seed")).toEqual(plan);
  });
});

describe("逐案聚合", () => {
  test("median/geomean/P25/P75", () => {
    const a = aggregateRatios([1, 2, 3, 4])!;
    expect(a.n).toBe(4);
    expect(a.median).toBeCloseTo(2.5, 6);
    expect(a.geomean).toBeCloseTo(Math.sqrt(Math.sqrt(1 * 2 * 3 * 4)), 6);
    expect(a.p25).toBeCloseTo(1.75, 6);
    expect(a.p75).toBeCloseTo(3.25, 6);
    expect(aggregateRatios([0, -1, Number.NaN])).toBeNull();
  });
});

describe("报告组成与逐案聚合", () => {
  test("composition 与 perCase 在样本上生效", () => {
    const sampleIds = ["compiler/a.ts", "compiler/b.ts", "conformance/c.ts"];
    const mk = (wallMs: number, checkMs: number): ReferenceRun => ({ status: "ok", wallMs, stats: { checkMs } });
    const reference = new Map<string, ReferenceRun>([
      ["__empty__", mk(10, 1)],
      ["compiler/a.ts", mk(20, 10)],
      ["compiler/b.ts", mk(22, 10)],
      ["conformance/c.ts", mk(24, 10)],
    ]);
    const report = buildPerfReport({
      seed: "s",
      requested: 3,
      sampleIds,
      implWalls: new Map(sampleIds.map((id) => [id, 12])),
      implCheckMs: new Map(sampleIds.map((id) => [id, 5])),
      implEmptyWallMs: 2,
      reference,
      agreementIds: new Set(["compiler/a.ts"]),
      meta: new Map<string, PerfCaseMeta>([
        ["compiler/a.ts", { lines: 10, hasErrors: false }],
        ["compiler/b.ts", { lines: 500, hasErrors: true }],
        ["conformance/c.ts", { lines: 200, hasErrors: false }],
      ]),
      order: new Map<string, "ref-first" | "impl-first">([
        ["compiler/a.ts", "ref-first"],
        ["compiler/b.ts", "impl-first"],
        ["conformance/c.ts", "ref-first"],
      ]),
      warnings: [],
    });
    expect(report.sample.composition.suite).toEqual({ compiler: 2, conformance: 1 });
    expect(report.sample.composition.lineBucket["<=50"]).toBe(1);
    expect(report.sample.composition.errorPresence).toEqual({ clean: 2, errors: 1 });
    expect(report.sample.composition.order).toEqual({ "ref-first": 2, "impl-first": 1 });
    expect(report.metric).toBe("check");
    expect(report.ratio.perCase.check!.n).toBe(3);
    // 逐案 check ratio 均为 0.5
    expect(report.ratio.perCase.check!.median).toBeCloseTo(0.5, 6);
    expect(report.ratio.agreementSubset.check).toBeCloseTo(0.5, 6);
  });
});
