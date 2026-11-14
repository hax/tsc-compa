// 兼容性跑附带的性能附录：同一轮内用官方 tsc 作参考，算实现/官方的耗时比值。
//
// 设计约束（见 docs/DESIGN.md「性能附录」）：
// - 正确性是主目标，性能只是附录：不参与退出码、不设门禁、不改变判定。
// - 实现侧计时在正常兼容跑里免费获得（每案 adapter.check 前后计时），不额外跑实现。
// - 参考 tsc 只跑一个固定分层样本（默认 300 例：suite × 行数档 × 有无期望错误），
//   每案一次新进程；成本约 20 秒量级。
// - 两边都用 CLI one-shot（每案新进程），避免进程内缓存跨案变热；顺序对半对冲：
//   样本按 hash 排序后前一半先跑参考、后一半先跑实现，抵消早晚时间窗偏差。
// - 头条是 Check 相位累加比（--extendedDiagnostics 的 Check time）；实现拿不到相位时
//   退到「wall − 空程序基线」，并在 warnings 里标注含 parse/bind/渲染。
// - 绝对数值不作结论，只报比值；同时给样本量/组成、原始累加时间、逐案比值的
//   中位数/几何均值/四分位、判定一致子集与公平性说明。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeCase } from "./case.ts";
import type { CaseFile } from "./types.ts";

export interface PhaseStats {
  /** 毫秒。只保留识别到的相位（tsc/tsgo 的字段名可能不同）。 */
  parseMs?: number;
  bindMs?: number;
  checkMs?: number;
  emitMs?: number;
  totalMs?: number;
  /** tsc 系的计数统计（Symbols/Types/Instantiations 等），有就记。 */
  counts?: Record<string, number>;
}

export interface ReferenceRun {
  status: "ok" | "timeout" | "crash";
  wallMs: number;
  stats?: PhaseStats;
  message?: string;
}

/** 抽样分层用的用例元信息（预扫描得到；hasErrors 未知时不参与分层）。 */
export interface PerfCaseMeta {
  lines: number;
  hasErrors?: boolean;
}

/** 逐案比值的聚合（对数比更稳，几何均值用于跨案汇总）。 */
export interface Aggregate {
  n: number;
  median: number;
  geomean: number;
  p25: number;
  p75: number;
}

const LINE_BUCKETS: [string, number][] = [
  ["<=50", 50],
  ["51-200", 200],
  ["201-1000", 1000],
  [" >1000", Number.POSITIVE_INFINITY],
];

/** 行数档：与 tsc 用例的常见规模对齐，便于分层抽样。 */
export function lineBucketOf(lines: number): string {
  for (const [name, upper] of LINE_BUCKETS) {
    if (lines <= upper) return name;
  }
  return " >1000";
}

export interface PerfReport {
  enabled: true;
  sample: {
    seed: string;
    requested: number;
    size: number;
    referenceOk: number;
    referenceFailed: number;
    /** 实际进入比值的样本组成（供检查分层是否合理）。 */
    composition: {
      suite: Record<string, number>;
      lineBucket: Record<string, number>;
      errorPresence: Record<string, number>;
      order: Record<string, number>;
    };
  };
  metric: "check" | "wall-adjusted";
  impl: { sumWallMs: number; meanWallMs: number; emptyBaselineMs: number | null; checkSumMs: number | null };
  reference: {
    sumWallMs: number;
    meanWallMs: number;
    emptyBaselineMs: number | null;
    checkSumMs: number | null;
    parseSumMs: number | null;
    bindSumMs: number | null;
    counts: Record<string, number>;
  };
  ratio: {
    /** (implSum − N·implEmpty) / (refSum − N·refEmpty)；分母不可用时为 null。 */
    wallAdjusted: number | null;
    /** 两侧都有 Check 相位时的累加比；实现通常拿不到，故多为 null。 */
    check: number | null;
    /** 只取「判定完全一致（fp/miss/错锚均为 0）」的子集再算一遍。 */
    agreementSubset: { cases: number; wallAdjusted: number | null; check: number | null };
    /** 逐案比值的聚合（比值分布比总量比更能暴露个案噪声）。 */
    perCase: { check: Aggregate | null; wallAdjusted: Aggregate | null };
  };
  warnings: string[];
}

const TIME_LINE = /^\s*([A-Za-z][A-Za-z0-9 &]*?)\s*time:\s*([0-9.]+)\s*s\s*$/;
const COUNT_LINE = /^\s*(Files|Lines|Identifiers|Symbols|Types|Instantiations|Memory used|Memory allocs):\s*([0-9]+)/;

