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
import {
  comparisonFields,
  diagnosticFields,
  type ComparisonField,
  type DiagnosticComparison,
  type DiagnosticMatch,
  type FieldStatus,
  type Verdict,
} from "./comparison.ts";
import type { GateReport } from "./gate.ts";
import type { CompilerOption, Diagnostic } from "./types.ts";

export const REPORT_MD_FILENAME = "report.md";
export const REPORT_HTML_FILENAME = "report.html";

export const FIELD_LABELS: Record<ComparisonField, string> = {
  code: "诊断码（等价码差异）",
  severity: "严重级别",
  location: "主诊断位置",
  width: "标记范围",
  message: "首行文字",
  messageChain: "消息链",
  related: "related 信息",
  attributes: "其他诊断属性",
  count: "诊断数量",
  order: "输出顺序",
  output: "完整输出",
};

const FIELD_STATUS_LABELS: Record<FieldStatus, string> = {
  equal: "相同",
  different: "不同",
  unavailable: "未提供",
};

const FIELD_SHORT_LABELS: Record<ComparisonField, string> = {
  code: "诊断码",
  severity: "严重级别",
  location: "位置",
  width: "标记范围",
  message: "首行文字",
  messageChain: "消息链",
  related: "related",
  attributes: "其他属性",
  count: "数量",
  order: "顺序",
  output: "输出",
};

const FIELD_ORDER: readonly ComparisonField[] = [
  "message", "location", "code", "severity", "width", "messageChain", "related", "attributes", "count", "order", "output",
];

const VERDICT_LABELS: Record<Verdict, string> = {
  pass: "通过",
  fail: "失败",
  unknown: "无法确认",
};

/** 报告侧比较结果：新契约字段必选，读取旧 details 时由 normalize 补空值。 */
export type CaseComparison = DiagnosticComparison;

export interface VerdictCounts {
  pass: number | null;
  fail: number | null;
  unknown: number | null;
  known: boolean;
}

/** 已知分布时的非空计数；用于展示层，避免在 known 分支里反复断言 null。 */
type KnownVerdictCounts = { pass: number; fail: number; unknown: number; known: true };

function knownVerdicts(counts: VerdictCounts): KnownVerdictCounts | null {
  if (!counts.known || counts.pass === null || counts.fail === null || counts.unknown === null) return null;
  return { pass: counts.pass, fail: counts.fail, unknown: counts.unknown, known: true };
}

function verdictCountText(counts: KnownVerdictCounts): string {
  return `通过 ${counts.pass} / 失败 ${counts.fail} / 无法确认 ${counts.unknown}`;
}

function verdictToneOf(counts: KnownVerdictCounts): "ok" | "warn" | "bad" {
  return counts.fail > 0 ? "bad" : counts.unknown > 0 ? "warn" : "ok";
}

export interface FieldCounts {
  equal: number | null;
  different: number | null;
  unavailable: number | null;
  known: boolean;
}

export interface ComparisonSummary {
  compatibility: VerdictCounts;
  strict: VerdictCounts;
  fields: Partial<Record<ComparisonField, FieldCounts>>;
  known: boolean;
}

/** 新报告的主视图标记：metrics.comparison 或逐案 comparison 至少出现一个。 */
export const hasNewComparison = (model: ReportModel): boolean => model.comparison.known;

/** details.json 的一条用例记录（字段与 src/run.ts 写出口径一致）。 */
export interface CaseDetail {
  id: string;
  status: "ran" | "skip";
  skipReason: string | null;
  className: string[];
  /** 兼容旧 details 的计数；新 details 的 expected/actual 是完整诊断数组。 */
  expected: number;
  actual: number;
  expectedDiagnostics: Diagnostic[] | null;
  actualDiagnostics: Diagnostic[] | null;
  hits: number;
  fp: number;
  missed: number;
  misanchor: number;
  tier: Tier | null;
  comparison: CaseComparison | null;
  expectedExitCode: number | null;
  actualExitCode: number | null;
  expectedOutput: string | null;
  actualOutput: string | null;
  options: CompilerOption[];
  expectedArgs: string[] | null;
  actualArgs: string[] | null;
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
  // 兼容 metrics.perf.sample.composition 的对象形态：{ "suite:compiler": 3, clean: 5 }。
  if (isObject(v)) {
    for (const [name, value] of Object.entries(v)) {
      const count = num(value);
      if (count !== null && count > 0) pairs.push([name, count]);
    }
  }
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
  // 表格里的行内代码同样要把竖线转义；否则 `a|b` 会把单元格拆开。
  const text = value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const runs: string[] = text.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max: number, run: string) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  // 内容以反引号开头/结尾时，CommonMark 要求围栏两侧补一个空格才不会被吞。
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** 多行代码块：保留换行，围栏长度随内容变化，并把 HTML 起始符转成实体。 */
function mdCodeBlock(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const runs: string[] = normalized.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}\n${normalized}\n${fence}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 范围变化提示同时用于 Markdown/HTML；复现后不再把差异归因成检查器行为。 */
const SCOPE_WARNING =
  "比较范围或参考期望不同：两档、字段与逐例差异只作参照，不能据此认定检查器回归。";

function scopeWarningLines(delta: ReportDelta | null): string[] {
  if (delta === null || delta.scope.comparable || delta.scope.reasons.length === 0) return [];
  return [
    `> **范围提示**：${mdText(SCOPE_WARNING)}原因：${delta.scope.reasons.map(mdText).join("；")}。`,
  ];
}

function scopeWarningText(delta: ReportDelta): string {
  return `${SCOPE_WARNING}原因：${delta.scope.reasons.join("；")}。`;
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
  profile: "compatibility" | "strict" | null;
  blockingRegressions: number | null;
  regressionDetails: RatchetRegressionInfo[];
  legacy: boolean;
}

export interface RatchetRegressionInfo {
  id: string;
  kind: "compatibility" | "strict" | "field";
  field: string | null;
  was: string;
  now: string;
  reasonKind: string | null;
  reason: string;
  /** 新契约必带；旧数据缺 blocking 时由 profile + kind 恢复。 */
  blocking: boolean;
}

export interface GateNoteInfo {
  name: string;
  detail: string;
}

/** meta 里的来源/运行参数；只展示确有内容的字段，旧报告自然退化为未提供。 */
export interface RunProvenance {
  manifest: string | null;
  manifestSha: string | null;
  /** 用例选择后的 id 集合哈希；范围相同时即使 manifest 文件字节变化也可比较。 */
  selectedIdsSha: string | null;
  /** 精确选择的源文件与配置集合哈希；未使用精确选择时不提供。 */
  selectedTargetsSha: string | null;
  /** 解析后的用例输入哈希，覆盖用例正文与指令。 */
  parsedInputsSha: string | null;
  /** 官方 .errors.txt 输入哈希；变化时参考期望本身也不同。 */
  officialInputsSha: string | null;
  /** 原始选项策略（defaults / aligned），用于跨报告判断范围是否可对照。 */
  optionStrategy: "defaults" | "aligned" | null;
  optionPolicy: string | null;
  runArgs: string[];
  adapter: string | null;
  referenceBaseArgs: string[];
  sharedArgs: string[];
  candidateArgs: string[];
  candidateEnvArgs: string[];
  filters: string[];
  runner: string | null;
  platform: string | null;
  reference: {
    version: string | null;
    bin: string | null;
    sha256: string | null;
    nativeBin: string | null;
    nativeSha256: string | null;
    source: string | null;
    corpus: string | null;
    corpusRef: string | null;
  };
  candidate: {
    name: string | null;
    bin: string | null;
    version: string | null;
    sha256: string | null;
    nativeBin: string | null;
    nativeSha256: string | null;
    embeddedTypeScript: string | null;
    sdk: { module: string | null; path: string | null; version: string | null; sha256: string | null };
    source: string | null;
  };
}

export interface PerfAggregate {
  n: number;
  median: number;
  geomean: number;
  p25: number;
  p75: number;
}

