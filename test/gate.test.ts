import { describe, expect, test } from "bun:test";
import { evaluateGate, formatGate, type GateInput, type GateThresholds } from "../src/gate.ts";
import type { RatchetRegression } from "../src/ratchet.ts";

const cleanTotals = {
  cases: 28,
  ran: 28,
  fpTotal: 0,
  missTotal: 0,
  misanchorTotal: 0,
  expectTotal: 76,
  coverage: 1,
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    totals: cleanTotals,
    verdictEligible: true,
    mode: "official",
    ratchet: null,
    thresholds: { maxFp: 0, maxMiss: 0, maxMisanchor: 0, minCoverage: null },
    ...overrides,
  };
}

describe("evaluateGate", () => {
  test("自比口径全 0 时通过（正常例）", () => {
    const report = evaluateGate(input());
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["口径", "执行", "假阳性", "漏报", "错锚"]);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  test("假阳性/漏报超限、覆盖率不足时失败（失败例）", () => {
    const report = evaluateGate(
      input({
        totals: { ...cleanTotals, fpTotal: 3, missTotal: 2, coverage: 0.95 },
        thresholds: { maxFp: 0, maxMiss: 0, maxMisanchor: 0, minCoverage: 0.98 },
      }),
    );
    expect(report.passed).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(["假阳性", "漏报", "覆盖率"]);
    const text = formatGate(report);
    expect(text).toContain("门禁：失败");
    expect(text).toContain("3 条 > 上限 0 条");
    expect(text).toContain("95.0% < 下限 98.0%");
  });

  test("ratchet 回落失败；回落原因进 detail", () => {
    const regressions: RatchetRegression[] = [{ id: "compiler/a.ts", was: "full", now: "text" }];
    const report = evaluateGate(
      input({
        ratchet: { path: "config/ratchet/x.tsv", registered: 1, regressions },
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "ratchet")?.detail).toContain("compiler/a.ts full → text");
  });

  test("配置 ratchet 后条数阈值默认不检查（严格性由清单承载）", () => {
    const hasRatchet: GateThresholds = { maxFp: null, maxMiss: null, maxMisanchor: null, minCoverage: null };
    const report = evaluateGate(
      input({
        totals: { ...cleanTotals, fpTotal: 5 },
        ratchet: { path: "config/ratchet/x.tsv", registered: 28, regressions: [] },
        thresholds: hasRatchet,
      }),
    );
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name)).not.toContain("假阳性");
  });

  test("不可作结论 / 没有跑完用例时失败", () => {
    const report = evaluateGate(
      input({ verdictEligible: false, mode: "fixed", totals: { ...cleanTotals, ran: 0 } }),
    );
    expect(report.passed).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(["口径", "执行"]);
  });

  test("覆盖率下限在没有期望诊断时无法核对，判失败", () => {
    const report = evaluateGate(
      input({
        totals: { ...cleanTotals, expectTotal: 0, coverage: null },
        thresholds: { maxFp: 0, maxMiss: 0, maxMisanchor: 0, minCoverage: 0.5 },
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "覆盖率")?.detail).toContain("无期望诊断");
  });
});

describe("formatGate", () => {
  test("通过时压成两行、失败时逐项列出", () => {
    expect(formatGate(evaluateGate(input())).split("\n")).toHaveLength(2);
    const failed = formatGate(evaluateGate(input({ totals: { ...cleanTotals, fpTotal: 1 } })));
    expect(failed.split("\n")[0]).toBe("门禁：失败（1/5 项未过）");
    expect(failed).toContain("[失败] 假阳性");
    expect(failed).toContain("[通过] 口径");
  });
});