/**
 * 解析 tsc 的 `--extendedDiagnostics` 输出。
 *
 * 兼容字段差异：tsc 是 `Parse time/Bind time/Check time/Total time`；tsz 是
 * `Parse & Bind time`（记为 parse+bind 两项的近似，独立字段不写）；未识别
 * 的相位行忽略。没有任何 `* time:` 行时返回 null（该实现无相位能力）。
 */
export function parseExtendedDiagnostics(text: string): PhaseStats | null {
  const stats: PhaseStats = {};
  let sawTime = false;
  for (const line of text.split(/\r?\n/)) {
    const t = TIME_LINE.exec(line);
    if (t !== null) {
      sawTime = true;
      const ms = Number(t[2]) * 1000;
      const name = t[1]!.trim().toLowerCase();
      if (name === "parse") stats.parseMs = ms;
      else if (name === "bind") stats.bindMs = ms;
      else if (name === "check") stats.checkMs = ms;
      else if (name === "emit") stats.emitMs = ms;
      else if (name === "total") stats.totalMs = ms;
      continue;
    }
    const c = COUNT_LINE.exec(line);
    if (c !== null) {
      (stats.counts ??= {})[c[1]!] = Number(c[2]);
    }
  }
  return sawTime ? stats : null;
}

/** 跑一次官方 tsc（每案新进程）；args 由调用方拼好（含 --extendedDiagnostics）。 */
export function runReference(tscBin: string, files: CaseFile[], args: string[], timeoutMs = 120_000): ReferenceRun {
  const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-perf-"));
  try {
    const paths = materializeCase(tmp, files);
    const started = performance.now();
    const r = spawnSync(tscBin, [...args, ...paths], {
      cwd: tmp,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: timeoutMs,
    });
    const wallMs = performance.now() - started;
    if (r.error !== undefined) {
      const timeout = /ETIMEDOUT|timed out/i.test(String(r.error));
      return { status: timeout ? "timeout" : "crash", wallMs, message: String(r.error) };
    }
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return { status: "ok", wallMs, stats: parseExtendedDiagnostics(text) ?? undefined };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 抽样用的确定性排序键。 */
export function sampleKey(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}\u0000${id}`).digest("hex");
}

/**
 * 确定性的分层抽样：按 (suite, 行数档, 有无期望错误) 分组，配额按组大小比例分配
 * （每组至少 1），组内按 (seed,id) 的 hash 排序取前若干。同一 seed 与用例集总是
 * 得到同一批样本，跨轮可对比；预扫描没有 hasErrors 时按 unknown 档处理。
 */
export function selectPerfSample(
  ids: string[],
  size: number,
  seed: string,
  meta?: Map<string, PerfCaseMeta>,
): string[] {
  if (size <= 0 || ids.length === 0) return [];
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const suite = id.split("/")[0] ?? "other";
    const m = meta?.get(id);
    const bucket = m === undefined ? "unknown" : lineBucketOf(m.lines);
    const err = m?.hasErrors === undefined ? "unknown" : m.hasErrors ? "errors" : "clean";
    const key = `${suite}|${bucket}|${err}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [id]);
    else list.push(id);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => sampleKey(seed, a).localeCompare(sampleKey(seed, b)));
  }
  const total = ids.length;
  const picked: string[] = [];
  let remaining = Math.min(size, total);
  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [, list] of entries) {
    if (remaining <= 0) break;
    const quota = Math.max(1, Math.round((list.length / total) * size));
    const take = Math.min(quota, list.length, remaining);
    picked.push(...list.slice(0, take));
    remaining -= take;
  }
  // 配额四舍五入后可能多/少一两条：多则截断，少则从剩余未选里按 hash 补齐。
  if (picked.length > size) picked.length = size;
  if (picked.length < Math.min(size, total)) {
    const chosen = new Set(picked);
    const rest = [...ids].filter((id) => !chosen.has(id));
    rest.sort((a, b) => sampleKey(seed, a).localeCompare(sampleKey(seed, b)));
    for (const id of rest) {
      if (picked.length >= Math.min(size, total)) break;
      picked.push(id);
    }
  }
  return picked;
}

/**
 * 顺序对冲：样本按 hash 排序，前一半标 ref-first（先跑参考 tsc 再跑实现），
 * 后一半标 impl-first。确定性、可复现，抵消「实现总早于参考」的时间窗偏差。
 */
export function planPerfOrder(sampleIds: string[], seed: string): Map<string, "ref-first" | "impl-first"> {
  const sorted = [...sampleIds].sort((a, b) => sampleKey(seed, a).localeCompare(sampleKey(seed, b)));
  const plan = new Map<string, "ref-first" | "impl-first">();
  const half = Math.ceil(sorted.length / 2);
  sorted.forEach((id, i) => plan.set(id, i < half ? "ref-first" : "impl-first"));
  return plan;
}

