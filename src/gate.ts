// CI 兼容性门禁（--gate）：把一次运行的结论折算成「通过 / 失败」，
// 失败时 run.ts 以非零退出码结束。v2 检查分四类：
// 1. 口径：本次运行必须是兼容性结论（official 模式 + 适配器接受外部选项）；
// 2. 执行：至少跑完一个用例（全跳过/空 manifest 不能当绿）；
// 3. 保护档（v2）：未配置回归记录时，所选档必须全部 pass（未确认不能算通过）；
//    配置记录时按保护档阻断回归。严格档同时阻断 compatibility 回归：
//    兼容退步会让严格一致性也退步，设计表要求两档都失败。所选档没有
//    pass 历史时拒绝判绿，要求先验证；逐字段回归只报告；
// 4. 阈值：多报错误 / 漏报 / 位置差异条数上限与覆盖率下限，可叠加。
//
// 旧调用仍走 T0–T2 ratchet 逻辑，便于迁移期间保持 CLI 行为。

import type { Verdict } from "./comparison.ts";
import type { RatchetRegression, RatchetStateRegression } from "./ratchet.ts";

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
  /** 参与 passed 判定的检查项。 */
  checks: GateCheck[];
  /** 只报告、不参与 passed 的回归项（例如另一档或逐字段回归）。 */
  reported: GateNote[];
}

