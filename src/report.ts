// 人类可读兼容性报告（P0）：从一次运行的 metrics.json + details.json 渲染
// Markdown 与自包含 HTML。不重跑套件，只消费 run 的既有产物。
//
// 设计约束：
// - 输入按「可选字段」全部容忍：旧版本产物缺字段时退化成 n/a，不让报告因为上游
//   加字段而崩；数字口径以 metrics 为准（报告与 CLI 摘要同源）；
// - 确定性：渲染只依赖输入（时间取 metrics.meta.generatedAt，不读当前时间），
//   同输入同字节，便于 CI 缓存 / 逐字节 diff；
// - 自包含 HTML：CSS 内联、T0–T3 阶梯用内联 SVG，无外部资源；所有动态文本转义；
// - 报告生成失败直接抛异常（run.ts 里因此非零退出，不吞掉测试/门禁失败）。
//
// 用法（CI 的兜底步骤：套件跑挂、metrics.json 没产出时也出一份失败占位报告）：
//   bun src/report.ts --from .cache/run --md .cache/run/report.md --html .cache/run/report.html
// run.ts 侧用 --report-md / --report-html / --report-out 直接生成（见 src/run.ts）。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TIERS, type Tier } from "./compare.ts";
import type { GateReport } from "./gate.ts";

export const REPORT_MD_FILENAME = "report.md";
export const REPORT_HTML_FILENAME = "report.html";

/** details.json 的一条用例记录（字段与 src/run.ts 写出口径一致）。 */
export interface CaseDetail {
  id: string;
  status: "ran" | "skip";
  skipReason: string | null;
  className: string[];
  expected: number;
  actual: number;
  hits: number;
  fp: number;
  missed: number;
  misanchor: number;
  tier: Tier | null;
}

/** 一次运行的原始数据（metrics/details 都是未校验的 JSON）。 */
export interface RunData {
  metrics: unknown;
  details: unknown;
  /** 数据来源目录或文件，写进报告便于溯源。 */
  source?: string;
}

export interface ReportOptions {
  /** 实现显示名；缺省取适配器的中性名（去掉 `:<bin>` 后缀），不写任何私有信息。 */
  implName?: string;
  /** 实现二进制路径；给出且文件存在时，报告头部展示 sha256 前 12 位。 */
  implBin?: string;
  /** 覆盖默认标题（缺省 `tsc-compa 兼容性报告 — <baseline 或 suite>`）。 */
  title?: string;
  /** 上次运行数据；给出时渲染 delta 与逐例回归。 */
  previous?: RunData | null;
  /** 附加说明（合并报告注入的 artifact 链接等），逐行渲染在页脚前。 */
  notes?: string[];
}

export interface GeneratedReport {
  markdown: string;
  html: string;
}

// ---------------------------------------------------------------------------
// 宽松 JSON 取值：报告是展示层，任何字段缺失都不应抛错。
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => num(v) ?? 0;
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strList = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === "string");

const isTier = (v: unknown): v is Tier => typeof v === "string" && (TIERS as readonly string[]).includes(v);

/** [名称, 次数] 数组，按次数降序、名称升序排（输入乱序也输出稳定）。 */
function countPairs(v: unknown): [string, number][] {
  const pairs: [string, number][] = [];
  for (const item of list(v)) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const name = text(item[0]);
    const count = num(item[1]);
    if (name === null || count === null) continue;
    if (count > 0) pairs.push([name, count]);
  }
  return pairs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const TIER_LABELS: Record<Tier, string> = {
  none: "未达 T0",
  location: "T0 位置",
  category: "T1 类别",
  text: "T2 文案",
  full: "T3 全文",
};

const TIER_ORDER: readonly Tier[] = ["location", "category", "text", "full"];

const pct = (ratio: number | null): string => (ratio === null ? "n/a" : `${(ratio * 100).toFixed(1)}%`);
const ratioOrNull = (numerator: number | null, denominator: number | null): number | null => {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
};
const signed = (delta: number, digits = 2): string => `${delta > 0 ? "+" : ""}${delta.toFixed(digits)}`;

/** Markdown 文本转义：`&`/`<` 转实体（杜绝裸 HTML 标签）、表格竖线转义、换行压平。 */
function mdText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Markdown 表格单元。 */
const mdCell = (value: string): string => mdText(value);

