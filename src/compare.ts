// 期望 vs 实际：匹配规则与指标汇总。
//
// v0 判定粒度：文件 + 行 + 列 + 错误码。宽度只有部分实现提供，缺省时跳过；
// message 暂不比较（后续「L2 位置 / L3 文案」升级见 docs/DESIGN.md）。
// 只比较 error 级：warning 不进分母，避免把实现自己的 warning 口径算进来。

import type { Diagnostic } from "./types.ts";

export interface CaseRecord {
  id: string;
  status: "ran" | "skip";
  skipReason?: string;
  expected: Diagnostic[];
  actual: Diagnostic[];
  /** 多报的诊断（假阳性）。 */
  fp: Diagnostic[];
  /** 官方期望里没被命中的诊断（漏报）。 */
  missed: Diagnostic[];
  hits: number;
  /** 同文件同码但位置不同：同时计入 fp 与 miss 的「错锚」噪声。 */
  misanchor: number;
}

const isError = (d: Diagnostic): boolean => d.severity === "error";

const sameSpot = (a: Diagnostic, b: Diagnostic): boolean =>
  a.file === b.file && a.line === b.line && a.col === b.col && a.code === b.code;

export function compareCase(id: string, expected: Diagnostic[], actual: Diagnostic[]): CaseRecord {
  const exp = expected.filter(isError);
  const act = actual.filter(isError);
  const fp: Diagnostic[] = [];
  for (const a of act) {
    if (!exp.some((e) => sameSpot(a, e))) fp.push(a);
  }
  const missed: Diagnostic[] = [];
  let hits = 0;
  for (const e of exp) {
    if (act.some((a) => sameSpot(a, e))) hits++;
    else missed.push(e);
  }
  const misanchor = fp.filter((a) => exp.some((e) => e.file === a.file && e.code === a.code)).length;
  return { id, status: "ran", expected: exp, actual: act, fp, missed, hits, misanchor };
}

export function skipRecord(id: string, reason: string): CaseRecord {
  return { id, status: "skip", skipReason: reason, expected: [], actual: [], fp: [], missed: [], hits: 0, misanchor: 0 };
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
  generatedAt: string;
  selectedCases: number;
}

export interface Metrics {
  meta: RunMeta;
  totals: {
    cases: number;
    ran: number;
    skipped: number;
    /** fp=0 且没有漏报的用例数。 */
    passCases: number;
    /** fp=0 的用例数（允许漏报，用于「不误报」视角）。 */
    fpFreeCases: number;
    fpCases: number;
    fpTotal: number;
    expectTotal: number;
    hitTotal: number;
    missTotal: number;
    /** hit / expect；无期望诊断时记 null。 */
    coverage: number | null;
    misanchorTotal: number;
  };
  byCode: { fp: [string, number][]; miss: [string, number][] };
  skips: [string, number][];
  samples: { fp: string[]; miss: string[] };
}

const fmtDiag = (id: string, d: Diagnostic): string =>
  `${id} ${d.file}:${d.line + 1}:${d.col + 1} TS${d.code}`;

const topEntries = (m: Map<number, number>, n: number): [string, number][] =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([code, count]) => [`TS${code}`, count]);

export function summarize(records: CaseRecord[], meta: RunMeta): Metrics {
  let ran = 0;
  let passCases = 0;
  let fpFreeCases = 0;
  let fpCases = 0;
  let fpTotal = 0;
  let expectTotal = 0;
  let hitTotal = 0;
  let missTotal = 0;
  let misanchorTotal = 0;
  const fpByCode = new Map<number, number>();
  const missByCode = new Map<number, number>();
  const skips = new Map<string, number>();
  const fpSamples: string[] = [];
  const missSamples: string[] = [];

  for (const r of records) {
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
    if (r.fp.length === 0) fpFreeCases++;
    if (r.fp.length === 0 && r.missed.length === 0) passCases++;
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
      expectTotal,
      hitTotal,
      missTotal,
      coverage: expectTotal === 0 ? null : hitTotal / expectTotal,
      misanchorTotal,
    },
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
    `假阳性 ${t.fpCases} 用例 / ${t.fpTotal} 条；覆盖 ${t.hitTotal}/${t.expectTotal} = ${pct(t.coverage)}；漏报 ${t.missTotal}；错锚 ${t.misanchorTotal}`,
  ];
  if (m.byCode.fp.length > 0) lines.push(`top fp：${m.byCode.fp.map(([c, n]) => `${c}×${n}`).join(" ")}`);
  if (m.byCode.miss.length > 0) lines.push(`top miss：${m.byCode.miss.map(([c, n]) => `${c}×${n}`).join(" ")}`);
  if (m.skips.length > 0) lines.push(`skip：${m.skips.map(([r, n]) => `${r}×${n}`).join("、")}`);
  lines.push(
    `口径：adapter=${m.meta.adapter} mode=${m.meta.mode} tsc=${m.meta.tscVersion}` +
      (m.meta.verdictEligible ? "" : "（本次运行不能作为兼容性结论）"),
  );
  return lines.join("\n");
}