const medianOf = (sorted: number[]): number => {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** 逐案比值的聚合：中位数、几何均值、P25/P75。非正比值（不可比）先剔除。 */
export function aggregateRatios(values: number[]): Aggregate | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const geomean = Math.exp(sorted.reduce((acc, v) => acc + Math.log(v), 0) / sorted.length);
  return {
    n: sorted.length,
    median: medianOf(sorted),
    geomean,
    p25: quantileOf(sorted, 0.25),
    p75: quantileOf(sorted, 0.75),
  };
}

export interface PerfReportInput {
  seed: string;
  requested: number;
  /** 抽样出的用例 id（顺序无关）。 */
  sampleIds: string[];
  /** 实现侧每案 wall（毫秒），在正常兼容跑里记录。 */
  implWalls: Map<string, number>;
  /** 实现空程序基线 wall；null 表示不可用。 */
  implEmptyWallMs: number | null;
  /** 参考 tsc 每案结果。 */
  reference: Map<string, ReferenceRun>;
  /** 实现自报的每案 Check 时间（可选；tsc 系 CLI 适配器可提供）。 */
  implCheckMs: Map<string, number>;
  /** 判定完全一致的用例 id 集合（fp/miss/错锚均为 0）。 */
  agreementIds: Set<string>;
  /** 抽样分层元信息（行数 / 有无期望错误），用于样本组成报告。 */
  meta?: Map<string, PerfCaseMeta>;
  /** 顺序对冲计划（前一半 ref-first、后一半 impl-first），用于样本组成报告。 */
  order?: Map<string, "ref-first" | "impl-first">;
  warnings: string[];
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

function ratioOf(implSum: number, implBase: number | null, refSum: number, refBase: number | null, n: number): number | null {
  if (implBase === null || refBase === null || n <= 0) return null;
  const denom = refSum - n * refBase;
  if (!(denom > 0)) return null;
  const numer = implSum - n * implBase;
  if (!(numer > 0)) return null;
  return numer / denom;
}

/** 汇总性能附录；只用「参考 tsc 成功」的样本进入分母。 */
export function buildPerfReport(input: PerfReportInput): PerfReport {
  const sample = input.sampleIds;
  const okIds = sample.filter((id) => input.reference.get(id)?.status === "ok" && input.implWalls.has(id));
  const refRuns = okIds.map((id) => input.reference.get(id)!);
  const implWalls = okIds.map((id) => input.implWalls.get(id)!);
  const n = okIds.length;

  const refSum = sum(refRuns.map((r) => r.wallMs));
  const implSum = sum(implWalls);
  const checkValues = refRuns.map((r) => r.stats?.checkMs).filter((v): v is number => typeof v === "number");
  const checkSum = checkValues.length === n && n > 0 ? sum(checkValues) : null;
  const implCheckValues = okIds.map((id) => input.implCheckMs.get(id)).filter((v): v is number => typeof v === "number");
  const implCheckSum = implCheckValues.length === n && n > 0 ? sum(implCheckValues) : null;
  const parseSum = refRuns.every((r) => typeof r.stats?.parseMs === "number") && n > 0 ? sum(refRuns.map((r) => r.stats!.parseMs!)) : null;
  const bindSum = refRuns.every((r) => typeof r.stats?.bindMs === "number") && n > 0 ? sum(refRuns.map((r) => r.stats!.bindMs!)) : null;
  const counts: Record<string, number> = {};
  for (const r of refRuns) {
    for (const [k, v] of Object.entries(r.stats?.counts ?? {})) counts[k] = (counts[k] ?? 0) + v;
  }

  // 参考空程序基线由调用方以 "__empty__" 放进 reference；不参与样本分母。
  const refEmpty = input.reference.get("__empty__")?.wallMs ?? null;
  const wallAdj = ratioOf(implSum, input.implEmptyWallMs, refSum, refEmpty, n);

  // 只有两侧都有 Check 相位时口径才统一到 Check；否则统一退到 wall − 空程序基线。
  const metric: "check" | "wall-adjusted" = implCheckSum !== null && checkSum !== null ? "check" : "wall-adjusted";

  const warnings = [...input.warnings];
  if (implCheckSum === null) {
    warnings.push("实现未自报 Check 相位；使用 wall − 空程序基线（含用户 parse/bind/渲染），不可与 Check 相位横比");
  } else if (checkSum === null) {
    warnings.push("参考 tsc 未提供 Check 相位；使用 wall − 空程序基线");
  }
  if (n < sample.length) {
    warnings.push(`样本中 ${sample.length - n} 例参考 tsc 未成功，已从分母剔除`);
  }
  if (refEmpty === null) warnings.push("参考空程序基线运行失败，wall-adjusted ratio 不可用");
  if (wallAdj === null && refEmpty !== null && input.implEmptyWallMs !== null) {
    warnings.push("wall-adjusted 比值不可用：空程序基线估计不稳定（分母/分子非正）");
  }

  // wall 差分要求参考分母里有「非固定成本」的余量；tsc 每案 wall 大头是
  // 启动/lib 时差分只剩噪声，标 null 而不是给一个看似精确的值。
  let warnedDenom = false;
  const refDenom = refEmpty === null ? null : refSum - n * refEmpty;
  let wallAdjusted = wallAdj;
  if (wallAdjusted !== null && refDenom !== null && refDenom < Math.max(n, refSum * 0.1)) {
    wallAdjusted = null;
    warnings.push("参考 tsc 每案固定成本占主导，wall 差分不可靠；等实现自报 Check 相位后再比");
    warnedDenom = true;
  }

  const agreement = okIds.filter((id) => input.agreementIds.has(id));
  const agRef = agreement.map((id) => input.reference.get(id)!);
  const agImpl = agreement.map((id) => input.implWalls.get(id)!);
  const agWallRaw = ratioOf(sum(agImpl), input.implEmptyWallMs, sum(agRef.map((r) => r.wallMs)), refEmpty, agreement.length);
  const agWall = warnedDenom ? null : agWallRaw;
  const agCheckValues = agreement.map((id) => input.implCheckMs.get(id)).filter((v): v is number => typeof v === "number");
  const agRefCheckValues = agRef.map((r) => r.stats?.checkMs).filter((v): v is number => typeof v === "number");
  const agCheck =
    agreement.length > 0 &&
    agCheckValues.length === agreement.length &&
    agRefCheckValues.length === agreement.length &&
    sum(agRefCheckValues) > 0
      ? sum(agCheckValues) / sum(agRefCheckValues)
      : null;
  const checkRatio = implCheckSum !== null && checkSum !== null && checkSum > 0 ? implCheckSum / checkSum : null;

  // 样本组成：让读者能检查分层是否合理（suite/行数档/有无期望错误/对冲顺序）。
  const composition: PerfReport["sample"]["composition"] = {
    suite: {},
    lineBucket: {},
    errorPresence: {},
    order: {},
  };
  const bump = (record: Record<string, number>, key: string): void => {
    record[key] = (record[key] ?? 0) + 1;
  };
  for (const id of okIds) {
    bump(composition.suite, id.split("/")[0] ?? "other");
    const m = input.meta?.get(id);
    bump(composition.lineBucket, m === undefined ? "unknown" : lineBucketOf(m.lines));
    bump(composition.errorPresence, m?.hasErrors === undefined ? "unknown" : m.hasErrors ? "errors" : "clean");
    bump(composition.order, input.order?.get(id) ?? "unknown");
  }

  // 逐案比例：check 口径只对「两侧都有 Check」的案；wall 口径扣空程序基线后要求为正。
  const perCaseCheck: number[] = [];
  const perCaseWall: number[] = [];
  for (const id of okIds) {
    const ref = input.reference.get(id)!;
    const implCheck = input.implCheckMs.get(id);
    const refCheck = ref.stats?.checkMs;
    if (typeof implCheck === "number" && typeof refCheck === "number" && refCheck > 0) {
      perCaseCheck.push(implCheck / refCheck);
    }
    const implWall = input.implWalls.get(id)!;
    if (input.implEmptyWallMs !== null && refEmpty !== null) {
      const implAdj = implWall - input.implEmptyWallMs;
      const refAdj = ref.wallMs - refEmpty;
      if (implAdj > 0 && refAdj > 0) perCaseWall.push(implAdj / refAdj);
    }
  }

  return {
    enabled: true,
    sample: {
      seed: input.seed,
      requested: input.requested,
      size: n,
      referenceOk: n,
      referenceFailed: sample.length - n,
      composition,
    },
    metric,
    impl: { sumWallMs: implSum, meanWallMs: n > 0 ? implSum / n : 0, emptyBaselineMs: input.implEmptyWallMs, checkSumMs: implCheckSum },
    reference: {
      sumWallMs: refSum,
      meanWallMs: n > 0 ? refSum / n : 0,
      emptyBaselineMs: refEmpty,
      checkSumMs: checkSum,
      parseSumMs: parseSum,
      bindSumMs: bindSum,
      counts,
    },
    ratio: {
      wallAdjusted,
      check: checkRatio,
      agreementSubset: { cases: agreement.length, wallAdjusted: agWall, check: agCheck },
      perCase: {
        check: aggregateRatios(perCaseCheck),
        wallAdjusted: aggregateRatios(perCaseWall),
      },
    },
    warnings,
  };
}