/** 行内代码：围栏长度取内容里最长反引号串 + 1（避免提前闭合），换行压平。 */
function mdCode(value: string): string {
  const text = value.replace(/\r?\n/g, " ");
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  // 内容以反引号开头/结尾时，CommonMark 要求围栏两侧补一个空格才不会被吞。
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 文件的 sha256（十六进制）；文件不存在/读不了时返回 null（报告不因缺文件而失败）。 */
export function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 归一化模型
// ---------------------------------------------------------------------------

export interface ReportTotals {
  cases: number;
  ran: number;
  skipped: number;
  passCases: number;
  fpCases: number;
  fpTotal: number;
  missTotal: number;
  misanchorCases: number;
  misanchorTotal: number;
  expectTotal: number;
  hitTotal: number;
  messageMismatch: number;
  coverage: number | null;
  /** 每档「恰好落在该档」的用例数；缺数据时全 0 且 byTierKnown=false。 */
  byTier: Record<Tier, number>;
  byTierKnown: boolean;
  t3Failures: [string, number][];
}

export interface RatchetInfo {
  path: string;
  impl: string | null;
  regressions: number;
  improvements: number;
  initialized: boolean;
  wrote: boolean;
}

export interface ReportModel {
  title: string;
  suite: string;
  generatedAt: string | null;
  baseline: string | null;
  mode: string;
  verdictEligible: boolean;
  /** 适配器原始标识（可能含 `:<bin>`）。 */
  adapter: string | null;
  /** 实现显示名：中性名（适配器类型），可用 --report-impl-name 覆盖。 */
  implName: string;
  implBin: string | null;
  implBinSha: string | null;
  tscVersion: string | null;
  tscBin: string | null;
  expectationSource: string | null;
  corpus: string | null;
  corpusRef: string | null;
  /** T3 全文档是否可比：只有期望源是官方 .errors.txt 基线时才成立（否则有错误的用例最多到 T2）。 */
  t3Comparable: boolean;
  selectedCases: number | null;
  ratchet: RatchetInfo | null;
  gate: GateReport | null;
  totals: ReportTotals;
  skips: [string, number][];
  fpByCode: [string, number][];
  missByCode: [string, number][];
  samples: { fp: string[]; miss: string[]; textDiff: string[]; messageDiff: string[]; t3: string[] };
  /** 逐例明细（用于回归找 diff 与失败清单；旧产物缺 tier 时为空）。 */
  details: CaseDetail[];
  detailsSource: string | null;
  delta: ReportDelta | null;
  notes: string[];
}

export interface MetricDeltaRow {
  label: string;
  before: string;
  after: string;
  change: string;
  trend: "better" | "worse" | "same" | "na";
}

export interface CaseMovement {
  id: string;
  detail: string;
  kind: "regression" | "improvement";
}

export interface ReportDelta {
  previousLabel: string;
  rows: MetricDeltaRow[];
  regressions: CaseMovement[];
  improvements: CaseMovement[];
}

function normalizeDetails(v: unknown, source: string | null): CaseDetail[] {
  const details: CaseDetail[] = [];
  for (const item of list(v)) {
    if (!isObject(item)) continue;
    const id = text(item.id);
    if (id === null) continue;
    const status = item.status === "skip" ? "skip" : "ran";
    details.push({
      id,
      status,
      skipReason: text(item.skipReason),
      className: strList(item.classes),
      expected: int(item.expected),
      actual: int(item.actual),
      hits: int(item.hits),
      fp: int(Array.isArray(item.fp) ? item.fp.length : item.fp),
      missed: int(Array.isArray(item.missed) ? item.missed.length : item.missed),
      misanchor: int(item.misanchor),
      tier: isTier(item.tier) ? item.tier : null,
    });
  }
  return details;
}

/** metrics.totals.byTier 缺失时，用逐例 tier 反推分布（旧产物可能没有 tier，则记未知）。 */
function byTierOf(metrics: Record<string, unknown>, details: CaseDetail[]): { counts: Record<Tier, number>; known: boolean } {
  const totals = obj(metrics.totals);
  const raw = obj(totals.byTier);
  const counts: Record<Tier, number> = { none: 0, location: 0, category: 0, text: 0, full: 0 };
  let known = false;
  for (const tier of TIERS) {
    const n = num(raw[tier]);
    if (n !== null) {
      counts[tier] = n;
      known = true;
    }
  }
  if (known) return { counts, known };
  for (const detail of details) {
    if (detail.status !== "ran" || detail.tier === null) continue;
    counts[detail.tier]++;
    known = true;
  }
  return { counts, known };
}

/** 适配器标识去掉 `:<bin>` 后缀，得到中性的实现类型名（tsc-cli / checker-batch / ...）。 */
export function neutralImplName(adapter: string | null): string {
  if (adapter === null) return "实现";
  const colon = adapter.indexOf(":");
  const name = colon >= 0 ? adapter.slice(0, colon) : adapter;
  return name.length > 0 ? name : adapter;
}

/** 从适配器标识里推断实现二进制路径（`tsc-cli:<bin>` 的 `<bin>`，相对路径按当前目录解析）。 */
function implBinFromAdapter(adapter: string | null): string | null {
  if (adapter === null) return null;
  const colon = adapter.indexOf(":");
  if (colon < 0) return null;
  const bin = adapter.slice(colon + 1);
  if (bin.length === 0) return null;
  const resolved = resolve(bin);
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeTotals(metrics: Record<string, unknown>, details: CaseDetail[]): ReportTotals {
  const totals = obj(metrics.totals);
  const { counts: byTier, known: byTierKnown } = byTierOf(metrics, details);
  const expectTotal = num(totals.expectTotal) ?? 0;
  const hitTotal = num(totals.hitTotal) ?? 0;
  const coverage = num(totals.coverage) ?? ratioOrNull(hitTotal, expectTotal);
  return {
    cases: int(totals.cases),
    ran: int(totals.ran),
    skipped: int(totals.skipped),
    passCases: int(totals.passCases),
    fpCases: int(totals.fpCases),
    fpTotal: int(totals.fpTotal),
    missTotal: int(totals.missTotal),
    misanchorCases: int(totals.misanchorCases),
    misanchorTotal: int(totals.misanchorTotal),
    expectTotal,
    hitTotal,
    messageMismatch: int(totals.messageMismatch),
    coverage,
    byTier,
    byTierKnown,
    t3Failures: countPairs(totals.t3Failures),
  };
}

function normalizeRatchet(meta: Record<string, unknown>): RatchetInfo | null {
  const ratchet = obj(meta.ratchet);
  const path = text(ratchet.path);
  if (path === null) return null;
  return {
    path,
    impl: text(ratchet.impl),
    regressions: int(ratchet.regressions),
    improvements: int(ratchet.improvements),
    initialized: ratchet.initialized === true,
    wrote: ratchet.wrote === true,
  };
}

function normalizeGate(meta: Record<string, unknown>): GateReport | null {
  const gate = meta.gate;
  if (!isObject(gate)) return null;
  const checks: GateReport["checks"] = [];
  for (const item of list(gate.checks)) {
    if (!isObject(item)) continue;
    checks.push({
      name: text(item.name) ?? "check",
      ok: item.ok === true,
      detail: text(item.detail) ?? "",
    });
  }
  const thresholds = obj(gate.thresholds);
  return {
    passed: gate.passed === true,
    thresholds: {
      maxFp: num(thresholds.maxFp),
      maxMiss: num(thresholds.maxMiss),
      maxMisanchor: num(thresholds.maxMisanchor),
      minCoverage: num(thresholds.minCoverage),
    },
    checks,
  };
}

function normalizeSamples(metrics: Record<string, unknown>): ReportModel["samples"] {
  const samples = obj(metrics.samples);
  return {
    fp: strList(samples.fp),
    miss: strList(samples.miss),
    textDiff: strList(samples.textDiff),
    messageDiff: strList(samples.messageDiff),
    t3: strList(samples.t3),
  };
}

function normalizeModel(data: RunData, options: ReportOptions, previous: ReportModel | null): ReportModel {
  const metrics = obj(data.metrics);
  const meta = obj(metrics.meta);
  const details = normalizeDetails(data.details, data.source ?? null);
  const adapter = text(meta.adapter);
  const baseline = text(meta.baseline);
  const suite = text(meta.suite) ?? "smoke";
  const implBin =
    options.implBin ?? implBinFromAdapter(adapter);
  const implBinResolved = implBin === null ? null : resolve(implBin);
  const implBinSha = implBinResolved === null ? null : sha256File(implBinResolved);
  const title =
    options.title ?? `tsc-compa 兼容性报告 — ${baseline ?? suite}`;
  const model: ReportModel = {
    title,
    suite,
    generatedAt: text(meta.generatedAt),
    baseline,
    mode: text(meta.mode) ?? "unknown",
    verdictEligible: meta.verdictEligible === true,
    adapter,
    implName: options.implName ?? neutralImplName(adapter),
    implBin: implBinResolved !== null && implBinSha !== null ? implBinResolved : null,
    implBinSha,
    tscVersion: text(meta.tscVersion),
    tscBin: text(meta.tscBin),
    expectationSource: text(meta.expectationSource),
    corpus: text(meta.corpus),
    corpusRef: text(meta.corpusRef),
    t3Comparable: text(meta.expectationSource) === "official-baseline",
    selectedCases: num(meta.selectedCases),
    ratchet: normalizeRatchet(meta),
    gate: normalizeGate(meta),
    totals: normalizeTotals(metrics, details),
    skips: countPairs(metrics.skips),
    fpByCode: countPairs(obj(metrics.byCode).fp),
    missByCode: countPairs(obj(metrics.byCode).miss),
    samples: normalizeSamples(metrics),
    details,
    detailsSource: data.source ?? null,
    delta: null,
    notes: options.notes ?? [],
  };
  model.delta = previous === null ? null : computeDelta(previous, model);
  return model;
}

// ---------------------------------------------------------------------------
// 与上次运行的 delta / 逐例回归
// ---------------------------------------------------------------------------

function metricRow(
  label: string,
  before: number | null,
  after: number | null,
  format: (n: number) => string,
  betterWhen: "up" | "down",
): MetricDeltaRow {
  if (before === null || after === null) {
    return { label, before: "n/a", after: "n/a", change: "n/a", trend: "na" };
  }
  const rawDelta = after - before;
  const trend = rawDelta === 0 ? "same" : (rawDelta > 0) === (betterWhen === "up") ? "better" : "worse";
  return {
    label,
    before: format(before),
    after: format(after),
    change: `${rawDelta > 0 ? "+" : ""}${format(rawDelta)}` + (trend === "same" ? "" : trend === "better" ? "（改善）" : "（变差）"),
    trend,
  };
}

const formatPctPoints = (n: number): string => `${(n * 100).toFixed(1)}pp`;

function computeDelta(previous: ReportModel, current: ReportModel): ReportDelta {
  const rows: MetricDeltaRow[] = [
    metricRow("覆盖率", previous.totals.coverage, current.totals.coverage, (n) => (n * 100).toFixed(1) + "%", "up"),
    metricRow("完全通过用例", previous.totals.passCases, current.totals.passCases, String, "up"),
    metricRow("假阳性用例", previous.totals.fpCases, current.totals.fpCases, String, "down"),
    metricRow("假阳性条数", previous.totals.fpTotal, current.totals.fpTotal, String, "down"),
    metricRow("漏报条数", previous.totals.missTotal, current.totals.missTotal, String, "down"),
    metricRow("错锚条数", previous.totals.misanchorTotal, current.totals.misanchorTotal, String, "down"),
    metricRow("跳过用例", previous.totals.skipped, current.totals.skipped, String, "down"),
  ];
  if (previous.totals.byTierKnown && current.totals.byTierKnown) {
    rows.push(metricRow("T3 全文用例", previous.totals.byTier.full, current.totals.byTier.full, String, "up"));
  }
  // 覆盖率变化用百分点展示更直观，覆盖掉上面的百分比差值文本。
  if (previous.totals.coverage !== null && current.totals.coverage !== null) {
    rows[0]!.change = formatPctPoints(current.totals.coverage - previous.totals.coverage);
  }

  const regressions: CaseMovement[] = [];
  const improvements: CaseMovement[] = [];
  const previousById = new Map(previous.details.map((d) => [d.id, d]));
  const currentById = new Map(current.details.map((d) => [d.id, d]));
  const tierRank = (tier: Tier | null): number => (tier === null ? -1 : TIERS.indexOf(tier));
  for (const id of [...previousById.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!currentById.has(id)) continue;
    const before = previousById.get(id)!;
    const after = currentById.get(id)!;
    if (before.status === "ran" && after.status === "skip") {
      regressions.push({ id, kind: "regression", detail: `不再运行：${after.skipReason ?? "unknown"}` });
      continue;
    }
    if (before.status === "skip" && after.status === "ran" && tierRank(after.tier) >= 0) {
      improvements.push({ id, kind: "improvement", detail: `恢复运行（${TIER_LABELS[after.tier!]}）` });
      continue;
    }
    if (before.status !== "ran" || after.status !== "ran") continue;
    const beforeRank = tierRank(before.tier);
    const afterRank = tierRank(after.tier);
    if (beforeRank >= 0 && afterRank >= 0 && afterRank < beforeRank) {
      regressions.push({
        id,
        kind: "regression",
        detail: `${TIER_LABELS[before.tier!]} → ${TIER_LABELS[after.tier!]}`,
      });
    } else if (beforeRank >= 0 && afterRank >= 0 && afterRank > beforeRank) {
      improvements.push({
        id,
        kind: "improvement",
        detail: `${TIER_LABELS[before.tier!]} → ${TIER_LABELS[after.tier!]}`,
      });
    } else if (after.fp > before.fp) {
      regressions.push({
        id,
        kind: "regression",
        detail: `假阳性 ${before.fp} → ${after.fp} 条`,
      });
    } else if (after.fp < before.fp) {
      improvements.push({ id, kind: "improvement", detail: `假阳性 ${before.fp} → ${after.fp} 条` });
    }
  }
  return {
    previousLabel: previous.generatedAt ?? previous.title,
    rows,
    regressions,
    improvements,
  };
}

// ---------------------------------------------------------------------------
// 摘要结构（Markdown / HTML 共用）
// ---------------------------------------------------------------------------

interface SummaryCard {
  label: string;
  value: string;
  note: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}

function summaryCards(model: ReportModel): SummaryCard[] {
  const t = model.totals;
  return [
    {
      label: "覆盖率",
      value: pct(t.coverage),
      note: `${t.hitTotal}/${t.expectTotal} 条期望诊断位置命中`,
      tone: t.coverage === null ? "neutral" : t.coverage >= 0.99 ? "ok" : t.coverage >= 0.9 ? "warn" : "bad",
    },
    {
      label: "假阳性",
      value: `${t.fpCases} 例 / ${t.fpTotal} 条`,
      note: "实现多报、官方期望没有的诊断",
      tone: t.fpTotal === 0 ? "ok" : "bad",
    },
    {
      label: "漏报",
      value: `${t.missTotal} 条`,
      note: "官方期望有、实现没报的诊断",
      tone: t.missTotal === 0 ? "ok" : "bad",
    },
    {
      label: "错锚",
      value: `${t.misanchorCases} 例 / ${t.misanchorTotal} 条`,
      note: "同文件同码、位置不同（单独统计，不计 fp/miss）",
      tone: t.misanchorTotal === 0 ? "ok" : "warn",
    },
    {
      label: "跳过",
      value: `${t.skipped} 例`,
      note: model.skips.length === 0 ? "没有跳过" : `主因：${model.skips[0]![0]} ×${model.skips[0]![1]}`,
      tone: t.skipped === 0 ? "ok" : "neutral",
    },
    {
      label: "完全通过",
      value: `${t.passCases}/${t.ran} 例`,
      note: "假阳性、漏报、错锚都为 0 的用例",
      tone: t.ran > 0 && t.passCases === t.ran ? "ok" : "warn",
    },
  ];
}

function gateConclusion(model: ReportModel): string {
  if (model.gate === null) return "本次运行未启用门禁（未传 `--gate`）";
  const failed = model.gate.checks.filter((c) => !c.ok).length;
  return model.gate.passed
    ? `门禁：通过（${model.gate.checks.length} 项检查全过）`
    : `门禁：失败（${failed}/${model.gate.checks.length} 项未过）`;
}

/** T0–T3 累计阶梯：达到「至少该档」的用例数与比例（分母 = 跑完的用例）。 */
interface LadderRow {
  tier: Tier;
  label: string;
  count: number;
  ratio: number | null;
}

function ladder(model: ReportModel): LadderRow[] {
  const t = model.totals;
  const cumulative: Record<Exclude<Tier, "none">, number> = {
    location: t.byTier.location + t.byTier.category + t.byTier.text + t.byTier.full,
    category: t.byTier.category + t.byTier.text + t.byTier.full,
    text: t.byTier.text + t.byTier.full,
    full: t.byTier.full,
  };
  return TIER_ORDER.map((tier) => ({
    tier,
    label: TIER_LABELS[tier],
    count: cumulative[tier],
    ratio: t.ran === 0 ? null : cumulative[tier] / t.ran,
  }));
}

/** 阶梯条形里用的确定性文本条（Markdown 用；HTML 用内联 SVG）。 */
function textBar(ratio: number | null, width = 20): string {
  if (ratio === null) return "";
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

interface FailureItem {
  id: string;
  detail: string;
}

function failingCases(model: ReportModel): FailureItem[] {
  const items: FailureItem[] = [];
  for (const detail of model.details) {
    if (detail.status === "skip") continue;
    const bad =
      detail.fp > 0 ||
      detail.missed > 0 ||
      detail.tier === "none" ||
      detail.tier === "location" ||
      detail.tier === "category";
    if (!bad) continue;
    const parts: string[] = [];
    if (detail.tier !== null) parts.push(TIER_LABELS[detail.tier]);
    if (detail.fp > 0) parts.push(`假阳性 ${detail.fp} 条`);
    if (detail.missed > 0) parts.push(`漏报 ${detail.missed} 条`);
    if (detail.fp === 0 && detail.missed === 0) parts.push("文案/全文差异");
    items.push({ id: detail.id, detail: parts.join("；") });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

interface RegressionCallout {
  gateFailed: GateReport["checks"];
  failing: FailureItem[];
  fpSamples: string[];
  missSamples: string[];
  t3Samples: string[];
  ratchetRegressions: number;
  deltaRegressions: CaseMovement[];
  /** metrics 级差异计数：没有 details.json 时也要能判断「有没有失败/回归」。 */
  fpTotal: number;
  missTotal: number;
  misanchorTotal: number;
  messageMismatch: number;
  hasT3Failures: boolean;
  /** false 表示产物里没有 details.json（只能用 metrics/samples 展示，不能逐例下钻）。 */
  detailsAvailable: boolean;
}

function calloutsOf(model: ReportModel): RegressionCallout {
  return {
    gateFailed: model.gate === null ? [] : model.gate.checks.filter((c) => !c.ok),
    failing: failingCases(model),
    fpSamples: model.samples.fp,
    missSamples: model.samples.miss,
    t3Samples: model.samples.t3,
    ratchetRegressions: model.ratchet?.regressions ?? 0,
    deltaRegressions: model.delta?.regressions ?? [],
    fpTotal: model.totals.fpTotal,
    missTotal: model.totals.missTotal,
    misanchorTotal: model.totals.misanchorTotal,
    messageMismatch: model.totals.messageMismatch,
    hasT3Failures: model.totals.t3Failures.length > 0,
    detailsAvailable: model.details.length > 0,
  };
}

function hasFailures(callouts: RegressionCallout): boolean {
  // 失败/回归不能只看 details 逐例列表：`--from` 只有 metrics.json（没有 details.json）时，
  // fp/漏报/错锚/文案差仍在 totals 与 samples 里，必须照样进入「失败与回归」。
  return (
    callouts.gateFailed.length > 0 ||
    callouts.failing.length > 0 ||
    callouts.ratchetRegressions > 0 ||
    callouts.deltaRegressions.length > 0 ||
    callouts.fpTotal > 0 ||
    callouts.missTotal > 0 ||
    callouts.misanchorTotal > 0 ||
    callouts.messageMismatch > 0 ||
    callouts.fpSamples.length > 0 ||
    callouts.missSamples.length > 0 ||
    callouts.t3Samples.length > 0 ||
    callouts.hasT3Failures
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const maxList = (items: string[], cap: number): string[] => {
  const shown = items.slice(0, cap);
  if (items.length > cap) shown.push(`…… 共 ${items.length} 条`);
  return shown;
};

function renderHeaderMd(model: ReportModel): string[] {
  const lines: string[] = [];
  const route: string[] = [];
  lines.push(`| 项 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 生成时间 | ${mdCell(model.generatedAt ?? "n/a")} |`);
  lines.push(`| 套件 / 模式 | ${mdCell(model.suite)} / ${mdCell(model.mode)}${model.verdictEligible ? "（可作兼容性结论）" : "（不可作兼容性结论）"} |`);
  lines.push(`| 基线 | ${mdCell(model.baseline ?? "n/a")} |`);
  const implBinPart =
    model.implBin !== null && model.implBinSha !== null
      ? ` · 二进制 ${mdCode(model.implBin)}（sha256 ${mdCode(model.implBinSha.slice(0, 12))}）`
      : "";
  lines.push(`| 实现 | ${mdCell(model.implName)}${implBinPart} |`);
  route.push(mdCell(model.expectationSource ?? "tsc"));
  if (model.tscVersion !== null) route.push(`tsc ${mdCode(model.tscVersion)}`);
  lines.push(`| 期望源 | ${route.join(" · ")} |`);
  const corpusPart = model.corpus === null ? "n/a" : mdCode(model.corpus);
  lines.push(`| 语料 | ${corpusPart}${model.corpusRef !== null ? `（pin ${mdCode(model.corpusRef)}）` : ""} |`);
  if (model.ratchet !== null) {
    const state = model.ratchet.initialized
      ? "首次登记"
      : `回落 ${model.ratchet.regressions} 例、改善 ${model.ratchet.improvements} 例`;
    lines.push(`| ratchet | ${mdCode(model.ratchet.path)}：${state} |`);
  }
  if (model.selectedCases !== null) {
    lines.push(
      `| 用例 | 选中 ${model.selectedCases} / 本次 ${model.totals.cases}：跑 ${model.totals.ran}，跳过 ${model.totals.skipped} |`,
    );
  } else {
    lines.push(`| 用例 | 本次 ${model.totals.cases}：跑 ${model.totals.ran}，跳过 ${model.totals.skipped} |`);
  }
  return lines;
}

function renderGateMd(model: ReportModel): string[] {
  const lines: string[] = [];
  if (model.gate === null) {
    lines.push(gateConclusion(model) + "。");
    return lines;
  }
  lines.push(gateConclusion(model));
  lines.push("");
  lines.push(`| 检查 | 结论 | 说明 |`);
  lines.push(`| --- | --- | --- |`);
  for (const check of model.gate.checks) {
    lines.push(`| ${mdCell(check.name)} | ${check.ok ? "通过" : "**失败**"} | ${mdCell(check.detail)} |`);
  }
  return lines;
}

function renderDeltaMd(model: ReportModel): string[] {
  const delta = model.delta;
  const lines: string[] = [];
  if (delta === null) {
    lines.push("没有提供上次运行数据（`--prev-report`），不计算 delta。");
    return lines;
  }
  lines.push(`对比基准：${mdCell(delta.previousLabel)}。`);
  lines.push("");
  lines.push(`| 指标 | 上次 | 本次 | 变化 |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const row of delta.rows) {
    lines.push(`| ${mdCell(row.label)} | ${mdCell(row.before)} | ${mdCell(row.after)} | ${mdCell(row.change)} |`);
  }
  const movementRows: string[] = [];
  for (const movement of delta.regressions.slice(0, 20)) {
    movementRows.push(`- **回归** ${mdCode(movement.id)}：${mdText(movement.detail)}`);
  }
  if (delta.regressions.length > 20) movementRows.push(`- …… 共 ${delta.regressions.length} 例回归`);
  for (const movement of delta.improvements.slice(0, 10)) {
    movementRows.push(`- 改善 ${mdCode(movement.id)}：${mdText(movement.detail)}`);
  }
  if (delta.improvements.length > 10) movementRows.push(`- …… 共 ${delta.improvements.length} 例改善`);
  if (movementRows.length > 0) {
    lines.push("");
    lines.push(`**逐例变化（${delta.regressions.length} 例回归 / ${delta.improvements.length} 例改善）**`);
    lines.push("");
    lines.push(...movementRows);
  }
  return lines;
}

function renderFailuresMd(model: ReportModel, callouts: RegressionCallout): string[] {
  const lines: string[] = [];
  if (!hasFailures(callouts)) {
    lines.push("未发现失败或回归。");
    return lines;
  }
  if (!callouts.detailsAvailable && (callouts.fpTotal > 0 || callouts.missTotal > 0 || callouts.misanchorTotal > 0)) {
    lines.push("> 本次产物里没有 `details.json`，无法逐例下钻；以下差异数字来自 `metrics.json` 的汇总与样例。");
    lines.push("");
  }
  if (callouts.gateFailed.length > 0) {
    lines.push(`**门禁失败项（${callouts.gateFailed.length}）**`);
    lines.push("");
    for (const check of callouts.gateFailed) {
      lines.push(`- ${mdText(check.name)}：${mdText(check.detail)}`);
    }
    lines.push("");
  }
  if (callouts.ratchetRegressions > 0) {
    lines.push(`**ratchet 回落 ${callouts.ratchetRegressions} 例**：清单 ${mdCode(model.ratchet!.path)} 出现档位下降，详见 stdout 与门禁明细。`);
    lines.push("");
  }
  if (callouts.deltaRegressions.length > 0) {
    lines.push(`**与上次相比回归 ${callouts.deltaRegressions.length} 例**`);
    lines.push("");
    for (const movement of callouts.deltaRegressions.slice(0, 20)) {
      lines.push(`- ${mdCode(movement.id)}：${mdText(movement.detail)}`);
    }
    if (callouts.deltaRegressions.length > 20) lines.push(`- …… 共 ${callouts.deltaRegressions.length} 例`);
    lines.push("");
  }
  if (callouts.failing.length > 0) {
    lines.push(`**未达 T2（文案）或存在差异的用例（${callouts.failing.length}）**`);
    lines.push("");
    for (const item of callouts.failing.slice(0, 20)) {
      lines.push(`- ${mdCode(item.id)}：${mdText(item.detail)}`);
    }
    if (callouts.failing.length > 20) lines.push(`- …… 共 ${callouts.failing.length} 例`);
    lines.push("");
  }
  if (callouts.fpSamples.length > 0) {
    lines.push("**假阳性样例**");
    lines.push("");
    for (const sample of callouts.fpSamples.slice(0, 10)) lines.push(`- ${mdCode(sample)}`);
    if (callouts.fpSamples.length > 10) lines.push(`- …… 共 ${callouts.fpSamples.length} 条样例`);
    lines.push("");
  }
  if (callouts.missSamples.length > 0) {
    lines.push("**漏报样例**");
    lines.push("");
    for (const sample of callouts.missSamples.slice(0, 10)) lines.push(`- ${mdCode(sample)}`);
    if (callouts.missSamples.length > 10) lines.push(`- …… 共 ${callouts.missSamples.length} 条样例`);
    lines.push("");
  }
  if (callouts.t3Samples.length > 0) {
    lines.push("**T3 未达样例**");
    lines.push("");
    for (const sample of callouts.t3Samples.slice(0, 10)) lines.push(`- ${mdCode(sample)}`);
    if (callouts.t3Samples.length > 10) lines.push(`- …… 共 ${callouts.t3Samples.length} 条样例`);
    lines.push("");
  } else if (callouts.hasT3Failures) {
    lines.push(
      `**T3 未达 ${model.totals.t3Failures.reduce((sum, [, n]) => sum + n, 0)} 例**：` +
        model.totals.t3Failures.map(([reason, n]) => `${mdCode(reason)} ×${n}`).join("、") +
        "（未保留样例）。",
    );
    lines.push("");
  }
  if (callouts.messageMismatch > 0) {
    lines.push(`**首行文案不同 ${callouts.messageMismatch} 条**：位置命中、文案不同（T1 与 T2 的差）。`);
    lines.push("");
  }
  return lines;
}

function renderTierMd(model: ReportModel): string[] {
  const lines: string[] = [];
  if (!model.totals.byTierKnown) {
    lines.push("本次运行的产物里没有 T0–T3 分档数据（旧版 metrics），阶梯不可用。");
    return lines;
  }
  lines.push(`达到「至少该档」的用例数（分母 = 跑完的 ${model.totals.ran} 例）：`);
  lines.push("");
  for (const row of ladder(model)) {
    lines.push(`- ${row.label}：${row.count} 例（${pct(row.ratio)}）　${textBar(row.ratio)}`);
  }
  lines.push("");
  lines.push(
    `恰好落在各档：${TIER_ORDER.map((tier) => `${TIER_LABELS[tier]} ${model.totals.byTier[tier]}`).join("，")}` +
      (model.totals.byTier.none > 0 ? `，未达 T0 ${model.totals.byTier.none}` : ""),
  );
  if (model.totals.t3Failures.length > 0) {
    lines.push("");
    lines.push(`T3 未达原因：${model.totals.t3Failures.map(([reason, n]) => `${mdCode(reason)} ×${n}`).join("、")}`);
  }
  if (!model.t3Comparable) {
    lines.push("");
    lines.push("> 注：本次期望源不是官方 `.errors.txt` 基线，T3 全文档只对无期望错误的用例成立（有错误的用例最多到 T2）；T0–T2 是门禁口径。");
  }
  return lines;
}

function renderCodesMd(title: string, pairs: [string, number][], cap = 15): string[] {
  if (pairs.length === 0) return [];
  const shown = pairs.slice(0, cap);
  return [`| ${title} | 条数 |`, `| --- | --- |`, ...shown.map(([code, n]) => `| ${mdCode(code)} | ${n} |`)];
}

export function renderMarkdown(model: ReportModel): string {
  const callouts = calloutsOf(model);
  const lines: string[] = [];
  lines.push(`# ${mdText(model.title)}`);
  lines.push("");
  lines.push(
    `> ${mdText(gateConclusion(model))}｜覆盖 ${pct(model.totals.coverage)}｜假阳性 ${model.totals.fpCases} 例 / ${model.totals.fpTotal} 条｜漏报 ${model.totals.missTotal}｜错锚 ${model.totals.misanchorTotal}｜跳过 ${model.totals.skipped}`,
  );
  lines.push("");
  lines.push("## 运行信息");
  lines.push("");
  lines.push(...renderHeaderMd(model));
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(`| 指标 | 值 | 说明 |`);
  lines.push(`| --- | --- | --- |`);
  for (const card of summaryCards(model)) {
    lines.push(`| ${mdCell(card.label)} | ${mdCell(card.value)} | ${mdCell(card.note)} |`);
  }
  lines.push("");
  lines.push("## T0–T3 阶梯");
  lines.push("");
  lines.push(...renderTierMd(model));
  lines.push("");
  lines.push("## 门禁结论");
  lines.push("");
  lines.push(...renderGateMd(model));
  lines.push("");
  lines.push("## 与上次报告对比");
  lines.push("");
  lines.push(...renderDeltaMd(model));
  lines.push("");
  lines.push("## 失败与回归");
  lines.push("");
  lines.push(...renderFailuresMd(model, callouts));
  const codeSections = [renderCodesMd("假阳性错误码", model.fpByCode), renderCodesMd("漏报错误码", model.missByCode)].filter(
    (section) => section.length > 0,
  );
  if (codeSections.length > 0) {
    lines.push("");
    lines.push("## 错误码分布");
    for (const section of codeSections) {
      lines.push("");
      lines.push(...section);
    }
  }
  if (model.skips.length > 0) {
    lines.push("");
    lines.push("## 跳过分类");
    lines.push("");
    lines.push(`| 原因 | 例数 |`);
    lines.push(`| --- | --- |`);
    for (const [reason, n] of model.skips) lines.push(`| ${mdText(reason)} | ${n} |`);
  }
  if (model.totals.messageMismatch > 0) {
    lines.push("");
    lines.push(`另有 ${model.totals.messageMismatch} 条诊断位置命中但首行文案不同（T1 与 T2 的差）。`);
  }
  if (model.notes.length > 0) {
    lines.push("");
    lines.push("## 说明");
    lines.push("");
    for (const note of model.notes) lines.push(`- ${mdText(note)}`);
  }
  lines.push("");
  lines.push(
    `数据来源：${model.detailsSource !== null ? mdCode(model.detailsSource) : "metrics.json"}；` +
      "由 `bun src/run.ts --report-md --report-html` 或 `bun src/report.ts` 生成。",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// HTML（自包含：内联 CSS + 内联 SVG）
// ---------------------------------------------------------------------------

export const REPORT_CSS = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0;
  --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --accent: #0969da; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --line: #3d444d;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #4493f8; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "PingFang SC", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 20px 48px; }
h1 { font-size: 24px; margin: 8px 0 12px; }
h2 { font-size: 18px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
p { margin: 8px 0; }
.muted { color: var(--muted); }
.verdict { border-left: 4px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent);
  padding: 10px 14px; margin: 12px 0; border-radius: 4px; }
.verdict.bad { border-left-color: var(--bad); background: color-mix(in srgb, var(--bad) 10%, transparent); }
.verdict.ok { border-left-color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 12px 0; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
.card .label { color: var(--muted); font-size: 12px; }
.card .value { font-size: 18px; font-weight: 600; margin: 2px 0; }
.card .note { color: var(--muted); font-size: 12px; }
.card.ok .value { color: var(--ok); } .card.warn .value { color: var(--warn); } .card.bad .value { color: var(--bad); }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 14px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.status-ok { color: var(--ok); font-weight: 600; } .status-bad { color: var(--bad); font-weight: 600; }
.chip { display: inline-block; padding: 0 6px; border: 1px solid var(--line); border-radius: 10px; font-size: 12px; }
.better { color: var(--ok); } .worse { color: var(--bad); } .same { color: var(--muted); }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 0 4px; border-radius: 4px; }
ul { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
.note { color: var(--muted); font-size: 13px; }
svg { display: block; margin: 8px 0; }
footer { margin-top: 32px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
`.trim();

function htmlTable(headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function htmlCards(model: ReportModel): string {
  const cards = summaryCards(model)
    .map(
      (card) =>
        `<div class="card ${card.tone}"><div class="label">${escapeHtml(card.label)}</div>` +
        `<div class="value">${escapeHtml(card.value)}</div><div class="note">${escapeHtml(card.note)}</div></div>`,
    )
    .join("\n");
  return `<div class="cards">\n${cards}\n</div>`;
}

/** T0–T3 阶梯：内联 SVG 横条（宽 = 达到该档的用例比例；右侧标数）。 */
function tierSvg(model: ReportModel): string {
  const rows = ladder(model);
  const barWidth = 420;
  const barHeight = 18;
  const rowHeight = 36;
  const left = 92;
  const top = 14;
  const width = left + barWidth + 90;
  const height = top + rows.length * rowHeight;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `role="img" aria-label="T0 到 T3 一致性阶梯">`,
    `<title>T0–T3 一致性阶梯</title>`,
  ];
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="none"/>`);
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    const ratio = row.ratio ?? 0;
    const filled = Math.round(ratio * barWidth);
    const color = row.tier === "full" ? "#1a7f37" : row.tier === "text" ? "#0969da" : row.tier === "category" ? "#8250df" : "#9a6700";
    parts.push(
      `<text x="0" y="${y + 13}" font-size="12" fill="currentColor">${escapeHtml(row.label)}</text>`,
      `<rect x="${left}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="#d1d9e0" opacity="0.45"/>`,
      `<rect x="${left}" y="${y}" width="${filled}" height="${barHeight}" rx="3" fill="${color}"/>`,
      `<text x="${left + barWidth + 8}" y="${y + 13}" font-size="12" fill="currentColor">${row.count} 例 · ${pct(row.ratio)}</text>`,
    );
  });
  parts.push("</svg>");
  return parts.join("\n");
}

function renderGateHtml(model: ReportModel): string {
  if (model.gate === null) return `<p>${escapeHtml(gateConclusion(model))}。</p>`;
  const rows = model.gate.checks
    .map(
      (check) =>
        `<tr><td>${escapeHtml(check.name)}</td><td class="${check.ok ? "status-ok" : "status-bad"}">${
          check.ok ? "通过" : "失败"
        }</td><td>${escapeHtml(check.detail)}</td></tr>`,
    )
    .join("\n");
  return (
    `<table>\n<thead><tr><th>检查</th><th>结论</th><th>说明</th></tr></thead>\n` +
    `<tbody>\n${rows}\n</tbody>\n</table>`
  );
}

function renderDeltaHtml(model: ReportModel): string {
  const delta = model.delta;
  if (delta === null) return `<p>没有提供上次运行数据（<code>--prev-report</code>），不计算 delta。</p>`;
  const rows = delta.rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.before)}</td><td>${escapeHtml(row.after)}</td>` +
        `<td class="${row.trend === "better" ? "better" : row.trend === "worse" ? "worse" : "same"}">${escapeHtml(row.change)}</td></tr>`,
    )
    .join("\n");
  const movement = (kind: "regressions" | "improvements", label: string): string => {
    const items = delta[kind];
    if (items.length === 0) return "";
    const shown = items
      .slice(0, 20)
      .map((m) => `<li><code>${escapeHtml(m.id)}</code>：${escapeHtml(m.detail)}</li>`)
      .join("\n");
    const tail = items.length > 20 ? `<li>…… 共 ${items.length} 例</li>` : "";
    return `<p><strong>${escapeHtml(label)}（${items.length}）</strong></p>\n<ul>\n${shown}\n${tail}\n</ul>`;
  };
  return (
    `<p class="note">对比基准：${escapeHtml(delta.previousLabel)}</p>\n` +
    `<table>\n<thead><tr><th>指标</th><th>上次</th><th>本次</th><th>变化</th></tr></thead>\n` +
    `<tbody>\n${rows}\n</tbody>\n</table>\n` +
    movement("regressions", "回归") +
    movement("improvements", "改善")
  );
}

function renderFailuresHtml(model: ReportModel, callouts: RegressionCallout): string {
  if (!hasFailures(callouts)) return "<p>未发现失败或回归。</p>";
  const blocks: string[] = [];
  if (!callouts.detailsAvailable && (callouts.fpTotal > 0 || callouts.missTotal > 0 || callouts.misanchorTotal > 0)) {
    blocks.push(
      "<p class=\"note\">本次产物里没有 <code>details.json</code>，无法逐例下钻；" +
        "以下差异数字来自 <code>metrics.json</code> 的汇总与样例。</p>",
    );
  }
  const ul = (items: string[], cap = 20): string => {
    const shown = items
      .slice(0, cap)
      .map((item) => `<li>${item}</li>`)
      .join("\n");
    const tail = items.length > cap ? `\n<li>…… 共 ${items.length} 条</li>` : "";
    return `<ul>\n${shown}${tail}\n</ul>`;
  };
  if (callouts.gateFailed.length > 0) {
    blocks.push(
      `<p><strong>门禁失败项（${callouts.gateFailed.length}）</strong></p>\n` +
        ul(callouts.gateFailed.map((c) => `${escapeHtml(c.name)}：${escapeHtml(c.detail)}`)),
    );
  }
  if (callouts.ratchetRegressions > 0) {
    blocks.push(
      `<p><strong>ratchet 回落 ${callouts.ratchetRegressions} 例</strong>：清单出现档位下降，详见 stdout 与门禁明细。</p>`,
    );
  }
  if (callouts.deltaRegressions.length > 0) {
    blocks.push(
      `<p><strong>与上次相比回归（${callouts.deltaRegressions.length}）</strong></p>\n` +
        ul(callouts.deltaRegressions.map((m) => `<code>${escapeHtml(m.id)}</code>：${escapeHtml(m.detail)}`)),
    );
  }
  if (callouts.failing.length > 0) {
    blocks.push(
      `<p><strong>未达 T2（文案）或存在差异的用例（${callouts.failing.length}）</strong></p>\n` +
        ul(callouts.failing.map((item) => `<code>${escapeHtml(item.id)}</code>：${escapeHtml(item.detail)}`)),
    );
  }
  const sampleBlocks = (label: string, samples: string[], code: boolean): void => {
    if (samples.length === 0) return;
    blocks.push(
      `<p><strong>${escapeHtml(label)}</strong></p>\n` +
        ul(samples.map((sample) => (code ? `<code>${escapeHtml(sample)}</code>` : escapeHtml(sample))), 10),
    );
  };
  sampleBlocks("假阳性样例", callouts.fpSamples, true);
  sampleBlocks("漏报样例", callouts.missSamples, true);
  sampleBlocks("T3 未达样例", callouts.t3Samples, true);
  if (callouts.t3Samples.length === 0 && callouts.hasT3Failures) {
    const total = model.totals.t3Failures.reduce((sum, [, n]) => sum + n, 0);
    const reasons = model.totals.t3Failures
      .map(([reason, n]) => `<code>${escapeHtml(reason)}</code> ×${n}`)
      .join("、");
    blocks.push(`<p><strong>T3 未达 ${total} 例</strong>：${reasons}（未保留样例）。</p>`);
  }
  if (callouts.messageMismatch > 0) {
    blocks.push(
      `<p><strong>首行文案不同 ${callouts.messageMismatch} 条</strong>：位置命中、文案不同（T1 与 T2 的差）。</p>`,
    );
  }
  return blocks.join("\n");
}

function renderTierHtml(model: ReportModel): string {
  if (!model.totals.byTierKnown) {
    return '<p class="note">本次运行的产物里没有 T0–T3 分档数据（旧版 metrics），阶梯不可用。</p>';
  }
  const exact = TIER_ORDER.map((tier) => `${TIER_LABELS[tier]} ${model.totals.byTier[tier]}`).join("，");
  const none = model.totals.byTier.none > 0 ? `，未达 T0 ${model.totals.byTier.none}` : "";
  const t3 =
    model.totals.t3Failures.length > 0
      ? `<p>${escapeHtml("T3 未达原因：")}${model.totals.t3Failures
          .map(([reason, n]) => `<code>${escapeHtml(reason)}</code> ×${n}`)
          .join("、")}</p>`
      : "";
  const t3Note = model.t3Comparable
    ? ""
    : `<p class="note">注：本次期望源不是官方 <code>.errors.txt</code> 基线，T3 全文档只对无期望错误的用例成立（有错误的用例最多到 T2）；T0–T2 是门禁口径。</p>\n`;
  return (
    `<p class="note">达到「至少该档」的用例数（分母 = 跑完的 ${model.totals.ran} 例）。</p>\n` +
    tierSvg(model) +
    `\n<p>恰好落在各档：${escapeHtml(exact + none)}</p>\n` +
    t3 +
    t3Note
  );
}

export function renderHtml(model: ReportModel): string {
  const callouts = calloutsOf(model);
  const failed = model.gate !== null && !model.gate.passed;
  const verdictClass = model.gate === null ? "" : failed ? " bad" : " ok";
  const route: string[] = [];
  if (model.expectationSource !== null) route.push(model.expectationSource);
  if (model.tscVersion !== null) route.push(`tsc ${model.tscVersion}`);
  const headerRows: string[][] = [
    ["生成时间", model.generatedAt ?? "n/a"],
    ["套件 / 模式", `${model.suite} / ${model.mode}${model.verdictEligible ? "（可作兼容性结论）" : "（不可作兼容性结论）"}`],
    ["基线", model.baseline ?? "n/a"],
    [
      "实现",
      `${model.implName}` +
        (model.implBin !== null && model.implBinSha !== null
          ? ` · ${model.implBin}（sha256 ${model.implBinSha.slice(0, 12)}）`
          : ""),
    ],
    ["期望源", route.length > 0 ? route.join(" · ") : "n/a"],
    ["语料", model.corpus === null ? "n/a" : `${model.corpus}${model.corpusRef !== null ? `（pin ${model.corpusRef}）` : ""}`],
  ];
  if (model.ratchet !== null) {
    headerRows.push([
      "ratchet",
      `${model.ratchet.path}：` +
        (model.ratchet.initialized
          ? "首次登记"
          : `回落 ${model.ratchet.regressions} 例、改善 ${model.ratchet.improvements} 例`),
    ]);
  }
  headerRows.push([
    "用例",
    `本次 ${model.totals.cases}：跑 ${model.totals.ran}，跳过 ${model.totals.skipped}` +
      (model.selectedCases !== null ? `；选中 ${model.selectedCases}` : ""),
  ]);

  const sections: string[] = [];
  sections.push(`<h1>${escapeHtml(model.title)}</h1>`);
  sections.push(
    `<div class="verdict${verdictClass}"><strong>${escapeHtml(gateConclusion(model))}</strong>` +
      `<br>覆盖 ${escapeHtml(pct(model.totals.coverage))}｜假阳性 ${model.totals.fpCases} 例 / ${model.totals.fpTotal} 条` +
      `｜漏报 ${model.totals.missTotal}｜错锚 ${model.totals.misanchorTotal}｜跳过 ${model.totals.skipped}</div>`,
  );
  sections.push(`<h2>运行信息</h2>\n${htmlTable(["项", "值"], headerRows)}`);
  sections.push(`<h2>摘要</h2>\n${htmlCards(model)}`);
  sections.push(`<h2>T0–T3 阶梯</h2>\n${renderTierHtml(model)}`);
  sections.push(`<h2>门禁结论</h2>\n${renderGateHtml(model)}`);
  sections.push(`<h2>与上次报告对比</h2>\n${renderDeltaHtml(model)}`);
  sections.push(`<h2>失败与回归</h2>\n${renderFailuresHtml(model, callouts)}`);
  if (model.fpByCode.length > 0 || model.missByCode.length > 0) {
    const blocks: string[] = [];
    if (model.fpByCode.length > 0) {
      blocks.push(htmlTable(["假阳性错误码", "条数"], model.fpByCode.slice(0, 15).map(([c, n]) => [c, String(n)])));
    }
    if (model.missByCode.length > 0) {
      blocks.push(htmlTable(["漏报错误码", "条数"], model.missByCode.slice(0, 15).map(([c, n]) => [c, String(n)])));
    }
    sections.push(`<h2>错误码分布</h2>\n${blocks.join("\n")}`);
  }
  if (model.skips.length > 0) {
    sections.push(`<h2>跳过分类</h2>\n${htmlTable(["原因", "例数"], model.skips.map(([r, n]) => [r, String(n)]))}`);
  }
  if (model.totals.messageMismatch > 0) {
    sections.push(
      `<p class="note">另有 ${model.totals.messageMismatch} 条诊断位置命中但首行文案不同（T1 与 T2 的差）。</p>`,
    );
  }
  if (model.notes.length > 0) {
    sections.push(`<h2>说明</h2>\n<ul>\n${model.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("\n")}\n</ul>`);
  }
  sections.push(
    `<footer>数据来源：${escapeHtml(model.detailsSource ?? "metrics.json")}；由 tsc-compa 报告模块生成（<code>bun src/run.ts --report-md --report-html</code> 或 <code>bun src/report.ts</code>）。</footer>`,
  );

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(model.title)}</title>`,
    `<style>\n${REPORT_CSS}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    ...sections,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 入口：从运行数据生成 Markdown + HTML
// ---------------------------------------------------------------------------

export function generateReport(data: RunData, options: ReportOptions = {}): GeneratedReport {
  const previous = options.previous !== undefined && options.previous !== null
    ? normalizeModel(options.previous, { ...options, previous: null }, null)
    : null;
  const model = normalizeModel(data, options, previous);
  return { markdown: renderMarkdown(model), html: renderHtml(model) };
}

/** 默认上次运行数据：`<dir>/prev/metrics.json`（与 run.ts 的默认约定一致）。 */
function defaultPreviousPath(from: string): string | null {
  let base = resolve(from);
  try {
    if (!statSync(base).isDirectory()) base = dirname(base);
  } catch {
    return null;
  }
  const candidate = join(base, "prev", "metrics.json");
  return existsSync(candidate) ? candidate : null;
}

/**
 * 读 metrics.json（+ 同目录 details.json）；不存在返回 null（调用方决定出占位报告还是报错）。
 * source 保留调用方给的路径写法（不强行绝对化），这样在「同一目录、同一份 prev、
 * 没有显式 --prev-report」时，`run.ts` 内直接写的报告与事后
 * `report.ts --from <同一目录>` 重生成的报告逐字节一致。
 */
export function readRunData(path: string): RunData | null {
  const resolved = resolve(path);
  let metricsPath = resolved;
  let source = dirname(path);
  try {
    if (statSync(resolved).isDirectory()) {
      metricsPath = join(resolved, "metrics.json");
      source = path;
    }
  } catch {
    return null;
  }
  if (!existsSync(metricsPath)) return null;
  const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as unknown;
  let details: unknown = [];
  const detailsPath = join(dirname(metricsPath), "details.json");
  if (existsSync(detailsPath)) details = JSON.parse(readFileSync(detailsPath, "utf8")) as unknown;
  return { metrics, details, source };
}

/** 指标缺失时的失败占位报告（套件在写出 metrics 之前就挂了，CI 仍要有 artifact）。 */
function missingReport(from: string, options: ReportOptions): GeneratedReport {
  const title = options.title ?? "tsc-compa 兼容性报告 — 数据缺失";
  const reason = `没有找到本次运行的 metrics.json（${join(resolve(from), "metrics.json")}）：套件可能在写出结果前就失败或被取消了。`;
  const hint = "请查看本次 CI run 里该档位的运行日志；metrics 写出后把 --from 指向同一个输出目录重跑 bun src/report.ts 即可补齐报告。";
  const markdown = [
    `# ${mdText(title)}`,
    "",
    `> **失败占位报告**：${mdText(reason)}`,
    "",
    "排查建议：",
    "",
    `- ${mdText(hint)}`,
    "",
    `数据来源：${mdCode(resolve(from))}；由 \`bun src/report.ts\` 生成。`,
    "",
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${REPORT_CSS}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="verdict bad"><strong>失败占位报告</strong><br>${escapeHtml(reason)}</div>`,
    "<h2>排查建议</h2>",
    `<ul><li>${escapeHtml(hint)}</li></ul>`,
    `<footer>数据来源：${escapeHtml(resolve(from))}；由 tsc-compa 报告模块生成。</footer>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { markdown, html };
}

/** 生成报告并写盘；返回实际写出的路径。写盘失败直接抛（调用方非零退出）。 */
export function writeReport(
  target: { md?: string; html?: string },
  data: RunData | null,
  options: ReportOptions = {},
  from = ".cache/run",
): { md?: string; html?: string } {
  const report = data === null ? missingReport(from, options) : generateReport(data, options);
  const written: { md?: string; html?: string } = {};
  if (target.md !== undefined) {
    mkdirSync(dirname(resolve(target.md)), { recursive: true });
    writeFileSync(target.md, report.markdown);
    written.md = target.md;
  }
  if (target.html !== undefined) {
    mkdirSync(dirname(resolve(target.html)), { recursive: true });
    writeFileSync(target.html, report.html);
    written.html = target.html;
  }
  return written;
}

// ---------------------------------------------------------------------------
// CLI：standalone 报告生成（CI 兜底 / 本地从旧产物补报告）
// ---------------------------------------------------------------------------

interface ReportCliArgs {
  from: string;
  md?: string;
  html?: string;
  out?: string;
  prevReport?: string;
  implName?: string;
  implBin?: string;
  title?: string;
  requireMetrics: boolean;
}

function parseReportArgs(argv: string[]): ReportCliArgs {
  const args: ReportCliArgs = { from: ".cache/run", requireMetrics: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    switch (arg) {
      case "--from":
        args.from = next();
        break;
      case "--md":
        args.md = next();
        break;
      case "--html":
        args.html = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--prev-report":
        args.prevReport = next();
        break;
      case "--impl-name":
        args.implName = next();
        break;
      case "--impl-bin":
        args.implBin = next();
        break;
      case "--title":
        args.title = next();
        break;
      case "--require-metrics":
        args.requireMetrics = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "用法：bun src/report.ts [--from <运行输出目录>] [--md <path>] [--html <path>] [--out <dir>] " +
            "[--prev-report <上次 metrics.json 或运行目录；缺省读 <from>/prev/metrics.json>] " +
            "[--impl-name <显示名>] [--impl-bin <二进制路径>] " +
            "[--title <标题>] [--require-metrics]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  if (args.md === undefined && args.html === undefined && args.out === undefined) {
    throw new Error("至少给出 --md / --html / --out 之一");
  }
  if (args.out !== undefined) {
    args.md ??= join(args.out, REPORT_MD_FILENAME);
    args.html ??= join(args.out, REPORT_HTML_FILENAME);
  }
  return args;
}

function main(): void {
  const args = parseReportArgs(process.argv.slice(2));
  const data = readRunData(args.from);
  if (data === null && args.requireMetrics) {
    throw new Error(`没有找到运行结果：${resolve(args.from)}/metrics.json`);
  }
  if (data === null) {
    console.warn(`警告：没有找到 ${resolve(args.from)}/metrics.json，生成失败占位报告。`);
  }
  // 与 run.ts 一致：没显式给 --prev-report 时默认读 <运行输出目录>/prev/metrics.json；
  // 显式给了但读不到则报错（否则 delta 会静默消失）。
  let prevReport = null;
  if (args.prevReport !== undefined) {
    prevReport = readRunData(args.prevReport);
    if (prevReport === null) throw new Error(`--prev-report 找不到可读的运行结果：${args.prevReport}`);
  } else {
    const defaultPrevious = defaultPreviousPath(args.from);
    if (defaultPrevious !== null) prevReport = readRunData(defaultPrevious);
  }
  const written = writeReport(
    { md: args.md, html: args.html },
    data,
    {
      implName: args.implName,
      implBin: args.implBin,
      title: args.title,
      previous: prevReport,
    },
    args.from,
  );
  if (written.md !== undefined) console.log(`报告（Markdown）：${written.md}`);
  if (written.html !== undefined) console.log(`报告（HTML）：${written.html}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
