// 期望 vs 实际：匹配规则与指标汇总。
//
// 判定粒度（L1）：文件 + 行 + 列 + 错误码；宽度只有部分实现提供，缺省时跳过；
// message 暂不比较（L2/L3 见 docs/DESIGN.md）。只比较 error 级：warning 不进
// 分母，避免把实现自己的 warning 口径算进来。
//
// 错锚（misanchor）的正式定义：**同一文件、同一错误码，但位置不同**。
// 这类差异先成对抵消（expected × actual 各取一条），**不计入 fp、也不计入
// miss**，单独累计。它是「判定一致、锚点口径不同」的信号，不能当成兼容性
// 差异（跨 tsc 版本之间尤其常见）；但自比（同版本期望 × 同版本实现）出现
// 错锚就是 harness 的 bug。
//
// 覆盖率分母仍是全部期望诊断，分子只数「位置也一致」的命中，因此错锚会
// 让覆盖率略低于 100%；配套的 misanchor 数字负责解释这部分差额。

import { summaryBlockOf } from "./officialBaseline.ts";
import type { GateReport } from "./gate.ts";
import type { Diagnostic } from "./types.ts";

/**
 * 与官方基线的四级一致性（对齐 reference/tsc-rs 的 Agreement 枚举）：
 * - location（T0）：file / line / col / code 多重集相同，不看文案与 category；
 * - category（T1）：+ severity（error/warning）；
 * - text（T2）：+ 首行 message 完全相同；
 * - full（T3）：整份 `.errors.txt` 字节相等（含 elaboration、related 与顺序）。
 *
 * 无官方基线文件（官方只在有诊断时写基线）时：两侧都为空记 full（无期望错误
 * 且实现沉默）；否则最多到 text。
 */
export type Tier = "none" | "location" | "category" | "text" | "full";

export const TIER_RANK: Record<Tier, number> = { none: 0, location: 1, category: 2, text: 3, full: 4 };

export const TIERS: readonly Tier[] = ["none", "location", "category", "text", "full"];

export interface CaseRecord {
  id: string;
  status: "ran" | "skip";
  skipReason?: string;
  /** 静态 + 运行期标签，见 src/classify.ts。 */
  classes: string[];
  expected: Diagnostic[];
  actual: Diagnostic[];
  /** 多报的诊断（假阳性）；错锚已从中剔除。 */
  fp: Diagnostic[];
  /** 官方期望里没被命中的诊断（漏报）；错锚已从中剔除。 */
  missed: Diagnostic[];
  hits: number;
  /** 同文件同码、位置不同：成对计数，既不算 fp 也不算 miss。 */
  misanchor: number;
  /** 与官方基线的四级一致性（T0~T3）；非 official-baseline 期望源时用「实际诊断 vs 期望诊断」同样计算。 */
  tier: Tier;
  /** T3 未达时的原因分类（只有官方基线存在正文时设置）。 */
  t3Reason?: T3DiffReason;
}

const isError = (d: Diagnostic): boolean => d.severity === "error";

const fmtDiagLine = (d: Diagnostic): string =>
  `${d.file}(${d.line + 1},${d.col + 1}): ${d.severity} TS${d.code}: ${d.message ?? ""}`;

/** 把实现返回的诊断渲染成官方 `.errors.txt` 摘要块的形态（T3 用）。 */
export function renderErrorBlock(diagnostics: Diagnostic[]): string {
  // 优先用实现原样保留的完整块（首行 + 阐述续行）；没有时只能渲染首行（最多到 T2）。
  return diagnostics.map((d) => d.fullText ?? fmtDiagLine(d)).join("\n");
}

const sortedKey = (items: Diagnostic[], include: (d: Diagnostic) => string): string[] =>
  items.map(include).sort((a, b) => a.localeCompare(b));

/** T3 失败原因分类（只有期望源是官方基线、且存在基线正文时才统计）。 */
export type T3DiffReason = "missing" | "extra" | "diagnostics" | "order" | "elaboration" | "related" | "other";

