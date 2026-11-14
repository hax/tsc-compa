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

import type { Diagnostic } from "./types.ts";

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
}

const isError = (d: Diagnostic): boolean => d.severity === "error";

const bucketKey = (d: Diagnostic): string => `${d.file}\u0000${d.code}`;
const spotKey = (d: Diagnostic): string => `${d.line}:${d.col}`;

export function compareCase(id: string, expected: Diagnostic[], actual: Diagnostic[], classes: string[] = []): CaseRecord {
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

  return { id, status: "ran", classes, expected: exp, actual: act, fp, missed, hits, misanchor };
}

export function skipRecord(id: string, reason: string, classes: string[] = []): CaseRecord {
  return { id, status: "skip", skipReason: reason, classes, expected: [], actual: [], fp: [], missed: [], hits: 0, misanchor: 0 };
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
  generatedAt: string;
  selectedCases: number;
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
    /** hit / expect；无期望诊断时记 null。 */
    coverage: number | null;
  };
  /** 按标签聚合；标签正交，数字不可相加。 */
  byClass: Record<string, ClassTotals>;
  byCode: { fp: [string, number][]; miss: [string, number][] };
  skips: [string, number][];
  samples: { fp: string[]; miss: string[] };
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
  const classAcc = new Map<string, ClassAcc>();

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
      coverage: expectTotal === 0 ? null : hitTotal / expectTotal,
    },
    byClass,
    byCode: { fp: topEntries(fpByCode, 15), miss: topEntries(missByCode, 15) },
    skips: [...skips.entries()].sort((a, b) => b[1] - a[1]),
    samples: { fp: fpSamples, miss: missSamples },
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
