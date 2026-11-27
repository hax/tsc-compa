import { describe, expect, test } from "bun:test";
import {
  evaluateGate,
  evaluateGateV2,
  formatGate,
  isBlockingRegression,
  type GateInput,
  type GateInputV2,
  type GateProfile,
  type GateThresholds,
} from "../src/gate.ts";
import type { RatchetRegression, RatchetStateRegression } from "../src/ratchet.ts";

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

  test("ratchet 清单为空（registered=0）视为配置错误、判失败", () => {
    const report = evaluateGate(
      input({ ratchet: { path: "config/ratchet/empty.tsv", registered: 0, regressions: [] } }),
    );
    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "ratchet");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("空清单");
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


const v2Thresholds: GateThresholds = { maxFp: null, maxMiss: null, maxMisanchor: null, minCoverage: null };
const v2Totals = { cases: 2, ran: 2, fpTotal: 0, missTotal: 0, misanchorTotal: 0, expectTotal: 2, coverage: 1 };
const reg = (patch: Partial<RatchetStateRegression> = {}): RatchetStateRegression => ({
  id: "a.ts", kind: "compatibility", was: "pass", now: "fail", reasonKind: "comparison", reason: "changed", ...patch,
});
function v2(overrides: Partial<GateInputV2> = {}): GateInputV2 {
  return {
    profile: "compatibility",
    totals: v2Totals,
    verdictEligible: true,
    mode: "official",
    comparison: {
      compatibility: { pass: 2, fail: 0, unknown: 0 },
      strict: { pass: 2, fail: 0, unknown: 0 },
    },
    ratchet: null,
    thresholds: v2Thresholds,
    ...overrides,
  };
}

describe("evaluateGateV2（两档门禁）", () => {
  test("无 ratchet：默认兼容全通过；严格档要求严格全通过", () => {
    expect(evaluateGateV2(v2()).passed).toBe(true);
    expect(evaluateGateV2(v2({ profile: "strict" })).passed).toBe(true);
    const compatibleOnly = v2({
      profile: "strict",
      comparison: {
        compatibility: { pass: 2, fail: 0, unknown: 0 },
        strict: { pass: 1, fail: 1, unknown: 0 },
      },
    });
    expect(evaluateGateV2(compatibleOnly).passed).toBe(false);
    expect(evaluateGateV2({ ...compatibleOnly, profile: "compatibility" }).passed).toBe(true);
  });

  test("未知或缺少结果不能当通过", () => {
    for (const counts of [
      { pass: 1, fail: 0, unknown: 1 },
      { pass: 1, fail: 0, unknown: 0 },
      { pass: 2, fail: 0, unknown: 0 },
    ]) {
      const report = evaluateGateV2(v2({ comparison: { compatibility: counts, strict: counts } }));
      if (counts.pass === 2) expect(report.passed).toBe(true);
      else expect(report.passed).toBe(false);
    }
  });

  test("有 ratchet：兼容档只阻断兼容回归，严格与字段回归只报告", () => {
    const regressions = [
      reg({ kind: "strict", field: undefined, was: "pass", now: "fail" }),
      reg({ kind: "field", field: "message", was: "equal", now: "different" }),
    ];
    const report = evaluateGateV2(v2({
      ratchet: { path: "r.tsv", registered: 2, protected: { compatibility: 2, strict: 2 }, regressions },
    }));
    expect(report.passed).toBe(true);
    expect(report.reported).toHaveLength(1);
    expect(formatGate(report)).toContain("仅报告：");
    expect(formatGate(report)).toContain("strict");
  });

  test("严格档同时阻断兼容与严格回归（设计表）", () => {
    const report = evaluateGateV2(v2({
      profile: "strict",
      ratchet: {
        path: "r.tsv", registered: 2, protected: { compatibility: 2, strict: 2 },
        regressions: [reg({ kind: "compatibility" }), reg({ kind: "strict" })],
      },
    }));
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "严格一致")?.detail).toContain("2 项");
    expect(isBlockingRegression(reg({ kind: "compatibility" }), "compatibility")).toBe(true);
    expect(isBlockingRegression(reg({ kind: "compatibility" }), "strict")).toBe(true);
    expect(isBlockingRegression(reg({ kind: "strict" }), "compatibility")).toBe(false);
    expect(isBlockingRegression(reg({ kind: "strict" }), "strict")).toBe(true);
    expect(isBlockingRegression(reg({ kind: "field", field: "message" }), "strict")).toBe(false);
  });

  test("所选档没有 pass 历史时拒绝判绿，并明确要求先验证", () => {
    const strict = evaluateGateV2(v2({
      profile: "strict",
      ratchet: { path: "old.tsv", registered: 2, protected: { compatibility: 2, strict: 0 }, regressions: [] },
    }));
    expect(strict.passed).toBe(false);
    expect(strict.checks.find((c) => c.name === "严格一致基准")?.detail).toContain("旧 TSV 的 compatibility 档不构成 strict 证据");
    const compatibility = evaluateGateV2(v2({
      ratchet: { path: "r.tsv", registered: 2, protected: { compatibility: 0, strict: 2 }, regressions: [] },
    }));
    expect(compatibility.passed).toBe(false);
    expect(compatibility.checks.find((c) => c.name === "兼容基准")?.detail).toContain("请先本地验证");
    const empty = evaluateGateV2(v2({
      ratchet: { path: "empty.tsv", registered: 0, protected: { compatibility: 0, strict: 0 }, regressions: [] },
    }));
    expect(empty.passed).toBe(false);
    expect(empty.checks.find((c) => c.name === "回归记录")?.detail).toContain("空记录");
  });

  test("显式数字阈值叠加阻断", () => {
    const report = evaluateGateV2(v2({
      totals: { ...v2Totals, fpTotal: 3 },
      thresholds: { maxFp: 0, maxMiss: null, maxMisanchor: null, minCoverage: null },
    }));
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "假阳性")?.ok).toBe(false);
  });
});