/** metrics.perf 的报告侧视图；缺字段全部退化为未提供。 */
export interface PerfInfo {
  metric: "check" | "wall-adjusted" | null;
  seed: string | null;
  requested: number | null;
  size: number | null;
  referenceOk: number | null;
  referenceFailed: number | null;
  composition: { suite: [string, number][]; lineBucket: [string, number][]; errorPresence: [string, number][]; order: [string, number][] };
  ratio: {
    check: number | null;
    wallAdjusted: number | null;
    /** 原始 wall-clock 比值；可选字段，旧产物没有时为 null。 */
    wall: number | null;
    agreementCases: number | null;
    agreementImplWallMs: number | null;
    agreementReferenceWallMs: number | null;
    agreementWall: number | null;
    agreementCheck: number | null;
    agreementWallAdjusted: number | null;
  };
  perCase: { check: PerfAggregate | null; wallAdjusted: PerfAggregate | null };
  impl: { meanWallMs: number | null; emptyBaselineMs: number | null; checkSumMs: number | null };
  reference: { meanWallMs: number | null; emptyBaselineMs: number | null; checkSumMs: number | null; parseSumMs: number | null; bindSumMs: number | null };
  warnings: string[];
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
  provenance: RunProvenance;
  /** T3 全文档是否可比：只有期望源是官方 .errors.txt 基线时才成立（否则有错误的用例最多到 T2）。 */
  t3Comparable: boolean;
  selectedCases: number | null;
  ratchet: RatchetInfo | null;
  gate: GateReport | null;
  /** metrics.meta.gate.reported：不参与 passed 判定的简短摘要。 */
  gateReported: GateNoteInfo[];
  totals: ReportTotals;
  comparison: ComparisonSummary;
  perf: PerfInfo | null;
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

/** `--prev-report` 的范围对照结果。只有 v2 ↔ v2 才计算两档/字段回归。 */
export interface DeltaScope {
  v2: boolean;
  comparable: boolean;
  reasons: string[];
}

export interface FieldDeltaRow {
  field: ComparisonField;
  before: { equal: number; different: number; unavailable: number };
  after: { equal: number; different: number; unavailable: number };
  change: string;
  trend: "better" | "worse" | "same" | "na";
}

export interface ReportDelta {
  previousLabel: string;
  rows: MetricDeltaRow[];
  regressions: CaseMovement[];
  improvements: CaseMovement[];
  /** 比较范围是否可对照；旧版产物仍走原来的 T0–T3 delta。 */
  scope: DeltaScope;
  /** v2 字段汇总变化；旧版产物为空。 */
  fields: FieldDeltaRow[];
}

function normalizeDetails(v: unknown, source: string | null): CaseDetail[] {
  const details: CaseDetail[] = [];
  for (const item of list(v)) {
    if (!isObject(item)) continue;
    const id = text(item.id);
    if (id === null) continue;
    const status = item.status === "skip" ? "skip" : "ran";
    const expectedDiagnostics = Array.isArray(item.expected) ? diagnosticsOf(item.expected) : null;
    const actualDiagnostics = Array.isArray(item.actual) ? diagnosticsOf(item.actual) : null;
    details.push({
      id,
      status,
      skipReason: text(item.skipReason),
      className: strList(item.classes),
      expected: expectedDiagnostics?.length ?? int(item.expected),
      actual: actualDiagnostics?.length ?? int(item.actual),
      expectedDiagnostics,
      actualDiagnostics,
      hits: int(item.hits),
      fp: int(Array.isArray(item.fp) ? item.fp.length : item.fp),
      missed: int(Array.isArray(item.missed) ? item.missed.length : item.missed),
      misanchor: int(item.misanchor),
      tier: isTier(item.tier) ? item.tier : null,
      comparison: normalizeComparison(item.comparison),
      expectedExitCode: num(item.expectedExitCode),
      actualExitCode: num(item.actualExitCode),
      expectedOutput: typeof item.expectedOutput === "string" ? item.expectedOutput : null,
      actualOutput: typeof item.actualOutput === "string" ? item.actualOutput : null,
      options: optionsOf(item.options),
      expectedArgs: Array.isArray(item.expectedArgs) ? strList(item.expectedArgs) : null,
      actualArgs: Array.isArray(item.actualArgs) ? strList(item.actualArgs) : null,
    });
  }
  return details;
}

function diagnosticsOf(v: unknown[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const item of v) {
    if (!isObject(item)) continue;
    const file = text(item.file);
    const line = num(item.line);
    const col = num(item.col);
    const code = num(item.code);
    if (file === null || line === null || col === null || code === null) continue;
    const severity = item.severity === "warning" ? "warning" : "error";
    diagnostics.push({ ...item, file, line, col, code, severity } as Diagnostic);
  }
  return diagnostics;
}

function optionsOf(v: unknown): CompilerOption[] {
  const options: CompilerOption[] = [];
  for (const item of list(v)) {
    if (!isObject(item)) continue;
    const name = text(item.name);
    const value = item.value;
    if (name === null) continue;
    if (typeof value === "boolean" || typeof value === "string") options.push({ name, value });
    else if (Array.isArray(value) && value.every((x) => typeof x === "string")) options.push({ name, value: value as string[] });
  }
  return options;
}

function normalizeFieldStatus(v: unknown): FieldStatus | null {
  return v === "equal" || v === "different" || v === "unavailable" ? v : null;
}

function normalizeVerdict(v: unknown): Verdict | null {
  return v === "pass" || v === "fail" || v === "unknown" ? v : null;
}

function normalizeComparison(v: unknown): CaseComparison | null {
  if (!isObject(v)) return null;
  const fields = Object.fromEntries(comparisonFields.map((field) => [
    field,
    normalizeFieldStatus(obj(v.fields)[field]) ?? "unavailable",
  ])) as DiagnosticComparison["fields"];
  const matchFields = (value: unknown): DiagnosticMatch["fields"] => Object.fromEntries(
    diagnosticFields.map((field) => [field, normalizeFieldStatus(obj(value)[field]) ?? "unavailable"]),
  ) as DiagnosticMatch["fields"];
  const matches: DiagnosticMatch[] = [];
  for (const item of list(v.matches)) {
    if (!isObject(item)) continue;
    const expected = num(item.expected);
    const actual = num(item.actual);
    if (expected === null || actual === null) continue;
    matches.push({ expected, actual, fields: matchFields(item.fields) });
  }
  const positionDifferences: DiagnosticMatch[] = [];
  for (const item of list(v.positionDifferences)) {
    if (!isObject(item)) continue;
    const expected = num(item.expected);
    const actual = num(item.actual);
    if (expected !== null && actual !== null) {
      positionDifferences.push({ expected, actual, fields: matchFields(item.fields) });
    }
  }
  const indices = (value: unknown): number[] =>
    list(value).filter((x): x is number => typeof x === "number" && Number.isSafeInteger(x));
  const unresolved = obj(v.unresolved);
  return {
    compatibility: normalizeVerdict(v.compatibility) ?? "unknown",
    strict: normalizeVerdict(v.strict) ?? "unknown",
    fields,
    matches,
    positionDifferences,
    missing: indices(v.missing),
    extraErrors: indices(v.extraErrors),
    extraWarnings: indices(v.extraWarnings),
    unclassified: indices(v.unclassified),
    unresolved: { expected: indices(unresolved.expected), actual: indices(unresolved.actual) },
  };
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
  const profile = ratchet.profile === "strict" ? "strict" : ratchet.profile === "compatibility" ? "compatibility" : null;
  const regressionDetails: RatchetRegressionInfo[] = [];
  for (const item of list(ratchet.regressionDetails)) {
    if (!isObject(item)) continue;
    const id = text(item.id);
    const kind = item.kind === "compatibility" || item.kind === "strict" || item.kind === "field" ? item.kind : null;
    if (id === null || kind === null) continue;
    const was = text(item.was);
    const now = text(item.now);
    if (was === null || now === null) continue;
    const explicitBlocking = typeof item.blocking === "boolean" ? item.blocking : null;
    const field = text(item.field);
    regressionDetails.push({
      id,
      kind,
      field,
      was,
      now,
      reasonKind: text(item.reasonKind),
      reason: text(item.reason) ?? "",
      blocking: explicitBlocking ?? (kind === "compatibility" || (profile === "strict" && kind === "strict")),
    });
  }
  return {
    path,
    impl: text(ratchet.impl),
    regressions: int(ratchet.regressions),
    improvements: int(ratchet.improvements),
    initialized: ratchet.initialized === true,
    wrote: ratchet.wrote === true,
    profile,
    blockingRegressions: num(ratchet.blockingRegressions),
    regressionDetails,
    // 没有 profile/blockingRegressions/regressionDetails 的是旧 T0–T3 归档。
    legacy: profile === null && num(ratchet.blockingRegressions) === null && !Array.isArray(ratchet.regressionDetails),
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
    reported: [],
  };
}

function normalizeGateReported(meta: Record<string, unknown>): GateNoteInfo[] {
  const notes: GateNoteInfo[] = [];
  for (const item of list(obj(meta.gate).reported)) {
    if (!isObject(item)) continue;
    const name = text(item.name);
    if (name === null) continue;
    notes.push({ name, detail: text(item.detail) ?? "" });
  }
  return notes;
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

function normalizeProvenance(meta: Record<string, unknown>, adapter: string | null, implName: string): RunProvenance {
  const provenance = obj(meta.provenance);
  const manifest = obj(meta.manifest);
  const tools = obj(meta.tools);
  const optionDef = obj(meta.options);
  const reference = obj(provenance.reference ?? meta.reference);
  const candidate = obj(provenance.candidate ?? meta.candidate);
  const referenceTool = obj(tools.reference);
  const candidateTool = obj(tools.candidate);
  const referenceNative = obj(referenceTool.native);
  const candidateNative = obj(candidateTool.native);
  const candidateSdk = obj(candidateTool.sdk);
  const strategy = text(meta.optionPolicy ?? meta.optionStrategy ?? optionDef.strategy ?? provenance.optionPolicy);
  const optionPolicy = strategy === "defaults"
    ? "默认设置（参考与候选各自使用默认值，未显式对齐）"
    : strategy === "aligned"
      ? "对齐设置（候选使用参考配置的基础参数）"
      : strategy;
  const manifestSha = text(manifest.sha256);
  const selectedIdsSha = text(manifest.selectedIdsSha256 ?? meta.selectedIdsSha256 ?? provenance.selectedIdsSha256);
  const parsedInputsSha = text(manifest.parsedInputsSha256 ?? meta.parsedInputsSha256 ?? provenance.parsedInputsSha256);
  const officialInputsSha = text(manifest.officialInputsSha256 ?? meta.officialInputsSha256 ?? provenance.officialInputsSha256);
  return {
    manifest: text(manifest.path ?? meta.manifestPath ?? provenance.manifest),
    manifestSha,
    selectedIdsSha,
    selectedTargetsSha: text(manifest.selectedTargetsSha256),
    parsedInputsSha,
    officialInputsSha,
    optionStrategy:
      strategy === "defaults" || strategy === "aligned"
        ? strategy
        : null,
    optionPolicy,
    runArgs: strList(meta.runArgs ?? provenance.runArgs),
    adapter,
    referenceBaseArgs: strList(optionDef.referenceBaseArgs),
    sharedArgs: strList(optionDef.sharedArgs),
    candidateArgs: strList(optionDef.candidateArgs),
    candidateEnvArgs: strList(optionDef.candidateEnvArgs),
    filters: [
      ...strList(optionDef.onlyClasses).map((name) => `只含 ${name}`),
      ...strList(optionDef.excludeClasses).map((name) => `排除 ${name}`),
    ],
    runner: text(tools.runner),
    platform: text(tools.platform),
    reference: {
      version: text(reference.version ?? referenceTool.version ?? meta.tscVersion),
      bin: text(reference.bin ?? referenceTool.path ?? meta.tscBin),
      sha256: text(reference.sha256 ?? referenceTool.sha256),
      nativeBin: text(reference.nativeBin ?? referenceNative.path),
      nativeSha256: text(reference.nativeSha256 ?? referenceNative.sha256),
      source: text(reference.source ?? meta.expectationSource),
      corpus: text(reference.corpus ?? meta.corpus),
      corpusRef: text(reference.corpusRef ?? meta.corpusRef),
    },
    candidate: {
      name: text(candidate.name) ?? implName,
      bin: text(candidate.bin ?? candidateTool.path ?? implBinFromAdapter(adapter)),
      version: text(candidate.version ?? candidateTool.version),
      sha256: text(candidate.sha256 ?? candidateTool.sha256),
      nativeBin: text(candidate.nativeBin ?? candidateNative.path),
      nativeSha256: text(candidate.nativeSha256 ?? candidateNative.sha256),
      embeddedTypeScript: text(candidate.embeddedTypeScript ?? candidateTool.embeddedTypeScript),
      sdk: { module: text(candidateSdk.module), path: text(candidateSdk.path), version: text(candidateSdk.version), sha256: text(candidateSdk.sha256) },
      source: text(candidate.source),
    },
  };
}

function sdkProvenanceBits(sdk: RunProvenance["candidate"]["sdk"], render: (value: string) => string = (value) => value): string[] {
  return [
    sdk.module === null ? null : `SDK ${render(sdk.module)}`,
    sdk.version === null ? null : `SDK 版本 ${render(sdk.version)}`,
    sdk.path === null ? null : `SDK 入口 ${render(sdk.path)}`,
    sdk.sha256 === null ? null : `SDK sha256 ${render(sdk.sha256.slice(0, 12))}`,
  ].filter((value): value is string => value !== null);
}

function normalizeAggregate(v: unknown): PerfAggregate | null {
  if (!isObject(v)) return null;
  const n = num(v.n);
  const median = num(v.median);
  const geomean = num(v.geomean);
  const p25 = num(v.p25);
  const p75 = num(v.p75);
  if (n === null || median === null || geomean === null || p25 === null || p75 === null) return null;
  return { n, median, geomean, p25, p75 };
}

function normalizePerf(metrics: Record<string, unknown>): PerfInfo | null {
  const perf = metrics.perf;
  if (!isObject(perf)) return null;
  if (perf.enabled === false) return null;
  const sample = obj(perf.sample);
  const composition = obj(sample.composition);
  const ratio = obj(perf.ratio);
  const agreement = obj(ratio.agreementSubset);
  const perCase = obj(ratio.perCase);
  const impl = obj(perf.impl);
  const reference = obj(perf.reference);
  const metric = perf.metric === "check" || perf.metric === "wall-adjusted" ? perf.metric : null;
  return {
    metric,
    seed: text(sample.seed),
    requested: num(sample.requested),
    size: num(sample.size),
    referenceOk: num(sample.referenceOk),
    referenceFailed: num(sample.referenceFailed),
    composition: {
      suite: countPairs(composition.suite),
      lineBucket: countPairs(composition.lineBucket),
      errorPresence: countPairs(composition.errorPresence),
      order: countPairs(composition.order),
    },
    ratio: {
      check: num(ratio.check),
      wallAdjusted: num(ratio.wallAdjusted),
      wall: num(ratio.wall),
      agreementCases: num(agreement.cases),
      agreementImplWallMs: num(agreement.implWallMs),
      agreementReferenceWallMs: num(agreement.referenceWallMs),
      agreementWall: num(agreement.wall),
      agreementCheck: num(agreement.check),
      agreementWallAdjusted: num(agreement.wallAdjusted),
    },
    perCase: { check: normalizeAggregate(perCase.check), wallAdjusted: normalizeAggregate(perCase.wallAdjusted) },
    impl: { meanWallMs: num(impl.meanWallMs), emptyBaselineMs: num(impl.emptyBaselineMs), checkSumMs: num(impl.checkSumMs) },
    reference: {
      meanWallMs: num(reference.meanWallMs),
      emptyBaselineMs: num(reference.emptyBaselineMs),
      checkSumMs: num(reference.checkSumMs),
      parseSumMs: num(reference.parseSumMs),
      bindSumMs: num(reference.bindSumMs),
    },
    warnings: strList(perf.warnings),
  };
}

function verdictCounts(known: boolean, pass: number, fail: number, unknown: number): VerdictCounts {
  return known ? { pass, fail, unknown, known } : { pass: null, fail: null, unknown: null, known: false };
}

function fieldCounts(known: boolean, equal: number, different: number, unavailable: number): FieldCounts {
  return known ? { equal, different, unavailable, known } : { equal: null, different: null, unavailable: null, known: false };
}

/** 读 metrics.comparison；缺该字段的旧报告不按旧 T3 冒充严格一致。 */
function normalizeComparisonSummary(metrics: Record<string, unknown>, details: CaseDetail[]): ComparisonSummary {
  const raw = obj(metrics.comparison);
  const compatibility = obj(raw.compatibility);
  const strict = obj(raw.strict);
  const rawFields = obj(raw.fields);
  let compatibilityKnown =
    num(compatibility.pass) !== null && num(compatibility.fail) !== null && num(compatibility.unknown) !== null;
  let strictKnown = num(strict.pass) !== null && num(strict.fail) !== null && num(strict.unknown) !== null;
  const caseComparisons = details.flatMap((detail) => detail.comparison === null ? [] : [detail.comparison]);
  const compatibilityFallback = { pass: 0, fail: 0, unknown: 0 };
  const strictFallback = { pass: 0, fail: 0, unknown: 0 };
  for (const comparison of caseComparisons) {
    compatibilityFallback[comparison.compatibility]++;
    strictFallback[comparison.strict]++;
  }
  if (!compatibilityKnown && caseComparisons.length > 0) compatibilityKnown = true;
  if (!strictKnown && caseComparisons.length > 0) strictKnown = true;
  const fields: Partial<Record<ComparisonField, FieldCounts>> = {};
  for (const field of comparisonFields) {
    const counts = obj(rawFields[field]);
    let known = num(counts.equal) !== null && num(counts.different) !== null && num(counts.unavailable) !== null;
    const fallback = { equal: 0, different: 0, unavailable: 0 };
    for (const comparison of caseComparisons) fallback[comparison.fields[field]]++;
    if (!known && caseComparisons.length > 0) known = true;
    if (known) {
      fields[field] = num(counts.equal) === null
        ? fieldCounts(true, fallback.equal, fallback.different, fallback.unavailable)
        : fieldCounts(true, int(counts.equal), int(counts.different), int(counts.unavailable));
    }
    else fields[field] = fieldCounts(false, 0, 0, 0);
  }
  return {
    compatibility: verdictCounts(
      compatibilityKnown,
      num(compatibility.pass) === null ? compatibilityFallback.pass : int(compatibility.pass),
      num(compatibility.fail) === null ? compatibilityFallback.fail : int(compatibility.fail),
      num(compatibility.unknown) === null ? compatibilityFallback.unknown : int(compatibility.unknown),
    ),
    strict: verdictCounts(
      strictKnown,
      num(strict.pass) === null ? strictFallback.pass : int(strict.pass),
      num(strict.fail) === null ? strictFallback.fail : int(strict.fail),
      num(strict.unknown) === null ? strictFallback.unknown : int(strict.unknown),
    ),
    fields,
    known: compatibilityKnown || strictKnown || caseComparisons.length > 0,
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
    provenance: normalizeProvenance(meta, adapter, options.implName ?? neutralImplName(adapter)),
    t3Comparable: text(meta.expectationSource) === "official-baseline",
    selectedCases: num(meta.selectedCases),
    ratchet: normalizeRatchet(meta),
    gate: normalizeGate(meta),
    gateReported: normalizeGateReported(meta),
    totals: normalizeTotals(metrics, details),
    comparison: normalizeComparisonSummary(metrics, details),
    perf: normalizePerf(metrics),
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

function scopeOf(previous: ReportModel, current: ReportModel): DeltaScope {
  const v2 = previous.comparison.known && current.comparison.known;
  const reasons: string[] = [];
  const compare = (label: string, before: string | null, after: string | null): void => {
    if (before === null && after === null) return;
    if (before === null || after === null) {
      reasons.push(`${label}缺少一侧记录，无法对照`);
      return;
    }
    if (before !== after) reasons.push(`${label}不同`);
  };
  compare("目标配置选择", previous.provenance.selectedTargetsSha, current.provenance.selectedTargetsSha);
  if (!v2) return { v2, comparable: false, reasons };
  // 用例选择哈希优先：manifest 可能因注释或格式变化而内容哈希改变，但实际选中的
  // 用例不变；两侧都没有选择哈希时才退回 manifest 文件哈希。
  if (previous.provenance.selectedIdsSha !== null && current.provenance.selectedIdsSha !== null) {
    compare("用例选择", previous.provenance.selectedIdsSha, current.provenance.selectedIdsSha);
  } else if (previous.provenance.manifestSha !== null && current.provenance.manifestSha !== null) {
    compare("用例列表", previous.provenance.manifestSha, current.provenance.manifestSha);
  } else if (
    (previous.provenance.selectedIdsSha !== null) !== (current.provenance.selectedIdsSha !== null) ||
    (previous.provenance.manifestSha !== null) !== (current.provenance.manifestSha !== null)
  ) {
    reasons.push("用例选择缺少两侧哈希，无法对照");
  }
  compare("解析后的用例输入", previous.provenance.parsedInputsSha, current.provenance.parsedInputsSha);
  compare("官方基线输入", previous.provenance.officialInputsSha, current.provenance.officialInputsSha);
  compare("期望源", previous.expectationSource, current.expectationSource);
  compare("选项策略", previous.provenance.optionStrategy, current.provenance.optionStrategy);
  return { v2: true, comparable: reasons.length === 0, reasons };
}

function v2CountRow(
  label: string,
  before: number,
  after: number,
  scope: DeltaScope,
  betterWhen: "up" | "down",
): MetricDeltaRow {
  if (!scope.comparable) {
    return { label, before: String(before), after: String(after), change: "n/a（范围不可比）", trend: "na" };
  }
  return metricRow(label, before, after, String, betterWhen);
}

function fieldDeltaRows(previous: ReportModel, current: ReportModel, scope: DeltaScope): FieldDeltaRow[] {
  const rows: FieldDeltaRow[] = [];
  for (const field of FIELD_ORDER) {
    const before = previous.comparison.fields[field];
    const after = current.comparison.fields[field];
    if (before === undefined || after === undefined || !before.known || !after.known) continue;
    if (before.equal === null || before.different === null || before.unavailable === null) continue;
    if (after.equal === null || after.different === null || after.unavailable === null) continue;
    const beforeCounts = { equal: before.equal, different: before.different, unavailable: before.unavailable };
    const afterCounts = { equal: after.equal, different: after.different, unavailable: after.unavailable };
    const delta = after.equal - before.equal;
    rows.push({
      field,
      before: beforeCounts,
      after: afterCounts,
      change:
        `相同 ${before.equal} → ${after.equal}；不同 ${before.different} → ${after.different}；` +
        `未提供 ${before.unavailable} → ${after.unavailable}`,
      trend: !scope.comparable ? "na" : delta > 0 ? "better" : delta < 0 ? "worse" : "same",
    });
  }
  return rows;
}

interface V2CaseMovement {
  id: string;
  regressions: string[];
  improvements: string[];
}

function v2MovementOf(before: CaseDetail, after: CaseDetail | undefined): V2CaseMovement | null {
  const id = before.id;
  const regressions: string[] = [];
  const improvements: string[] = [];
  const previous = before.comparison;
  if (before.status !== "ran" || previous === null) return null;

  const verifiedParts = [
    previous.compatibility === "pass" ? "兼容档原为通过" : null,
    previous.strict === "pass" ? "严格一致档原为通过" : null,
  ].filter((part): part is string => part !== null);
  const verifiedFields = FIELD_ORDER
    .filter((field) => previous.fields[field] === "equal")
    .map((field) => `${FIELD_SHORT_LABELS[field]}原为相同`);
  const verified = [...verifiedParts, ...verifiedFields];

  // 跳过或移出范围只有在之前已验证通过/相同时才是回归；未验证的维度不补造历史证据。
  if (after === undefined || after.status === "skip") {
    if (verified.length === 0) return null;
    const reason = after === undefined ? "已从本次范围移除" : `不再运行：${after.skipReason ?? "unknown"}`;
    regressions.push(`${reason}（${verified.join("；")}）`);
    return { id, regressions, improvements };
  }
  if (after.status !== "ran" || after.comparison === null) return null;
  const current = after.comparison;

  if (previous.compatibility === "pass" && current.compatibility !== "pass") {
    regressions.push(`兼容档：通过 → ${VERDICT_LABELS[current.compatibility]}`);
  } else if (previous.compatibility !== "pass" && current.compatibility === "pass") {
    improvements.push(`兼容档：${VERDICT_LABELS[previous.compatibility]} → 通过`);
  }
  if (previous.strict === "pass" && current.strict !== "pass") {
    regressions.push(`严格一致档：通过 → ${VERDICT_LABELS[current.strict]}`);
  } else if (previous.strict !== "pass" && current.strict === "pass") {
    improvements.push(`严格一致档：${VERDICT_LABELS[previous.strict]} → 通过`);
  }
  for (const field of FIELD_ORDER) {
    const was = previous.fields[field];
    const now = current.fields[field];
    if (was === "equal" && now !== "equal") {
      regressions.push(`字段 ${FIELD_SHORT_LABELS[field]}：相同 → ${FIELD_STATUS_LABELS[now]}`);
    } else if (was !== "equal" && now === "equal") {
      improvements.push(`字段 ${FIELD_SHORT_LABELS[field]}：${FIELD_STATUS_LABELS[was]} → 相同`);
    }
  }
  if (regressions.length === 0 && improvements.length === 0) return null;
  return { id, regressions, improvements };
}

function v2Movements(previous: ReportModel, current: ReportModel): { regressions: CaseMovement[]; improvements: CaseMovement[] } {
  const previousById = new Map(previous.details.map((d) => [d.id, d]));
  const currentById = new Map(current.details.map((d) => [d.id, d]));
  const regressions: CaseMovement[] = [];
  const improvements: CaseMovement[] = [];
  for (const id of [...previousById.keys()].sort((a, b) => a.localeCompare(b))) {
    const before = previousById.get(id)!;
    const movement = v2MovementOf(before, currentById.get(id));
    if (movement === null) continue;
    // 同一用例的多个维度合并为一条，便于报告按用例审阅；有回归时以回归为主。
    if (movement.regressions.length > 0) {
      const detail = [...movement.regressions, ...movement.improvements.map((item) => `另有改善：${item}`)].join("；");
      regressions.push({ id, kind: "regression", detail });
    } else if (movement.improvements.length > 0) {
      improvements.push({ id, kind: "improvement", detail: movement.improvements.join("；") });
    }
  }
  return { regressions, improvements };
}

function computeDelta(previous: ReportModel, current: ReportModel): ReportDelta {
  const scope = scopeOf(previous, current);
  let rows: MetricDeltaRow[] = [
    metricRow("覆盖率", previous.totals.coverage, current.totals.coverage, (n) => (n * 100).toFixed(1) + "%", "up"),
    metricRow("完全通过用例", previous.totals.passCases, current.totals.passCases, String, "up"),
    metricRow("假阳性用例", previous.totals.fpCases, current.totals.fpCases, String, "down"),
    metricRow("假阳性条数", previous.totals.fpTotal, current.totals.fpTotal, String, "down"),
    metricRow("漏报条数", previous.totals.missTotal, current.totals.missTotal, String, "down"),
    metricRow("错锚条数", previous.totals.misanchorTotal, current.totals.misanchorTotal, String, "down"),
    metricRow("跳过用例", previous.totals.skipped, current.totals.skipped, String, "down"),
  ];
  if (!scope.v2 && previous.totals.byTierKnown && current.totals.byTierKnown) {
    rows.push(metricRow("T3 全文用例", previous.totals.byTier.full, current.totals.byTier.full, String, "up"));
  }
  // 覆盖率变化用百分点展示更直观，覆盖掉上面的百分比差值文本。
  if (scope.reasons.length === 0 && previous.totals.coverage !== null && current.totals.coverage !== null) {
    rows[0]!.change = formatPctPoints(current.totals.coverage - previous.totals.coverage);
  }

  let regressions: CaseMovement[] = [];
  let improvements: CaseMovement[] = [];
  let fields: FieldDeltaRow[] = [];
  if (scope.v2) {
    const compatibility = knownVerdicts(previous.comparison.compatibility);
    const currentCompatibility = knownVerdicts(current.comparison.compatibility);
    const strict = knownVerdicts(previous.comparison.strict);
    const currentStrict = knownVerdicts(current.comparison.strict);
    if (compatibility !== null && currentCompatibility !== null) {
      rows.push(
        v2CountRow("兼容档 · 通过", compatibility.pass, currentCompatibility.pass, scope, "up"),
        v2CountRow("兼容档 · 失败", compatibility.fail, currentCompatibility.fail, scope, "down"),
        v2CountRow("兼容档 · 无法确认", compatibility.unknown, currentCompatibility.unknown, scope, "down"),
      );
    }
    if (strict !== null && currentStrict !== null) {
      rows.push(
        v2CountRow("严格一致档 · 通过", strict.pass, currentStrict.pass, scope, "up"),
        v2CountRow("严格一致档 · 失败", strict.fail, currentStrict.fail, scope, "down"),
        v2CountRow("严格一致档 · 无法确认", strict.unknown, currentStrict.unknown, scope, "down"),
      );
    }
    fields = fieldDeltaRows(previous, current, scope);
    if (scope.comparable && previous.details.length > 0 && current.details.length > 0) {
      const movements = v2Movements(previous, current);
      regressions = movements.regressions;
      improvements = movements.improvements;
    }
  } else if (scope.reasons.length === 0) {
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
  }
  // 范围不可比时，所有汇总差异都不能被读成检查器改善/变差；数字保留供复现核对。
  if (scope.reasons.length > 0) {
    rows = rows.map((row) => ({ ...row, change: "n/a（范围不可比）", trend: "na" as const }));
    fields = fields.map((row) => ({ ...row, trend: "na" as const }));
  }
  return {
    previousLabel: previous.generatedAt ?? previous.title,
    rows,
    regressions,
    improvements,
    scope,
    fields,
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
  const cards: SummaryCard[] = [];
  if (hasNewComparison(model)) {
    const compatibility = model.comparison.compatibility;
    const strict = model.comparison.strict;
    const compatibilityKnown = knownVerdicts(compatibility);
    const strictKnown = knownVerdicts(strict);
    const summaryNodes: SummaryCard[] = [];
    cards.push(
      {
        label: "兼容档",
        value: compatibilityKnown === null ? "未提供" : verdictCountText(compatibilityKnown),
        note: "参考诊断是否都能在同一文件、同一起点找到对应",
        tone: compatibilityKnown === null ? "neutral" : verdictToneOf(compatibilityKnown),
      },
      {
        label: "严格一致档",
        value: strictKnown === null ? "未提供" : verdictCountText(strictKnown),
        note: "全部诊断信息和输出相同；不等同于旧 T3 全文",
        tone: strictKnown === null ? "neutral" : verdictToneOf(strictKnown),
      },
    );
    if (compatibilityKnown === null || strictKnown === null || compatibilityKnown.unknown > 0 || strictKnown.unknown > 0) {
      summaryNodes.push({
        label: "两档未确认",
        value: compatibilityKnown === null || strictKnown === null
          ? "未提供"
          : `${compatibilityKnown.unknown} / ${strictKnown.unknown}`,
        note: "兼容 / 严格一致中无法确认的用例数；不等同于失败；旧报告没有此项时不显示 0",
        tone: "warn",
      });
    }
    cards.push(...summaryNodes);
    if (model.perf !== null) {
      const ratio = model.perf.ratio.check ?? model.perf.ratio.wallAdjusted;
      const metric = model.perf.ratio.check !== null ? "Check" : "实际耗时差分";
      cards.push({
        label: "性能比值",
        value: ratio === null ? "不可用" : `${ratio.toFixed(3)}×`,
        note: `${metric}；候选 / 参考，大于 1 表示候选更慢。仅供附录阅读`,
        tone: "neutral",
      });
    }
  }
  cards.push(
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
      label: hasNewComparison(model) ? "兼容通过（旧字段）" : "完全通过",
      value: `${t.passCases}/${t.ran} 例`,
      note: hasNewComparison(model)
        ? "来自 metrics.totals.passCases（新口径为兼容档通过数）；严格一致看上一行"
        : "假阳性、漏报、错锚都为 0 的用例",
      tone: t.ran > 0 && t.passCases === t.ran ? "ok" : "warn",
    },
  );
  return cards;
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
    count: cumulative[tier as Exclude<Tier, "none">],
    ratio: t.ran === 0 ? null : cumulative[tier as Exclude<Tier, "none">] / t.ran,
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
    if (detail.comparison !== null) {
      const parts: string[] = [];
      if (detail.comparison.compatibility !== "pass") parts.push(`兼容档 ${VERDICT_LABELS[detail.comparison.compatibility]}`);
      if (detail.comparison.strict !== "pass") parts.push(`严格一致档 ${VERDICT_LABELS[detail.comparison.strict]}`);
      if (parts.length === 0) continue;
      items.push({ id: detail.id, detail: parts.join("；") });
      continue;
    }
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
  /** 新契约：所选保护档的阻断回归数；null = 未提供。 */
  blockingRegressions: number | null;
  comparisonFailed: number;
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
    blockingRegressions: model.ratchet?.blockingRegressions ?? null,
    comparisonFailed: [model.comparison.compatibility.fail, model.comparison.strict.fail]
      .filter((n): n is number => n !== null)
      .reduce((sum, n) => sum + n, 0),
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
    callouts.hasT3Failures ||
    callouts.comparisonFailed > 0 ||
    (callouts.blockingRegressions !== null && callouts.blockingRegressions > 0)
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
  lines.push(`| 用例列表 | ${model.provenance.manifest === null ? "未提供" : mdCode(model.provenance.manifest)} |`);
  if (model.provenance.manifestSha !== null) {
    lines.push(`| 用例列表 SHA-256 | ${mdCode(model.provenance.manifestSha)} |`);
  }
  lines.push(`| 选项策略 | ${model.provenance.optionPolicy === null ? "未提供" : mdText(model.provenance.optionPolicy)} |`);
  lines.push(
    `| 原始运行参数 | ${model.provenance.runArgs.length === 0 ? "未提供" : model.provenance.runArgs.map(mdCode).join(" ")} |`,
  );
  const optionRows: [string, string[]][] = [
    ["参考基础参数", model.provenance.referenceBaseArgs],
    ["共享覆盖参数", model.provenance.sharedArgs],
    ["候选基础参数", model.provenance.candidateArgs],
    ["候选环境参数", model.provenance.candidateEnvArgs],
    ["用例过滤", model.provenance.filters],
  ];
  for (const [label, values] of optionRows) {
    if (values.length > 0) lines.push(`| ${label} | ${values.map(mdCode).join(" ")} |`);
  }
  const referenceBits: string[] = [];
  if (model.provenance.reference.version !== null) referenceBits.push(`tsc ${mdCode(model.provenance.reference.version)}`);
  if (model.provenance.reference.bin !== null) referenceBits.push(`bin ${mdCode(model.provenance.reference.bin)}`);
  if (model.provenance.reference.sha256 !== null) referenceBits.push(`sha256 ${mdCode(model.provenance.reference.sha256.slice(0, 12))}`);
  if (model.provenance.reference.nativeBin !== null) referenceBits.push(`原生 ${mdCode(model.provenance.reference.nativeBin)}`);
  if (model.provenance.reference.nativeSha256 !== null) {
    referenceBits.push(`原生 sha256 ${mdCode(model.provenance.reference.nativeSha256.slice(0, 12))}`);
  }
  if (model.provenance.reference.source !== null) referenceBits.push(`源 ${mdCode(model.provenance.reference.source)}`);
  if (model.provenance.reference.corpus !== null) referenceBits.push(`语料 ${mdCode(model.provenance.reference.corpus)}`);
  if (model.provenance.reference.corpusRef !== null) referenceBits.push(`pin ${mdCode(model.provenance.reference.corpusRef)}`);
  lines.push(`| 参考来源 | ${referenceBits.length === 0 ? "未提供" : referenceBits.join(" · ")} |`);
  const candidateBits: string[] = [];
  if (model.provenance.candidate.name !== null) candidateBits.push(`名称 ${mdCell(model.provenance.candidate.name)}`);
  if (model.provenance.candidate.version !== null) candidateBits.push(`版本 ${mdCode(model.provenance.candidate.version)}`);
  if (model.provenance.candidate.bin !== null) candidateBits.push(`bin ${mdCode(model.provenance.candidate.bin)}`);
  if (model.provenance.candidate.sha256 !== null) candidateBits.push(`sha256 ${mdCode(model.provenance.candidate.sha256.slice(0, 12))}`);
  if (model.provenance.candidate.nativeBin !== null) candidateBits.push(`原生 ${mdCode(model.provenance.candidate.nativeBin)}`);
  if (model.provenance.candidate.nativeSha256 !== null) {
    candidateBits.push(`原生 sha256 ${mdCode(model.provenance.candidate.nativeSha256.slice(0, 12))}`);
  }
  if (model.provenance.candidate.embeddedTypeScript !== null) {
    candidateBits.push(`内置 TypeScript ${mdCode(model.provenance.candidate.embeddedTypeScript)}（Bun 内置版本，不是参考 tsc 版本）`);
  }
  candidateBits.push(...sdkProvenanceBits(model.provenance.candidate.sdk, mdCode));
  if (model.provenance.candidate.source !== null) candidateBits.push(`源 ${mdCode(model.provenance.candidate.source)}`);
  lines.push(`| 候选来源 | ${candidateBits.length === 0 ? "未提供" : candidateBits.join(" · ")} |`);
  if (model.provenance.runner !== null || model.provenance.platform !== null) {
    lines.push(
      `| 运行环境 | ${[model.provenance.runner, model.provenance.platform].filter((x): x is string => x !== null).map(mdCode).join(" · ")} |`,
    );
  }
  if (model.ratchet !== null) {
    const state = model.ratchet.initialized
      ? "首次登记"
      : `回归 ${model.ratchet.regressions} 项、改善 ${model.ratchet.improvements} 项`;
    const profile = model.ratchet.profile === "strict" ? "严格一致" : model.ratchet.profile === "compatibility" ? "兼容" : "未提供";
    const blocking = model.ratchet.blockingRegressions === null ? "未提供" : `${model.ratchet.blockingRegressions} 项`;
    lines.push(`| 回归保护档 | ${profile}（阻断 ${blocking}） |`);
    if (model.ratchet.legacy) {
      lines.push("| 回归记录格式 | 旧 T0–T3：没有 strict / 逐字段回归证据 |");
    }
    lines.push(`| ratchet | ${mdCode(model.ratchet.path)}：${state} |`);
  }
  if (model.provenance.adapter !== null) {
    lines.push(`| 适配器 | ${mdCode(model.provenance.adapter)} |`);
  }
  if (model.selectedCases !== null) {
    lines.push(
      `| 用例 | 选中 ${model.selectedCases}（源用例）/ 实际 ${model.totals.cases}（展开后）：跑 ${model.totals.ran}，跳过 ${model.totals.skipped}`,
    );
  } else {
    lines.push(
      `| 用例 | 实际 ${model.totals.cases}（展开后）：跑 ${model.totals.ran}，跳过 ${model.totals.skipped}`,
    );
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
  if (model.gateReported.length > 0) {
    lines.push("");
    lines.push(`**仅报告（不参与门禁）**`);
    lines.push("");
    for (const note of model.gateReported) lines.push(`- ${mdText(note.name)}：${mdText(note.detail)}`);
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
  const scopeWarning = scopeWarningLines(delta);
  if (scopeWarning.length > 0) {
    lines.push("");
    lines.push(...scopeWarning);
  }
  lines.push("");
  lines.push(`| 指标 | 上次 | 本次 | 变化 |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const row of delta.rows) {
    lines.push(`| ${mdCell(row.label)} | ${mdCell(row.before)} | ${mdCell(row.after)} | ${mdCell(row.change)} |`);
  }
  if (delta.fields.length > 0) {
    lines.push("");
    lines.push("**逐字段分布变化**");
    lines.push("");
    lines.push("| 字段 | 上次（相同 / 不同 / 未提供） | 本次（相同 / 不同 / 未提供） | 变化 |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of delta.fields) {
      lines.push(
        `| ${FIELD_LABELS[row.field]} | ${row.before.equal} / ${row.before.different} / ${row.before.unavailable} | ` +
          `${row.after.equal} / ${row.after.different} / ${row.after.unavailable} | ${mdCell(row.change)} |`,
      );
    }
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
    const blocking = model.ratchet?.blockingRegressions;
    lines.push(
      `**ratchet 回归 ${callouts.ratchetRegressions} 项**` +
        (blocking === null || blocking === undefined ? "（旧记录未提供阻断信息）" : `（阻断 ${blocking} 项）`) +
        `：清单 ${mdCode(model.ratchet!.path)}，逐项原因见“两档比较”下的回归记录。`,
    );
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
  if (hasNewComparison(model)) {
    const gateHasBlocking = callouts.gateFailed.length > 0 ||
      (callouts.blockingRegressions !== null && callouts.blockingRegressions > 0);
    const blockedBy = [
      gateHasBlocking ? "门禁检查 / 回归记录" : null,
      callouts.deltaRegressions.length > 0 ? "与上次相比的回归" : null,
    ].filter((x): x is string => x !== null);
    lines.push(
      blockedBy.length === 0
        ? "**门槛结论**：本次没有阻断项；兼容档与严格一致档的未通过项、非阻断回归仅供阅读，不代表门禁失败。"
        : `**门槛结论**：${blockedBy.join("、")}阻断。两档比较的失败项、字段回归与门禁是否失败分开判断；请对照上方门禁结论。`,
    );
  }
  return lines;
}

function renderTierMd(model: ReportModel): string[] {
  const lines: string[] = [];
  lines.push("> 下面是旧 metrics.totals 的 T0–T3 阶梯，仅作过渡参考；T3 全文不等于严格一致档。");
  lines.push("");
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

function verdictTone(verdict: Verdict): string {
  return verdict === "pass" ? "ok" : verdict === "fail" ? "bad" : "unknown";
}

function comparisonCountText(counts: VerdictCounts): string {
  const known = knownVerdicts(counts);
  return known === null ? "未提供" : verdictCountText(known);
}

function comparisonLine(model: ReportModel): string {
  const summary = model.comparison;
  return (
    `> 兼容档 ${comparisonCountText(summary.compatibility)}｜严格一致档 ${comparisonCountText(summary.strict)}` +
    "（严格一致不是旧 T3 全文比较）"
  );
}

/** 逐案比较中所有「未提供」/「不同」的字段，用于展开差异。 */
function differingFields(comparison: CaseComparison): [ComparisonField, FieldStatus][] {
  const fields: [ComparisonField, FieldStatus][] = [];
  for (const field of comparisonFields) {
    const status = comparison.fields[field];
    if (status === "different" || status === "unavailable") fields.push([field, status]);
  }
  return fields;
}

function differingMatchFields(match: DiagnosticMatch): [ComparisonField, FieldStatus][] {
  const fields: [ComparisonField, FieldStatus][] = [];
  for (const field of diagnosticFields) {
    const status = match.fields[field];
    if (status === "different" || status === "unavailable") fields.push([field, status]);
  }
  return fields;
}

function fieldStatusText(status: FieldStatus): string {
  return FIELD_STATUS_LABELS[status];
}

function comparisonStatusLine(comparison: CaseComparison): string {
  return [
    `兼容档：${VERDICT_LABELS[comparison.compatibility]}`,
    `严格一致档：${VERDICT_LABELS[comparison.strict]}`,
    `位置差异：${comparison.positionDifferences.length} 对`,
  ].join("｜");
}

const RATCHET_KIND_LABELS: Record<RatchetRegressionInfo["kind"], string> = {
  compatibility: "兼容",
  strict: "严格一致",
  field: "字段",
};

function renderRatchetMd(ratchet: RatchetInfo): string[] {
  const lines: string[] = [];
  const heading = ratchet.profile === "strict"
    ? "严格一致保护档"
    : ratchet.profile === "compatibility"
      ? "兼容保护档"
      : ratchet.legacy ? "旧 T0–T3 归档" : "保护档未提供";
  lines.push(
    `#### 回归记录（${heading}）`,
  );
  lines.push("");
  if (ratchet.legacy) {
    lines.push(
      "> 这是旧版 T0–T3 清单：只保留旧分级计数，没有 profile / regressionDetails / blocking 信息；不能用它推断严格一致回归。",
    );
    return lines;
  }
  lines.push(
    `- 回归 ${ratchet.regressions} 项；阻断 ${ratchet.blockingRegressions ?? "未提供"} 项；改善 ${ratchet.improvements} 项。`,
  );
  if (ratchet.regressionDetails.length === 0) {
    lines.push("- 逐项回归：无");
    return lines;
  }
  lines.push("");
  lines.push(`| 用例 | 维度 | 字段 | 变化 | 原因类型 | 原因 | 门禁 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const item of ratchet.regressionDetails) {
    lines.push(
      `| ${mdCode(item.id)} | ${RATCHET_KIND_LABELS[item.kind]} | ${item.field === null ? "—" : mdCode(item.field)} | ` +
        `${mdCell(item.was)} → ${mdCell(item.now)} | ${item.reasonKind === null ? "未提供" : mdCode(item.reasonKind)} | ` +
        `${mdCell(item.reason)} | ${item.blocking ? "**阻断**" : "仅报告"} |`,
    );
  }
  return lines;
}

function exitCodeText(expected: number | null, actual: number | null): string {
  const left = expected === null ? "未提供" : `参考 ${expected}`;
  const right = actual === null ? "未提供" : `候选 ${actual}`;
  if (expected !== null && actual !== null && expected !== actual) return `${left}｜${right}（不一致）`;
  return `${left}｜${right}`;
}

function outputText(value: string | null): string {
  return value === null ? "（未提供）" : value.length === 0 ? "（明确为空）" : value;
}

function diagnosticSummary(diagnostic: Diagnostic, index: number): string {
  const location = `${diagnostic.file}:${diagnostic.line + 1}:${diagnostic.col + 1}`;
  const message = diagnostic.message === undefined ? "" : `：${diagnostic.message}`;
  const related = diagnostic.related === undefined || diagnostic.related.length === 0
    ? ""
    : `（related ${diagnostic.related.length} 条）`;
  return `[${index}] ${location} ${diagnostic.severity} TS${diagnostic.code}${message}${related}`;
}

function diagnosticsAt(diagnostics: Diagnostic[] | null, indices: number[], cap = 12): string[] {
  if (diagnostics === null) return [];
  const shown: string[] = [];
  for (const index of indices.slice(0, cap)) {
    const diagnostic = diagnostics[index];
    if (diagnostic !== undefined) shown.push(diagnosticSummary(diagnostic, index));
  }
  if (indices.length > cap) shown.push(`…… 共 ${indices.length} 条`);
  return shown;
}

function matchValueSummary(expected: Diagnostic[], actual: Diagnostic[], pair: DiagnosticMatch): string {
  const left = expected[pair.expected];
  const right = actual[pair.actual];
  if (left === undefined || right === undefined) return `expected[${pair.expected}] ↔ actual[${pair.actual}]`;
  const code = `TS${left.code} → TS${right.code}`;
  const severity = `${left.severity} → ${right.severity}`;
  const message = `${left.message ?? "（无文案）"} → ${right.message ?? "（无文案）"}`;
  return `expected[${pair.expected}] ↔ actual[${pair.actual}]；${code}；${severity}；${message}`;
}

const ratioText = (value: number | null, digits = 3): string => (value === null ? "不可用" : value.toFixed(digits));

function aggregateText(aggregate: PerfAggregate | null): string {
  if (aggregate === null) return "未提供";
  return (
    `${aggregate.n} 例；中位 ${aggregate.median.toFixed(3)}，几何均值 ${aggregate.geomean.toFixed(3)}，` +
    `P25 ${aggregate.p25.toFixed(3)}，P75 ${aggregate.p75.toFixed(3)}`
  );
}

const formatMs = (value: number | null): string => (value === null ? "未提供" : value.toFixed(1));

function compositionText(pairs: [string, number][]): string {
  return pairs.length === 0 ? "未提供" : pairs.map(([name, count]) => `${name} ${count}`).join("，");
}

function perfMetricText(metric: PerfInfo["metric"]): string {
  return metric === "check"
    ? "Check 相位累加（两侧都自报）"
    : metric === "wall-adjusted"
      ? "实际耗时扣空程序基线（含 parse/bind/渲染）"
      : "未提供";
}

function renderPerfMd(model: ReportModel): string[] {
  const perf = model.perf;
  if (perf === null) return ["本次运行没有性能附录（未传 `--perf-ratio`，或产物没有 `metrics.perf`）。"];
  const lines: string[] = [];
  lines.push(`口径：${perfMetricText(perf.metric)}；比值为「候选 / 参考 tsc」，小于 1 表示候选更快。`);
  lines.push("");
  lines.push(`| 项 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 样本 | 请求 ${perf.requested ?? "未提供"}，有效 ${perf.size ?? "未提供"}（参考成功 ${perf.referenceOk ?? "未提供"}，失败 ${perf.referenceFailed ?? "未提供"}） |`);
  lines.push(`| 抽样 seed | ${perf.seed === null ? "未提供" : mdCode(perf.seed)} |`);
  lines.push(`| 总比值（Check） | ${ratioText(perf.ratio.check)} |`);
  lines.push(`| 总比值（实际耗时差分） | ${ratioText(perf.ratio.wallAdjusted)} |`);
  lines.push(`| 总比值（原始实际耗时） | ${ratioText(perf.ratio.wall)} |`);
  lines.push(
    `| 兼容通过子集 | ${perf.ratio.agreementCases ?? "未提供"} 例；原始实际耗时 ${ratioText(perf.ratio.agreementWall)}（${formatMs(perf.ratio.agreementImplWallMs)} / ${formatMs(perf.ratio.agreementReferenceWallMs)} ms）；` +
      `Check ${ratioText(perf.ratio.agreementCheck)}；实际耗时差分 ${ratioText(perf.ratio.agreementWallAdjusted)} |`,
  );
  lines.push(`| 逐案 Check | ${aggregateText(perf.perCase.check)} |`);
  lines.push(`| 逐案实际耗时差分 | ${aggregateText(perf.perCase.wallAdjusted)} |`);
  lines.push("");
  lines.push("样本构成：");
  lines.push("");
  lines.push(`- suite：${compositionText(perf.composition.suite)}`);
  lines.push(`- 行数档：${compositionText(perf.composition.lineBucket)}`);
  lines.push(`- 有无期望错误：${compositionText(perf.composition.errorPresence)}`);
  lines.push(`- 先后顺序对冲：${compositionText(perf.composition.order)}`);
  lines.push("");
  lines.push(
    `累计时间：候选实际耗时均值 ${perf.impl.meanWallMs === null ? "未提供" : `${perf.impl.meanWallMs.toFixed(1)}ms`}，` +
      `空程序基线 ${perf.impl.emptyBaselineMs === null ? "未提供" : `${perf.impl.emptyBaselineMs.toFixed(1)}ms`}，` +
      `Check 合计 ${perf.impl.checkSumMs === null ? "未提供" : `${perf.impl.checkSumMs.toFixed(1)}ms`}；` +
      `参考实际耗时均值 ${perf.reference.meanWallMs === null ? "未提供" : `${perf.reference.meanWallMs.toFixed(1)}ms`}，` +
      `Check 合计 ${perf.reference.checkSumMs === null ? "未提供" : `${perf.reference.checkSumMs.toFixed(1)}ms`}。`,
  );
  if (perf.warnings.length > 0) {
    lines.push("");
    lines.push("**性能附录告警**");
    lines.push("");
    for (const warning of perf.warnings) lines.push(`- ${mdText(warning)}`);
  }
  return lines;
}

function renderComparisonMd(model: ReportModel): string[] {
  const lines: string[] = [];
  const summary = model.comparison;
  if (!summary.known) {
    lines.push("本次产物没有两档比较结果：旧报告不提供 `metrics.comparison`，逐案也没有 `comparison`。");
    lines.push("");
    lines.push("旧版 T0–T3 阶梯仍保留在上一节供对照，但 **T3 全文不能当作严格一致档**。compatibility / strict 的各状态在旧数据里均为「未提供」。");
    return lines;
  }
  lines.push("| 档位 | 通过 | 失败 | 无法确认 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [label, counts] of [
    ["兼容档", summary.compatibility],
    ["严格一致档", summary.strict],
  ] as const) {
    lines.push(
      counts.known
        ? `| ${label} | ${counts.pass} | ${counts.fail} | ${counts.unknown} |`
        : `| ${label} | 未提供 | 未提供 | 未提供 |`,
    );
  }
  const fieldRows = comparisonFields
    .map((field) => [field, summary.fields[field]] as const)
    .filter(([, counts]) => counts !== undefined);
  if (fieldRows.length > 0) {
    lines.push("");
    lines.push("| 字段 | 相同 | 不同 | 未提供 |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const [field, counts] of fieldRows) {
      if (counts === undefined) continue;
      lines.push(
        counts.known
          ? `| ${FIELD_LABELS[field]} | ${counts.equal} | ${counts.different} | ${counts.unavailable} |`
          : `| ${FIELD_LABELS[field]} | 未提供 | 未提供 | 未提供 |`,
      );
    }
  }
  if (model.ratchet !== null) {
    lines.push("");
    lines.push(
      "`meta.ratchet` 由回归模块生成；这里逐项展示它给出的回归，旧 T3 不会被当作严格一致回归。",
    );
  }
  if (model.ratchet !== null) {
    lines.push("");
    lines.push(...renderRatchetMd(model.ratchet));
    const otherRegressions = model.ratchet.regressionDetails.filter((item) => !item.blocking);
    if (otherRegressions.length > 0) {
      lines.push("");
      lines.push("非阻断回归与字段回归只在报告里列出，不改变门禁结论。");
    }
    if (model.ratchet.profile === null && !model.ratchet.legacy) {
      lines.push("");
      lines.push("> 本次没有提供保护档；表中门禁列按各回归自身的 blocking 标记展示，兼容/严格档的失败数不等于阻断数。");
    }
  }
  const cases = model.details.filter((detail) => detail.status === "ran");
  if (cases.length === 0) {
    lines.push("");
    lines.push("没有可展开的逐案比较（旧 details 或全部跳过）。");
    return lines;
  }
  lines.push("");
  lines.push("### 逐案比较");
  lines.push("");
  for (const detail of cases) {
    const comparison = detail.comparison;
    lines.push(`<details>`);
    lines.push(
      `<summary>${mdCode(detail.id)}${comparison === null ? "：旧版结果（未提供两档比较）" : `：${mdText(comparisonStatusLine(comparison))}`}</summary>`,
    );
    lines.push("");
    lines.push(`- 退出码：${mdText(exitCodeText(detail.expectedExitCode, detail.actualExitCode))}`);
    if (comparison === null) {
      lines.push("- 比较详情：未提供（旧版 details）");
    } else {
      const statuses = differingFields(comparison);
      if (statuses.length === 0) lines.push("- 字段差异：无（所有已比较字段相同）");
      else {
        lines.push("- 字段差异：");
        for (const [field, status] of statuses) {
          lines.push(`  - ${FIELD_LABELS[field]}：${fieldStatusText(status)}`);
        }
      }
      const counts = [
        `${comparison.missing.length} 条参考诊断未对应`,
        `${comparison.extraErrors.length} 条新增 error`,
        `${comparison.extraWarnings.length} 条新增 warning`,
      ];
      if (comparison.unclassified.length > 0) counts.push(`${comparison.unclassified.length} 条未分类诊断`);
      if (comparison.unresolved.expected.length > 0 || comparison.unresolved.actual.length > 0) {
        counts.push(
          `${comparison.unresolved.expected.length} 条参考 / ${comparison.unresolved.actual.length} 条候选未能唯一对应（已知字段不足）`,
        );
      }
      counts.push(`${comparison.positionDifferences.length} 对仅位置不同`);
      lines.push(`- 诊断对应：${counts.join("；")}`);
      if (comparison.positionDifferences.length > 0) {
        const details = comparison.positionDifferences.map((pair) => matchValueSummary(
          detail.expectedDiagnostics ?? [],
          detail.actualDiagnostics ?? [],
          pair,
        ));
        lines.push(
          `  - 仅位置不同（仍判不兼容）：${details.map(mdText).join("；")}`,
        );
      }
      const matchDifferences = comparison.matches
        .map((match) => ({ match, changed: differingMatchFields(match) }))
        .filter(({ changed }) => changed.length > 0);
      if (matchDifferences.length > 0) {
        lines.push("- 已配对诊断的差异：");
        for (const { match, changed } of matchDifferences.slice(0, 12)) {
          const detailText = changed.map(([field, status]) => `${FIELD_LABELS[field]} ${fieldStatusText(status)}`).join("、");
          lines.push(
            `  - ${mdText(matchValueSummary(detail.expectedDiagnostics ?? [], detail.actualDiagnostics ?? [], match))}：${detailText}`,
          );
        }
        if (matchDifferences.length > 12) lines.push(`  - …… 共 ${matchDifferences.length} 对`);
      }
      if (detail.expectedDiagnostics !== null && detail.actualDiagnostics !== null) {
        const expectedText = detail.expectedOutput ?? "未提供";
        const actualText = detail.actualOutput ?? "未提供";
        lines.push(
          `- 诊断原文：参考 ${detail.expectedDiagnostics.length} 条，候选 ${detail.actualDiagnostics.length} 条；` +
            `输出 ${expectedText === "未提供" ? "未提供" : "已提供"} / ${actualText === "未提供" ? "未提供" : "已提供"}`,
        );
      }
      const missingLines = diagnosticsAt(detail.expectedDiagnostics, comparison.missing);
      const extraLines = diagnosticsAt(detail.actualDiagnostics, comparison.extraErrors);
      const warningLines = diagnosticsAt(detail.actualDiagnostics, comparison.extraWarnings);
      if (missingLines.length > 0) {
        lines.push("- 未对应的参考诊断：");
        for (const line of missingLines) lines.push(`  - ${mdCode(line)}`);
      }
      if (extraLines.length > 0) {
        lines.push("- 新增 error：");
        for (const line of extraLines) lines.push(`  - ${mdCode(line)}`);
      }
      if (warningLines.length > 0) {
        lines.push("- 附加 warning：");
        for (const line of warningLines) lines.push(`  - ${mdCode(line)}`);
      }
      if (detail.expectedOutput !== null || detail.actualOutput !== null) {
        lines.push("");
        lines.push(`- 完整输出（参考）：`);
        lines.push("");
        lines.push(detail.expectedOutput === null || detail.expectedOutput.length === 0 ? mdText(outputText(detail.expectedOutput)) : mdCodeBlock(detail.expectedOutput));
        lines.push("");
        lines.push(`- 完整输出（候选）：`);
        lines.push("");
        lines.push(detail.actualOutput === null || detail.actualOutput.length === 0 ? mdText(outputText(detail.actualOutput)) : mdCodeBlock(detail.actualOutput));
      }
    }
    lines.push(
      `- 选项：参考 ${detail.expectedArgs === null ? "未提供" : mdCode(detail.expectedArgs.join(" ") || "（无）")}；` +
        `候选 ${detail.actualArgs === null ? "未提供" : mdCode(detail.actualArgs.join(" ") || "（无）")}`,
    );
    if (detail.options.length > 0) {
      lines.push(`- 用例选项：${detail.options.map((option) => mdCode(`${option.name}=${String(option.value)}`)).join(" ")}`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function renderMarkdown(model: ReportModel): string {
  const callouts = calloutsOf(model);
  const lines: string[] = [];
  lines.push(`# ${mdText(model.title)}`);
  lines.push("");
  lines.push(
    `> ${mdText(gateConclusion(model))}｜覆盖 ${pct(model.totals.coverage)}｜假阳性 ${model.totals.fpCases} 例 / ${model.totals.fpTotal} 条｜漏报 ${model.totals.missTotal}｜错锚 ${model.totals.misanchorTotal}｜跳过 ${model.totals.skipped}`,
  );
  if (hasNewComparison(model)) {
    lines.push(">");
    lines.push(comparisonLine(model));
  }
  const deltaScopeWarning = scopeWarningLines(model.delta);
  if (deltaScopeWarning.length > 0) {
    lines.push(">");
    lines.push(...deltaScopeWarning);
  }
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
  if (hasNewComparison(model)) {
    lines.push("");
    lines.push("## 两档比较");
    lines.push("");
    lines.push(...renderComparisonMd(model));
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
  if (model.perf !== null) {
    lines.push("");
    lines.push("## 性能附录");
    lines.push("");
    lines.push(...renderPerfMd(model));
  }
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
pre { overflow-x: auto; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
pre code { background: none; padding: 0; }
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

function htmlUl(items: string[], cap = 20): string {
  const shown = items.slice(0, cap).map((item) => `<li>${item}</li>`).join("\n");
  const tail = items.length > cap ? `\n<li>…… 共 ${items.length} 条</li>` : "";
  return `<ul>\n${shown}${tail}\n</ul>`;
}

function verdictClass(verdict: Verdict): string {
  return verdict === "pass" ? "status-ok" : verdict === "fail" ? "status-bad" : "";
}

function renderComparisonHtml(model: ReportModel): string {
  const summary = model.comparison;
  if (!summary.known) {
    return (
      '<p class="note">本次产物没有两档比较结果：旧报告不提供 <code>metrics.comparison</code>，逐案也没有 <code>comparison</code>。' +
      "旧版 T0–T3 阶梯仍保留在上一节供对照，但 <strong>T3 全文不能当作严格一致档</strong>。</p>"
    );
  }
  const blocks: string[] = [];
  const verdictRows = [
    ["兼容档", summary.compatibility],
    ["严格一致档", summary.strict],
  ] as const;
  blocks.push(
    htmlTable(
      ["档位", "通过", "失败", "无法确认"],
      verdictRows.map(([label, counts]) => [
        label,
        counts.known ? String(counts.pass) : "未提供",
        counts.known ? String(counts.fail) : "未提供",
        counts.known ? String(counts.unknown) : "未提供",
      ]),
    ),
  );
  const fieldRows = comparisonFields
    .map((field) => [field, summary.fields[field]] as const)
    .filter(([, counts]) => counts !== undefined)
    .map(([field, counts]) => [
      FIELD_LABELS[field],
      counts!.known ? String(counts!.equal) : "未提供",
      counts!.known ? String(counts!.different) : "未提供",
      counts!.known ? String(counts!.unavailable) : "未提供",
    ]);
  if (fieldRows.length > 0) {
    blocks.push(htmlTable(["字段", "相同", "不同", "未提供"], fieldRows));
  }
  if (model.ratchet !== null) {
    blocks.push(
      '<p class="note"><code>meta.ratchet</code> 由回归模块生成；这里逐项展示它给出的回归，旧 T3 不会被当作严格一致回归。</p>',
    );
    blocks.push(renderRatchetHtml(model.ratchet));
    if (model.ratchet.regressionDetails.some((item) => !item.blocking)) {
      blocks.push("<p class=\"note\">非阻断回归与字段回归只在报告里列出，不改变门禁结论。</p>");
    }
    if (model.ratchet.profile === null && !model.ratchet.legacy) {
      blocks.push(
        "<p class=\"note\">本次没有提供保护档；门禁列按各回归自身的 blocking 标记展示，兼容/严格档的失败数不等于阻断数。</p>",
      );
    }
  }
  const cases = model.details.filter((detail) => detail.status === "ran");
  if (cases.length === 0) {
    blocks.push('<p class="note">没有可展开的逐案比较（旧 details 或全部跳过）。</p>');
    return blocks.join("\n");
  }
  blocks.push("<h3>逐案比较</h3>");
  for (const detail of cases) {
    const comparison = detail.comparison;
    const body: string[] = [];
    body.push(`<p>退出码：${escapeHtml(exitCodeText(detail.expectedExitCode, detail.actualExitCode))}</p>`);
    if (comparison === null) {
      body.push('<p class="note">比较详情：未提供（旧版 details）。</p>');
    } else {
      body.push(
        `<p>兼容档：<span class="${verdictClass(comparison.compatibility)}">${escapeHtml(VERDICT_LABELS[comparison.compatibility])}</span>` +
          `｜严格一致档：<span class="${verdictClass(comparison.strict)}">${escapeHtml(VERDICT_LABELS[comparison.strict])}</span></p>`,
      );
      const statuses = differingFields(comparison);
      if (statuses.length === 0) body.push("<p>字段差异：无（所有已比较字段相同）。</p>");
      else {
        body.push(
          "<p>字段差异：</p>" +
            htmlUl(statuses.map(([field, status]) => `${escapeHtml(FIELD_LABELS[field])}：${escapeHtml(fieldStatusText(status))}`)),
        );
      }
      const counts = [
        `${comparison.missing.length} 条参考诊断未对应`,
        `${comparison.extraErrors.length} 条新增 error`,
        `${comparison.extraWarnings.length} 条新增 warning`,
      ];
      if (comparison.unclassified.length > 0) counts.push(`${comparison.unclassified.length} 条未分类诊断`);
      if (comparison.unresolved.expected.length > 0 || comparison.unresolved.actual.length > 0) {
        counts.push(
          `${comparison.unresolved.expected.length} 条参考 / ${comparison.unresolved.actual.length} 条候选未能唯一对应（已知字段不足）`,
        );
      }
      counts.push(`${comparison.positionDifferences.length} 对仅位置不同`);
      body.push(`<p>诊断对应：${escapeHtml(counts.join("；"))}</p>`);
      if (comparison.positionDifferences.length > 0) {
        const pairs = comparison.positionDifferences.map((pair) => matchValueSummary(
          detail.expectedDiagnostics ?? [],
          detail.actualDiagnostics ?? [],
          pair,
        ));
        body.push(
          "<p>仅位置不同（仍判不兼容）：" +
            escapeHtml(pairs.join("；")) +
            "</p>",
        );
      }
      const matchDifferences = comparison.matches
        .map((match) => ({ match, changed: differingMatchFields(match) }))
        .filter(({ changed }) => changed.length > 0);
      if (matchDifferences.length > 0) {
        body.push(
          "<p>已配对诊断的差异：</p>" +
            htmlUl(
              matchDifferences.slice(0, 12).map(({ match, changed }) =>
                `${escapeHtml(matchValueSummary(detail.expectedDiagnostics ?? [], detail.actualDiagnostics ?? [], match))}：${escapeHtml(
                  changed.map(([field, status]) => `${FIELD_LABELS[field]} ${fieldStatusText(status)}`).join("、"),
                )}`,
              ),
            ),
        );
      }
      if (detail.expectedDiagnostics !== null && detail.actualDiagnostics !== null) {
        body.push(
          `<p class="note">诊断原文：参考 ${detail.expectedDiagnostics.length} 条，候选 ${detail.actualDiagnostics.length} 条；` +
            `输出 ${detail.expectedOutput === null ? "未提供" : "已提供"} / ${detail.actualOutput === null ? "未提供" : "已提供"}</p>`,
        );
      }
      const missingLines = diagnosticsAt(detail.expectedDiagnostics, comparison.missing);
      const extraLines = diagnosticsAt(detail.actualDiagnostics, comparison.extraErrors);
      const warningLines = diagnosticsAt(detail.actualDiagnostics, comparison.extraWarnings);
      if (missingLines.length > 0) {
        body.push("<p>未对应的参考诊断：</p>" + htmlUl(missingLines.map((line) => `<code>${escapeHtml(line)}</code>`)));
      }
      if (extraLines.length > 0) {
        body.push("<p>新增 error：</p>" + htmlUl(extraLines.map((line) => `<code>${escapeHtml(line)}</code>`)));
      }
      if (warningLines.length > 0) {
        body.push("<p>附加 warning：</p>" + htmlUl(warningLines.map((line) => `<code>${escapeHtml(line)}</code>`)));
      }
      if (detail.expectedOutput !== null || detail.actualOutput !== null) {
        const expectedOutput = detail.expectedOutput === null || detail.expectedOutput.length === 0 ? outputText(detail.expectedOutput) : detail.expectedOutput;
        const actualOutput = detail.actualOutput === null || detail.actualOutput.length === 0 ? outputText(detail.actualOutput) : detail.actualOutput;
        body.push(
          "<p>完整输出（参考）：</p>" +
            `<pre><code>${escapeHtml(expectedOutput)}</code></pre>` +
            "<p>完整输出（候选）：</p>" +
            `<pre><code>${escapeHtml(actualOutput)}</code></pre>`,
        );
      }
    }
    body.push(
      `<p class="note">选项：参考 ${
        detail.expectedArgs === null ? "未提供" : `<code>${escapeHtml(detail.expectedArgs.join(" ") || "（无）")}</code>`
      }；候选 ${
        detail.actualArgs === null ? "未提供" : `<code>${escapeHtml(detail.actualArgs.join(" ") || "（无）")}</code>`
      }</p>`,
    );
    if (detail.options.length > 0) {
      body.push(
        `<p class="note">用例选项：${detail.options
          .map((option) => `<code>${escapeHtml(`${option.name}=${String(option.value)}`)}</code>`)
          .join(" ")}</p>`,
      );
    }
    blocks.push(
      `<details>\n<summary><code>${escapeHtml(detail.id)}</code>：${
        comparison === null ? "旧版结果（未提供两档比较）" : escapeHtml(comparisonStatusLine(comparison))
      }</summary>\n${body.join("\n")}\n</details>`,
    );
  }
  return blocks.join("\n");
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
  const reported = model.gateReported.length === 0
    ? ""
    : `<p><strong>仅报告（不参与门禁）</strong></p>\n` +
      htmlUl(model.gateReported.map((note) => `${escapeHtml(note.name)}：${escapeHtml(note.detail)}`));
  return (
    `<table>\n<thead><tr><th>检查</th><th>结论</th><th>说明</th></tr></thead>\n` +
    `<tbody>\n${rows}\n</tbody>\n</table>` +
    (reported.length === 0 ? "" : `\n${reported}`)
  );
}

function renderRatchetHtml(ratchet: RatchetInfo): string {
  const heading = ratchet.profile === "strict" ? "严格一致保护档" : ratchet.profile === "compatibility" ? "兼容保护档" : "旧 T0–T3 归档";
  const parts: string[] = [`<h3>回归记录（${escapeHtml(heading)}）</h3>`];
  if (ratchet.legacy) {
    parts.push(
      '<p class="note">这是旧版 T0–T3 清单：只保留旧分级计数，没有 profile / regressionDetails / blocking 信息；不能用它推断严格一致回归。</p>',
    );
    return parts.join("\n");
  }
  parts.push(
    `<p>回归 ${ratchet.regressions} 项；阻断 ${ratchet.blockingRegressions ?? "未提供"} 项；改善 ${ratchet.improvements} 项。</p>`,
  );
  if (ratchet.regressionDetails.length === 0) {
    parts.push("<p>逐项回归：无</p>");
    return parts.join("\n");
  }
  const rows = ratchet.regressionDetails.map((item) => [
    item.id,
    RATCHET_KIND_LABELS[item.kind],
    item.field ?? "—",
    `${item.was} → ${item.now}`,
    item.reason,
    item.blocking ? "阻断" : "仅报告",
  ]);
  parts.push(htmlTable(["用例", "维度", "字段", "变化", "原因", "门禁"], rows));
  return parts.join("\n");
}

function renderPerfHtml(model: ReportModel): string {
  const perf = model.perf;
  if (perf === null) return '<p class="note">本次运行没有性能附录（未传 <code>--perf-ratio</code>，或产物没有 <code>metrics.perf</code>）。</p>';
  const rows: string[][] = [
    ["口径", `${perfMetricText(perf.metric)}；比值为候选 / 参考 tsc，小于 1 表示候选更快`],
    ["样本", `请求 ${perf.requested ?? "未提供"}，有效 ${perf.size ?? "未提供"}（参考成功 ${perf.referenceOk ?? "未提供"}，失败 ${perf.referenceFailed ?? "未提供"}）`],
    ["抽样 seed", perf.seed ?? "未提供"],
    ["总比值（Check）", ratioText(perf.ratio.check)],
    ["总比值（实际耗时差分）", ratioText(perf.ratio.wallAdjusted)],
    ["总比值（原始实际耗时）", ratioText(perf.ratio.wall)],
    [
      "兼容通过子集",
      `${perf.ratio.agreementCases ?? "未提供"} 例；原始实际耗时 ${ratioText(perf.ratio.agreementWall)}（${formatMs(perf.ratio.agreementImplWallMs)} / ${formatMs(perf.ratio.agreementReferenceWallMs)} ms）；` +
        `Check ${ratioText(perf.ratio.agreementCheck)}；实际耗时差分 ${ratioText(perf.ratio.agreementWallAdjusted)}`,
    ],
    ["逐案 Check", aggregateText(perf.perCase.check)],
    ["逐案实际耗时差分", aggregateText(perf.perCase.wallAdjusted)],
    ["样本构成 · suite", compositionText(perf.composition.suite)],
    ["样本构成 · 行数档", compositionText(perf.composition.lineBucket)],
    ["样本构成 · 有无期望错误", compositionText(perf.composition.errorPresence)],
    ["样本构成 · 顺序对冲", compositionText(perf.composition.order)],
    [
      "累计时间",
      `候选实际耗时均值 ${perf.impl.meanWallMs === null ? "未提供" : `${perf.impl.meanWallMs.toFixed(1)}ms`}；` +
        `空程序基线 ${perf.impl.emptyBaselineMs === null ? "未提供" : `${perf.impl.emptyBaselineMs.toFixed(1)}ms`}；` +
        `Check 合计 ${perf.impl.checkSumMs === null ? "未提供" : `${perf.impl.checkSumMs.toFixed(1)}ms`}；` +
        `参考实际耗时均值 ${perf.reference.meanWallMs === null ? "未提供" : `${perf.reference.meanWallMs.toFixed(1)}ms`}；` +
        `参考 Check 合计 ${perf.reference.checkSumMs === null ? "未提供" : `${perf.reference.checkSumMs.toFixed(1)}ms`}`,
    ],
  ];
  const warnings = perf.warnings.length === 0
    ? ""
    : `<p><strong>性能附录告警</strong></p>\n${htmlUl(perf.warnings.map((warning) => escapeHtml(warning)))}`;
  return `${htmlTable(["项", "值"], rows)}${warnings.length === 0 ? "" : `\n${warnings}`}`;
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
  const fieldRows = delta.fields
    .map(
      (row) =>
        `<tr><td>${escapeHtml(FIELD_LABELS[row.field])}</td>` +
        `<td>${row.before.equal} / ${row.before.different} / ${row.before.unavailable}</td>` +
        `<td>${row.after.equal} / ${row.after.different} / ${row.after.unavailable}</td>` +
        `<td>${escapeHtml(row.change)}</td></tr>`,
    )
    .join("\n");
  const fieldTable = delta.fields.length === 0
    ? ""
    : `\n<p><strong>逐字段分布变化</strong></p>\n` +
      `<table>\n<thead><tr><th>字段</th><th>上次（相同 / 不同 / 未提供）</th><th>本次（相同 / 不同 / 未提供）</th><th>变化</th></tr></thead>\n` +
      `<tbody>\n${fieldRows}\n</tbody>\n</table>`;
  const scopeWarning = delta.scope.comparable || delta.scope.reasons.length === 0
    ? ""
    : `<p class="verdict bad"><strong>范围提示</strong>：${escapeHtml(scopeWarningText(delta))}</p>\n`;
  return (
    scopeWarning +
    `<p class="note">对比基准：${escapeHtml(delta.previousLabel)}</p>\n` +
    `<table>\n<thead><tr><th>指标</th><th>上次</th><th>本次</th><th>变化</th></tr></thead>\n` +
    `<tbody>\n${rows}\n</tbody>\n</table>\n` +
    fieldTable +
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
    const blocking = model.ratchet?.blockingRegressions;
    blocks.push(
      `<p><strong>ratchet 回归 ${callouts.ratchetRegressions} 项</strong>` +
        (blocking === null || blocking === undefined ? "（旧记录未提供阻断信息）" : `（阻断 ${blocking} 项）`) +
        `：清单出现变化，逐项原因见「两档比较」下的回归记录。</p>`,
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
  if (hasNewComparison(model)) {
    const blocked =
      callouts.gateFailed.length > 0 ||
      (callouts.blockingRegressions !== null && callouts.blockingRegressions > 0) ||
      callouts.deltaRegressions.length > 0;
    blocks.push(
      blocked
        ? '<p><strong>门槛结论</strong>：存在阻断项。两档失败项与门禁是否失败分开判断，请对照上方门禁结论。</p>'
        : '<p><strong>门槛结论</strong>：本次没有阻断项；两档比较中的未通过项仅供阅读。</p>',
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
  const legacyNote = '<p class="note">旧 metrics.totals 的 T0–T3 阶梯仅作过渡参考；T3 全文不等于严格一致档。</p>\n';
  return (
    legacyNote +
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
    ["用例列表", model.provenance.manifest ?? "未提供"],
    ...(model.provenance.manifestSha === null ? [] : [["用例列表 SHA-256", model.provenance.manifestSha]]),
    ["选项策略", model.provenance.optionPolicy ?? "未提供"],
    ["原始运行参数", model.provenance.runArgs.length === 0 ? "未提供" : model.provenance.runArgs.join(" ")],
    ...([
      ["参考基础参数", model.provenance.referenceBaseArgs],
      ["共享覆盖参数", model.provenance.sharedArgs],
      ["候选基础参数", model.provenance.candidateArgs],
      ["候选环境参数", model.provenance.candidateEnvArgs],
      ["用例过滤", model.provenance.filters],
    ] as [string, string[]][]).filter(([, values]) => values.length > 0).map(([label, values]) => [label, values.join(" ")]),
    [
      "参考来源",
      [
        model.provenance.reference.version === null ? null : `tsc ${model.provenance.reference.version}`,
        model.provenance.reference.bin === null ? null : `bin ${model.provenance.reference.bin}`,
        model.provenance.reference.sha256 === null ? null : `sha256 ${model.provenance.reference.sha256.slice(0, 12)}`,
        model.provenance.reference.nativeBin === null ? null : `原生 ${model.provenance.reference.nativeBin}`,
        model.provenance.reference.nativeSha256 === null ? null : `原生 sha256 ${model.provenance.reference.nativeSha256.slice(0, 12)}`,
        model.provenance.reference.source === null ? null : `源 ${model.provenance.reference.source}`,
        model.provenance.reference.corpus === null ? null : `语料 ${model.provenance.reference.corpus}`,
        model.provenance.reference.corpusRef === null ? null : `pin ${model.provenance.reference.corpusRef}`,
      ]
        .filter((x): x is string => x !== null)
        .join(" · ") || "未提供",
    ],
    [
      "候选来源",
      [
        model.provenance.candidate.name === null ? null : `名称 ${model.provenance.candidate.name}`,
        model.provenance.candidate.version === null ? null : `版本 ${model.provenance.candidate.version}`,
        model.provenance.candidate.bin === null ? null : `bin ${model.provenance.candidate.bin}`,
        model.provenance.candidate.sha256 === null ? null : `sha256 ${model.provenance.candidate.sha256.slice(0, 12)}`,
        model.provenance.candidate.nativeBin === null ? null : `原生 ${model.provenance.candidate.nativeBin}`,
        model.provenance.candidate.nativeSha256 === null ? null : `原生 sha256 ${model.provenance.candidate.nativeSha256.slice(0, 12)}`,
        model.provenance.candidate.embeddedTypeScript === null ? null : `内置 TypeScript ${model.provenance.candidate.embeddedTypeScript}（Bun 内置，不是参考 tsc 版本）`,
        ...sdkProvenanceBits(model.provenance.candidate.sdk),
        model.provenance.candidate.source === null ? null : `源 ${model.provenance.candidate.source}`,
      ]
        .filter((x): x is string => x !== null)
        .join(" · ") || "未提供",
    ],
    ...(model.provenance.runner === null && model.provenance.platform === null
      ? []
      : [["运行环境", [model.provenance.runner, model.provenance.platform].filter((x): x is string => x !== null).join(" · ")]]),
    ...(model.provenance.adapter === null ? [] : [["适配器", model.provenance.adapter]]),
  ];
  if (model.ratchet !== null) {
    headerRows.push([
      "ratchet",
      `${model.ratchet.path}：` +
        (model.ratchet.initialized
          ? "首次登记"
          : `回归 ${model.ratchet.regressions} 项、改善 ${model.ratchet.improvements} 项`),
    ]);
    headerRows.push([
      "回归保护档",
      (model.ratchet.profile === "strict" ? "严格一致" : model.ratchet.profile === "compatibility" ? "兼容" : "未提供") +
        `（阻断 ${model.ratchet.blockingRegressions === null ? "未提供" : `${model.ratchet.blockingRegressions} 项`}）`,
    ]);
    if (model.ratchet.legacy) {
      headerRows.push(["回归记录格式", "旧 T0–T3：没有 strict / 逐字段回归证据"]);
    }
  }
  headerRows.push([
    "用例",
    `选中 ${model.selectedCases === null ? "未提供" : `${model.selectedCases}（源用例）`} / 实际 ${model.totals.cases}（展开后）：` +
      `跑 ${model.totals.ran}，跳过 ${model.totals.skipped}`,
  ]);

  const sections: string[] = [];
  sections.push(`<h1>${escapeHtml(model.title)}</h1>`);
  sections.push(
    `<div class="verdict${verdictClass}"><strong>${escapeHtml(gateConclusion(model))}</strong>` +
      `<br>覆盖 ${escapeHtml(pct(model.totals.coverage))}｜假阳性 ${model.totals.fpCases} 例 / ${model.totals.fpTotal} 条` +
      `｜漏报 ${model.totals.missTotal}｜错锚 ${model.totals.misanchorTotal}｜跳过 ${model.totals.skipped}</div>`,
  );
  if (hasNewComparison(model)) {
    sections.push(`<div class="verdict"><strong>${escapeHtml(comparisonLine(model).replace(/^> /, ""))}</strong></div>`);
  }
  if (model.delta !== null && !model.delta.scope.comparable && model.delta.scope.reasons.length > 0) {
    sections.push(
      `<div class="verdict bad"><strong>范围提示</strong>：${escapeHtml(scopeWarningText(model.delta))}</div>`,
    );
  }
  sections.push(`<h2>运行信息</h2>\n${htmlTable(["项", "值"], headerRows)}`);
  sections.push(`<h2>摘要</h2>\n${htmlCards(model)}`);
  if (hasNewComparison(model)) {
    sections.push(`<h2>两档比较</h2>\n${renderComparisonHtml(model)}`);
  }
  sections.push(`<h2>T0–T3 阶梯</h2>\n${renderTierHtml(model)}`);
  sections.push(`<h2>门禁结论</h2>\n${renderGateHtml(model)}`);
  sections.push(`<h2>与上次报告对比</h2>\n${renderDeltaHtml(model)}`);
  sections.push(`<h2>失败与回归</h2>\n${renderFailuresHtml(model, callouts)}`);
  if (model.perf !== null) {
    sections.push(`<h2>性能附录</h2>\n${renderPerfHtml(model)}`);
  }
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