const DIAG_START = /^[^\s].*?\(\d+,\d+\): (?:error|warning) TS\d+:/;
/** related information 的续行形态：`  file(line,col): ...`。 */
const RELATED_LINE = /^\s+\S+\(\d+,\d+\):/;

/** 把摘要块按诊断切成 block（首行 + 缩进续行）；空行忽略。 */
function diagnosticBlocksOf(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim().length === 0) continue;
    if (DIAG_START.test(line)) {
      if (current !== null) blocks.push(current);
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

/**
 * 分类一次 T3 失败：首行（码/位置/文案）一致但阐述不同、related 不同、次序不同，
 * 还是诊断集合本身不同。用于 metrics 的可解释性，不参与任何判定。
 */
export function classifyT3Diff(expectedText: string, actualText: string): T3DiffReason {
  const expBlocks = diagnosticBlocksOf(summaryBlockOf(expectedText));
  const actBlocks = diagnosticBlocksOf(actualText);
  const firstLines = (blocks: string[][]): string[] => blocks.map((b) => b[0]!);
  const expFirst = firstLines(expBlocks);
  const actFirst = firstLines(actBlocks);
  const sorted = (xs: string[]): string[] => [...xs].sort((a, b) => a.localeCompare(b));
  if (expFirst.length !== actFirst.length) return expFirst.length > actFirst.length ? "missing" : "extra";
  if (sorted(expFirst).join("\n") !== sorted(actFirst).join("\n")) return "diagnostics";
  if (expFirst.join("\n") !== actFirst.join("\n")) return "order";
  for (let i = 0; i < expBlocks.length; i++) {
    const expBlock = expBlocks[i]!;
    const actBlock = actBlocks[i]!;
    if (expBlock.join("\n") === actBlock.join("\n")) continue;
    const changed = [...expBlock.slice(1), ...actBlock.slice(1)];
    return changed.some((line) => RELATED_LINE.test(line) || /related information/i.test(line))
      ? "related"
      : "elaboration";
  }
  return "other";
}

/**
 * 计算期望（官方基线或 tsc 现场生成）与实际诊断的四级一致性。
 *
 * @param expectedText 官方基线原文（缺失时为 null）；T3 只比较其第一个 `====`
 *   之前的摘要块（`====` 之后是用例源码标注，不属于诊断文本）。
 * @param actualText 实现渲染的完整摘要块（CaseOutcome.fullText）；缺失时退回
 *   由诊断对象的 fullText/首行拼接。
 */
export function tierOf(
  expected: Diagnostic[],
  actual: Diagnostic[],
  expectedText: string | null = null,
  actualText: string | null = null,
): Tier {
  const exp = expected;
  const act = actual;
  const loc = (d: Diagnostic): string => `${d.file}\u0000${d.line}\u0000${d.col}\u0000${d.code}`;
  if (sortedKey(exp, loc).join("\n") !== sortedKey(act, loc).join("\n")) return "none";
  const cat = (d: Diagnostic): string => `${loc(d)}\u0000${d.severity}`;
  if (sortedKey(exp, cat).join("\n") !== sortedKey(act, cat).join("\n")) return "location";
  const full = (d: Diagnostic): string => `${cat(d)}\u0000${d.message ?? ""}`;
  if (sortedKey(exp, full).join("\n") !== sortedKey(act, full).join("\n")) return "category";
  // T3：整份基线摘要块字节相等（行尾归一后）；没有基线文件时，两侧都空即视为 full。
  const actBlock = actualText ?? renderErrorBlock(act);
  if (expectedText === null) return exp.length === 0 && actBlock.trim() === "" ? "full" : "text";
  return summaryBlockOf(expectedText) === actBlock ? "full" : "text";
}

const bucketKey = (d: Diagnostic): string => `${d.file}\u0000${d.code}`;
const spotKey = (d: Diagnostic): string => `${d.line}:${d.col}`;

export function compareCase(
  id: string,
  expected: Diagnostic[],
  actual: Diagnostic[],
  classes: string[] = [],
  baselineText: string | null = null,
  actualText: string | null = null,
): CaseRecord {
  const exp = expected.filter(isError);
  const act = actual.filter(isError);

  const expBuckets = new Map<string, Diagnostic[]>();
  const actBuckets = new Map<string, Diagnostic[]>();
  for (const d of exp) expBuckets.set(bucketKey(d), [...(expBuckets.get(bucketKey(d)) ?? []), d]);
  for (const d of act) actBuckets.set(bucketKey(d), [...(actBuckets.get(bucketKey(d)) ?? []), d]);

  let hits = 0;
  let misanchor = 0;
  const fp: Diagnostic[] = [];
  const missed: Diagnostic[] = [];
  const keys = new Set([...expBuckets.keys(), ...actBuckets.keys()]);
  for (const key of keys) {
    const bucketExp = expBuckets.get(key) ?? [];
    const bucketAct = actBuckets.get(key) ?? [];
    // 精确位置的多重集匹配（同位置同码可能合法地出现多条）。
    const remaining = new Map<string, number>();
    for (const d of bucketExp) remaining.set(spotKey(d), (remaining.get(spotKey(d)) ?? 0) + 1);
    const restAct: Diagnostic[] = [];
    for (const d of bucketAct) {
      const k = spotKey(d);
      const n = remaining.get(k) ?? 0;
      if (n > 0) {
        hits++;
        remaining.set(k, n - 1);
      } else {
        restAct.push(d);
      }
    }
    const restExp: Diagnostic[] = [];
    for (const d of bucketExp) {
      const k = spotKey(d);
      const n = remaining.get(k) ?? 0;
      if (n > 0) {
        remaining.set(k, n - 1);
        restExp.push(d);
      }
    }
    // 同文件同码、位置不同的剩余项成对归入错锚，其余才计 fp / miss。
    const pairs = Math.min(restExp.length, restAct.length);
    misanchor += pairs;
    fp.push(...restAct.slice(pairs));
    missed.push(...restExp.slice(pairs));
  }

  const tier = tierOf(expected, actual, baselineText, actualText);
  const record: CaseRecord = {
    id,
    status: "ran",
    classes,
    expected: exp,
    actual: act,
    fp,
    missed,
    hits,
    misanchor,
    tier,
  };
  // T3 失败原因只对「官方基线存在正文」的用例归因（无基线 = 期望零错误，归入 fp）。
  if (tier !== "full" && baselineText !== null) {
    record.t3Reason = classifyT3Diff(baselineText, actualText ?? renderErrorBlock(act));
  }
  return record;
}

export function skipRecord(id: string, reason: string, classes: string[] = []): CaseRecord {
  return {
    id,
    status: "skip",
    skipReason: reason,
    classes,
    expected: [],
    actual: [],
    fp: [],
    missed: [],
    hits: 0,
    misanchor: 0,
    tier: "none",
  };
}

export interface RunMeta {
  suite: string;
  corpus: string;
  adapter: string;
  mode: "official" | "fixed";
  /** false 表示这次运行的结果不能作为兼容性结论（口径被刻意对齐/实现忽略选项）。 */
  verdictEligible: boolean;
  tscVersion: string;
  tscBin: string;
  /** 基线名（config/baselines.json 的 id）；不指定时为空。 */
  baseline?: string;
  /** 语料来源版本（repo@ref），用于多基线时区分语料。 */
  corpusRef?: string;
  /** 期望来源；缺省（旧记录）视为 tsc。 */
  expectationSource?: "tsc" | "official-baseline";
  generatedAt: string;
  selectedCases: number;
  /** 设置了 --ratchet / --ratchet-impl 时的对比结果。 */
  ratchet?: {
    path: string;
    /** 按实现分账时的实现名（config/implementations.json 的 key 或自定义名）。 */
    impl?: string;
    /** 本次运行是否首次创建清单（只登记当前档位、不作回落判定）。 */
    initialized?: boolean;
    regressions: number;
    improvements: number;
    wrote: boolean;
  };
  /** 设置了 --gate 时的门禁结论（逐项检查结果，CI 用它判断红绿）。 */
  gate?: GateReport;
}

export interface ClassTotals {
  cases: number;
  ran: number;
  skipped: number;
  fpCases: number;
  fpTotal: number;
  expectTotal: number;
  hitTotal: number;
  missTotal: number;
  misanchorCases: number;
  misanchorTotal: number;
  coverage: number | null;
}

export interface Metrics {
  meta: RunMeta;
  totals: {
    cases: number;
    ran: number;
    skipped: number;
    /** 完全一致（fp、漏报、错锚都为 0）的用例数。 */
    passCases: number;
    /** fp=0 的用例数（允许漏报与错锚）。 */
    fpFreeCases: number;
    fpCases: number;
    fpTotal: number;
    /** 含错锚的用例数与错锚条数（错锚不计入 fp/miss）。 */
    misanchorCases: number;
    misanchorTotal: number;
    expectTotal: number;
    hitTotal: number;
    missTotal: number;
    /** 位置命中但首行文案不同的诊断条数（T0 与 T2 的差）。 */
    messageMismatch: number;
    /** hit / expect；无期望诊断时记 null。 */
    coverage: number | null;
    /** 与官方基线的四级一致性分布（只统计跑完的用例）。 */
    byTier: Record<Tier, number>;
    /** T3 未达用例的原因分布（diagnostics/order/elaboration/related/other）。 */
    t3Failures: [string, number][];
  };
  /** 按标签聚合；标签正交，数字不可相加。 */
  byClass: Record<string, ClassTotals>;
  byCode: { fp: [string, number][]; miss: [string, number][] };
  skips: [string, number][];
  samples: { fp: string[]; miss: string[]; textDiff: string[]; messageDiff: string[]; t3: string[] };
}

const fmtDiag = (id: string, d: Diagnostic): string => `${id} ${d.file}:${d.line + 1}:${d.col + 1} TS${d.code}`;

const topEntries = (m: Map<number, number>, n: number): [string, number][] =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([code, count]) => [`TS${code}`, count]);