export interface GateNote {
  name: string;
  detail: string;
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

/** 维护者选择要保护的回归档；默认由 CLI 取 compatibility。 */
export type GateProfile = "compatibility" | "strict";

export type GateVerdictCounts = Record<Verdict, number>;

export interface GateComparisonCounts {
  compatibility: GateVerdictCounts;
  strict: GateVerdictCounts;
}

/** v2 回归检查结果；gate 按 profile 选择阻断项，其余仍由报告展示。 */
export interface GateRatchetInput {
  /** 现有记录格式：v2 的 TSV；旧 TSV 由 runner 转换后同样走这个结构。 */
  path: string;
  registered: number;
  /**
   * runner 从回归记录中统计的、已有 pass 历史的用例数。所选档若为零，
   * 门禁不能判绿：兼容档要求至少一个 compatibility pass，严格档要求至少一个
   * strict pass。旧 TSV 迁移的条目不能计作 strict 证据。
   */
  protected: { compatibility: number; strict: number };
  /** 所有回归；gate 按 profile 过滤阻断项，其余进入 reported。 */
  regressions: RatchetStateRegression[];
}

/** v2 门禁输入：未配置 ratchet 时要求所选档全部通过；配置后按保护档阻断回归。 */
export interface GateInputV2 {
  profile: GateProfile;
  totals: GateTotals;
  /** Independent runner authorization, not eligibility of a negotiated subset. */
  verdictEligible: boolean;
  verdictRefusal?: string;
  mode: "official" | "fixed";
  comparison: GateComparisonCounts;
  executionFailures?: readonly { id: string; side: "reference" | "candidate"; status: "crash" | "timeout"; reason: string }[];
  ratchet?: GateRatchetInput | null;
  thresholds: GateThresholds;
}

const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const formatRegression = (r: RatchetRegression): string =>
  `${r.id} ${r.was} → ${r.now}` + (r.reason !== undefined ? `（${r.reason}）` : "");

function evaluateGateLegacy(input: GateInput): GateReport {
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
    if (registered === 0) {
      // 空清单等于没有基准：任何用例都「不算回落」，会变成永远通过的门禁。
      checks.push({
        name: "ratchet",
        ok: false,
        detail: `清单 ${path} 没有登记任何用例，拒绝把空清单当门禁（请先本地初始化并提交清单）`,
      });
    } else {
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

  return { passed: checks.every((c) => c.ok), thresholds: input.thresholds, checks, reported: [] };
}

const profileName = (profile: GateProfile): string => profile === "strict" ? "严格一致" : "兼容";

function countText(counts: GateVerdictCounts, ran: number): string {
  const missing = Math.max(0, ran - counts.pass - counts.fail - counts.unknown);
  const parts = [`通过 ${counts.pass}/${ran}`, `失败 ${counts.fail}`, `未确认 ${counts.unknown}`];
  if (missing > 0) parts.push(`缺少结果 ${missing}`);
  return parts.join("，");
}

/**
 * 所选保护档是否应阻断该回归。
 * 严格档必须同时阻断 compatibility 回归：兼容从 pass 退步时，严格一致性也
 * 不可能继续成立。逐字段回归由具体差异报告呈现，不单独作为门禁档。
 */
export function isBlockingRegression(regression: RatchetStateRegression, profile: GateProfile): boolean {
  if (regression.kind === "compatibility") return true;
  return profile === "strict" && regression.kind === "strict";
}

const regressionText = (regression: RatchetStateRegression): string =>
  `${regression.id}${regression.field !== undefined ? `[${regression.field}]` : ""} ` +
  `${regression.kind} ${regression.was} → ${regression.now}`;

/**
 * v2 门禁：未配置回归记录时，所选档必须全部为 pass；unknown 不能视为通过。
 * 配置回归记录后，按 `isBlockingRegression` 阻断：严格档同时阻断兼容回归；
 * 另一档和逐字段回归仍进入 `reported`。显式数字阈值继续作为附加阻断条件。
 */
export function evaluateGateV2(input: GateInputV2): GateReport {
  const { totals } = input;
  const checks: GateCheck[] = [];
  const reported: GateNote[] = [];

  checks.push({
    name: "口径",
    ok: input.verdictEligible,
    detail: input.verdictEligible
      ? `可作兼容性结论（mode=${input.mode}）`
      : input.verdictRefusal ?? `不可作兼容性结论（mode=${input.mode}，或适配器不接受外部选项），门禁拒绝`,
  });

  checks.push({
    name: "执行",
    ok: totals.ran > 0,
    detail: totals.ran > 0 ? `跑完 ${totals.ran}/${totals.cases} 例` : `没有跑完的用例（共 ${totals.cases} 例）`,
  });

  const executionFailures = input.executionFailures ?? [];
  if (executionFailures.length > 0) {
    checks.push({
      name: "执行异常",
      ok: false,
      detail: `${executionFailures.length} 项无法完成：` + executionFailures.slice(0, 3).map((failure) =>
        `${failure.id}（${failure.side === "reference" ? "参考" : "候选"}：${failure.reason}）`).join("；"),
    });
  }

  const counts = input.comparison[input.profile];
  if (input.ratchet === undefined || input.ratchet === null) {
    const missing = Math.max(0, totals.ran - counts.pass - counts.fail - counts.unknown);
    const ok = totals.ran > 0 && counts.pass === totals.ran && counts.fail === 0 && counts.unknown === 0 && missing === 0;
    checks.push({
      name: profileName(input.profile),
      ok,
      detail:
        `${profileName(input.profile)}：${countText(counts, totals.ran)}` +
        (ok ? "" : "；未确认或缺少比较结果的用例不能计为通过"),
    });
  } else {
    const { path, registered, regressions } = input.ratchet;
    const protectedCount = input.ratchet.protected?.[input.profile] ?? 0;
    const blocking = regressions.filter((r) => isBlockingRegression(r, input.profile));
    const shown = blocking.slice(0, 3).map(regressionText).join("；");
    if (registered === 0) {
      checks.push({
        name: "回归记录",
        ok: false,
        detail: `记录 ${path} 没有登记任何用例，拒绝把空记录当门禁（请先本地初始化并提交记录）`,
      });
    } else if (protectedCount === 0) {
      checks.push({
        name: `${profileName(input.profile)}基准`,
        ok: false,
        detail:
          `记录 ${path} 没有已通过的${profileName(input.profile)}历史，不能据此判绿；` +
          `请先本地验证并提交至少一个${profileName(input.profile)} pass 的回归记录` +
          (input.profile === "strict" ? "（旧 TSV 的 compatibility 档不构成 strict 证据）" : ""),
      });
    } else {
      checks.push({
        name: profileName(input.profile),
        ok: blocking.length === 0,
        detail:
          blocking.length === 0
            ? `无${profileName(input.profile)}回归（记录 ${path}，登记 ${registered} 例，` +
              `${profileName(input.profile)}保护 ${protectedCount} 例，${countText(counts, totals.ran)}）`
            : `${profileName(input.profile)}回归 ${blocking.length} 项：${shown}` +
              (blocking.length > 3 ? ` 等 ${blocking.length} 项` : ""),
      });
    }
    const other = regressions.filter((r) => !isBlockingRegression(r, input.profile));
    if (other.length > 0) {
      reported.push({
        name: "非阻断回归",
        detail: `${other.length} 项不阻断「${profileName(input.profile)}」保护档，仅报告：` +
          other.slice(0, 5).map(regressionText).join("；") +
          (other.length > 5 ? ` 等 ${other.length} 项` : ""),
      });
    }
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

  if (input.thresholds.minCoverage !== null) {
    const minCoverage = input.thresholds.minCoverage;
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

  return { passed: checks.every((c) => c.ok), thresholds: input.thresholds, checks, reported };
}

/** `profile` 存在时走 v2；否则保持旧调用方与旧 TSV 门禁行为。 */
export function evaluateGate(input: GateInput | GateInputV2): GateReport {
  return "profile" in input ? evaluateGateV2(input) : evaluateGateLegacy(input);
}

/** 渲染门禁结论；通过时压成两行，失败时逐项列出，非阻断回归另附摘要。 */
export function formatGate(report: GateReport): string {
  const reported = report.reported ?? [];
  if (report.passed) {
    const lines = [
      `门禁：通过（${report.checks.length} 项检查全过）`,
      `  ${report.checks.map((c) => `${c.name}：${c.detail}`).join("；")}`,
    ];
    if (reported.length > 0) lines.push(`  仅报告：${reported.map((n) => `${n.name}：${n.detail}`).join("；")}`);
    return lines.join("\n");
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  const lines = [`门禁：失败（${failed}/${report.checks.length} 项未过）`];
  for (const check of report.checks) {
    lines.push(`  [${check.ok ? "通过" : "失败"}] ${check.name}：${check.detail}`);
  }
  if (reported.length > 0) lines.push(`  [仅报告] ${reported.map((n) => `${n.name}：${n.detail}`).join("；")}`);
  return lines.join("\n");
}
