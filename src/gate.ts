// CI 兼容性门禁（--gate）：把一次运行的结论折算成「通过 / 失败」，
// 失败时 run.ts 以非零退出码结束。检查分四类：
// 1. 口径：本次运行必须是兼容性结论（official 模式 + 适配器接受外部选项）；
// 2. 执行：至少跑完一个用例（全跳过/空 manifest 不能当绿）；
// 3. ratchet：配置了清单且出现回落即失败（按用例一致档位，只升不降）；
// 4. 阈值：假阳性 / 漏报 / 错锚条数上限与覆盖率下限。没有 ratchet 时默认
//    三者全 0（自比自检口径），配置了 ratchet 时默认不设上限（由清单承载
//    逐例严格性），可用 --gate-max-* 显式叠加。
//
// T3（整份 `.errors.txt` 摘要块字节相等）仍是报告档：未达只进
// metrics.totals.t3Failures，不参与门禁；T0–T2 通过 ratchet 清单按用例兜底。

import type { RatchetRegression } from "./ratchet.ts";

export interface GateTotals {
  cases: number;
  ran: number;
  fpTotal: number;
  missTotal: number;
  misanchorTotal: number;
  expectTotal: number;
  coverage: number | null;
}

/** 门禁阈值；null 表示该项不检查。 */
export interface GateThresholds {
  maxFp: number | null;
  maxMiss: number | null;
  maxMisanchor: number | null;
  /** 0~1 的比例；null 表示不检查。 */
  minCoverage: number | null;
}

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GateReport {
  passed: boolean;
  thresholds: GateThresholds;
  checks: GateCheck[];
}

export interface GateInput {
  totals: GateTotals;
  /** false（fixed 模式 / 适配器不支持选项）时门禁直接拒绝，避免拿非结论当绿。 */
  verdictEligible: boolean;
  mode: "official" | "fixed";
  /** 本次运行对比的 ratchet 清单与回落列表；没配清单时为 null/undefined。 */
  ratchet?: { path: string; registered: number; regressions: RatchetRegression[] } | null;
  thresholds: GateThresholds;
}

const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const formatRegression = (r: RatchetRegression): string =>
  `${r.id} ${r.was} → ${r.now}` + (r.reason !== undefined ? `（${r.reason}）` : "");

export function evaluateGate(input: GateInput): GateReport {
  const { totals } = input;
  const checks: GateCheck[] = [];

  checks.push({
    name: "口径",
    ok: input.verdictEligible,
    detail: input.verdictEligible
      ? `可作兼容性结论（mode=${input.mode}）`
      : `不可作兼容性结论（mode=${input.mode}，或适配器不接受外部选项），门禁拒绝`,
  });

  checks.push({
    name: "执行",
    ok: totals.ran > 0,
    detail: totals.ran > 0 ? `跑完 ${totals.ran}/${totals.cases} 例` : `没有跑完的用例（共 ${totals.cases} 例）`,
  });

  if (input.ratchet !== undefined && input.ratchet !== null) {
    const { path, registered, regressions } = input.ratchet;
    const shown = regressions.slice(0, 3).map(formatRegression).join("；");
    checks.push({
      name: "ratchet",
      ok: regressions.length === 0,
      detail:
        regressions.length === 0
          ? `无回落（清单 ${path}，登记 ${registered} 例）`
          : `回落 ${regressions.length} 例：${shown}` + (regressions.length > 3 ? ` 等 ${regressions.length} 例` : ""),
    });
  }

  const countChecks: [string, number, number | null][] = [
    ["假阳性", totals.fpTotal, input.thresholds.maxFp],
    ["漏报", totals.missTotal, input.thresholds.maxMiss],
    ["错锚", totals.misanchorTotal, input.thresholds.maxMisanchor],
  ];
  for (const [name, actual, limit] of countChecks) {
    if (limit === null) continue;
    checks.push({
      name,
      ok: actual <= limit,
      detail: `${actual} 条${actual <= limit ? " ≤ " : " > "}上限 ${limit} 条`,
    });
  }

  const minCoverage = input.thresholds.minCoverage;
  if (minCoverage !== null) {
    if (totals.coverage === null) {
      checks.push({
        name: "覆盖率",
        ok: false,
        detail: `无期望诊断（分母 ${totals.expectTotal}），无法核对下限 ${formatPct(minCoverage)}`,
      });
    } else {
      checks.push({
        name: "覆盖率",
        ok: totals.coverage >= minCoverage,
        detail: `${formatPct(totals.coverage)}${totals.coverage >= minCoverage ? " ≥ " : " < "}下限 ${formatPct(minCoverage)}`,
      });
    }
  }

  return { passed: checks.every((c) => c.ok), thresholds: input.thresholds, checks };
}

/** 渲染门禁结论；通过时压成两行，失败时逐项列出。 */
export function formatGate(report: GateReport): string {
  if (report.passed) {
    return [
      `门禁：通过（${report.checks.length} 项检查全过）`,
      `  ${report.checks.map((c) => `${c.name}：${c.detail}`).join("；")}`,
    ].join("\n");
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  const lines = [`门禁：失败（${failed}/${report.checks.length} 项未过）`];
  for (const check of report.checks) {
    lines.push(`  [${check.ok ? "通过" : "失败"}] ${check.name}：${check.detail}`);
  }
  return lines.join("\n");
}