interface ClassAcc {
  cases: number;
  ran: number;
  skipped: number;
  fpCases: number;
  fpTotal: number;
  expectTotal: number;
  hitTotal: number;
  missTotal: number;
  misanchorCases: number;
  misanchorTotal: number;
}

export function summarize(records: CaseRecord[], meta: RunMeta): Metrics {
  let ran = 0;
  let passCases = 0;
  let fpFreeCases = 0;
  let fpCases = 0;
  let fpTotal = 0;
  let misanchorCases = 0;
  let misanchorTotal = 0;
  let expectTotal = 0;
  let hitTotal = 0;
  let missTotal = 0;
  const fpByCode = new Map<number, number>();
  const missByCode = new Map<number, number>();
  const skips = new Map<string, number>();
  const fpSamples: string[] = [];
  const missSamples: string[] = [];
  const textDiffSamples: string[] = [];
  const messageDiffSamples: string[] = [];
  let messageMismatch = 0;
  const byTier: Record<Tier, number> = { none: 0, location: 0, category: 0, text: 0, full: 0 };
  const t3Reasons = new Map<string, number>();
  const t3Samples: string[] = [];
  const classAcc = new Map<string, ClassAcc>();

  /** T2 未达（T0/T1 已达、文案不同）的样例，供「文案对齐待办」用。 */
  const textDiffSample = (r: CaseRecord): string | null => {
    if (r.tier !== "category") return null;
    const actualByKey = new Map<string, Diagnostic>();
    for (const d of r.actual) {
      const key = `${d.file}\u0000${d.line}\u0000${d.col}\u0000${d.code}`;
      if (!actualByKey.has(key)) actualByKey.set(key, d);
    }
    const trunc = (s: string | undefined): string => (s ?? "(无)").slice(0, 100);
    for (const d of r.expected) {
      const actual = actualByKey.get(`${d.file}\u0000${d.line}\u0000${d.col}\u0000${d.code}`);
      if (actual !== undefined && (actual.message ?? "") !== (d.message ?? "")) {
        return `${r.id} ${d.file}:${d.line + 1}:${d.col + 1} TS${d.code} expected="${trunc(d.message)}" actual="${trunc(actual.message)}"`;
      }
    }
    return `${r.id}（诊断位置一致但文案不同）`;
  };

  for (const r of records) {
    for (const tag of r.classes) {
      const acc =
        classAcc.get(tag) ??
        {
          cases: 0,
          ran: 0,
          skipped: 0,
          fpCases: 0,
          fpTotal: 0,
          expectTotal: 0,
          hitTotal: 0,
          missTotal: 0,
          misanchorCases: 0,
          misanchorTotal: 0,
        };
      acc.cases++;
      if (r.status === "skip") acc.skipped++;
      else {
        acc.ran++;
        acc.expectTotal += r.expected.length;
        acc.hitTotal += r.hits;
        acc.missTotal += r.missed.length;
        acc.misanchorTotal += r.misanchor;
        if (r.fp.length > 0) {
          acc.fpCases++;
          acc.fpTotal += r.fp.length;
        }
        if (r.misanchor > 0) acc.misanchorCases++;
      }
      classAcc.set(tag, acc);
    }

    if (r.status === "skip") {
      const reason = r.skipReason ?? "unknown";
      skips.set(reason, (skips.get(reason) ?? 0) + 1);
      continue;
    }
    ran++;
    expectTotal += r.expected.length;
    hitTotal += r.hits;
    missTotal += r.missed.length;
    misanchorTotal += r.misanchor;
    byTier[r.tier]++;
    if (r.t3Reason !== undefined) {
      t3Reasons.set(r.t3Reason, (t3Reasons.get(r.t3Reason) ?? 0) + 1);
      if (t3Samples.length < 40) t3Samples.push(`${r.id} ${r.t3Reason}`);
    }
    // 诊断级「文案差」：位置（file/line/col/code）命中但首行 message 不同。
    {
      const actualByKey = new Map<string, Diagnostic>();
      for (const d of r.actual) {
        const key = `${d.file}\u0000${d.line}\u0000${d.col}\u0000${d.code}`;
        if (!actualByKey.has(key)) actualByKey.set(key, d);
      }
      for (const d of r.expected) {
        const actual = actualByKey.get(`${d.file}\u0000${d.line}\u0000${d.col}\u0000${d.code}`);
        if (actual === undefined) continue;
        if ((actual.message ?? "") === (d.message ?? "")) continue;
        messageMismatch++;
        if (messageDiffSamples.length < 40) {
          const trunc = (x: string | undefined): string => (x ?? "(无)").slice(0, 100);
          messageDiffSamples.push(
            `${r.id} ${d.file}:${d.line + 1}:${d.col + 1} TS${d.code} expected="${trunc(d.message)}" actual="${trunc(actual.message)}"`,
          );
        }
      }
    }
    if (textDiffSamples.length < 40) {
      const sample = textDiffSample(r);
      if (sample !== null) textDiffSamples.push(sample);
    }
    if (r.misanchor > 0) misanchorCases++;
    if (r.fp.length === 0) fpFreeCases++;
    if (r.fp.length === 0 && r.missed.length === 0 && r.misanchor === 0) passCases++;
    if (r.fp.length > 0) {
      fpCases++;
      fpTotal += r.fp.length;
      for (const d of r.fp) {
        fpByCode.set(d.code, (fpByCode.get(d.code) ?? 0) + 1);
        if (fpSamples.length < 40) fpSamples.push(fmtDiag(r.id, d));
      }
    }
    for (const d of r.missed) {
      missByCode.set(d.code, (missByCode.get(d.code) ?? 0) + 1);
      if (missSamples.length < 40) missSamples.push(fmtDiag(r.id, d));
    }
  }

  const byClass: Record<string, ClassTotals> = {};
  for (const [tag, acc] of [...classAcc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byClass[tag] = {
      ...acc,
      coverage: acc.expectTotal === 0 ? null : acc.hitTotal / acc.expectTotal,
    };
  }

  return {
    meta,
    totals: {
      cases: records.length,
      ran,
      skipped: records.length - ran,
      passCases,
      fpFreeCases,
      fpCases,
      fpTotal,
      misanchorCases,
      misanchorTotal,
      expectTotal,
      hitTotal,
      missTotal,
      messageMismatch,
      coverage: expectTotal === 0 ? null : hitTotal / expectTotal,
      byTier,
      t3Failures: [...t3Reasons.entries()].sort((a, b) => b[1] - a[1]),
    },
    byClass,
    byCode: { fp: topEntries(fpByCode, 15), miss: topEntries(missByCode, 15) },
    skips: [...skips.entries()].sort((a, b) => b[1] - a[1]),
    samples: { fp: fpSamples, miss: missSamples, textDiff: textDiffSamples, messageDiff: messageDiffSamples, t3: t3Samples },
  };
}

export function formatSummary(m: Metrics): string {
  const t = m.totals;
  const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const lines = [
    `tsc-compa ${m.meta.suite} — 用例 ${t.cases}：跑 ${t.ran}，完全通过 ${t.passCases}，跳过 ${t.skipped}`,
    `假阳性 ${t.fpCases} 用例 / ${t.fpTotal} 条；覆盖 ${t.hitTotal}/${t.expectTotal} = ${pct(t.coverage)}；漏报 ${t.missTotal}；错锚 ${t.misanchorCases} 用例 / ${t.misanchorTotal} 条（不计入 fp/miss）`,
  ];
  if (m.byCode.fp.length > 0) lines.push(`top fp：${m.byCode.fp.map(([c, n]) => `${c}×${n}`).join(" ")}`);
  if (m.byCode.miss.length > 0) lines.push(`top miss：${m.byCode.miss.map(([c, n]) => `${c}×${n}`).join(" ")}`);
  const tierText = TIERS.map((t) => `${t}=${m.totals.byTier[t]}`).join(" ");
  lines.push(`分档（T0~T3）：${tierText}；命中位置但文案不同 ${m.totals.messageMismatch} 条`);
  if (m.totals.t3Failures.length > 0) {
    lines.push(`T3 未达原因：${m.totals.t3Failures.map(([r, n]) => `${r}×${n}`).join(" ")}`);
  }
  for (const tag of ["suite:compiler", "suite:conformance"]) {
    const cls = m.byClass[tag];
    if (cls === undefined) continue;
    lines.push(
      `分类 ${tag}：跑 ${cls.ran}，假阳性 ${cls.fpCases} 例 / ${cls.fpTotal} 条，覆盖 ${pct(cls.coverage)}，错锚 ${cls.misanchorTotal} 条`,
    );
  }
  if (m.skips.length > 0) lines.push(`skip：${m.skips.map(([r, n]) => `${r}×${n}`).join("、")}`);
  lines.push(
    `口径：adapter=${m.meta.adapter} mode=${m.meta.mode}` +
      (m.meta.baseline !== undefined ? ` baseline=${m.meta.baseline}` : "") +
      ` tsc=${m.meta.tscVersion}` +
      (m.meta.verdictEligible ? "" : "（本次运行不能作为兼容性结论）"),
  );
  return lines.join("\n");
}
