// 兼容性跑附带的性能附录：同一轮内用官方 tsc 作参考，算实现/官方的耗时比值。
//
// 设计约束（见 docs/DESIGN.md「性能附录」）：
// - 正确性是主目标，性能只是附录：不参与退出码、不设门禁、不改变判定。
// - 实现侧计时在正常兼容跑里免费获得（每案 adapter.check 前后计时），不额外跑实现。
// - 参考 tsc 只跑一个固定分层样本（默认 300 例），每案一次新进程；成本约 20 秒量级。
// - 两边都用 CLI one-shot（每案新进程），避免进程内缓存跨案变热。
// - 头条是 Check 相位累加比（tsc 的 --extendedDiagnostics 给 Parse/Bind/Check/Total）；
//   实现拿不到相位时退到「wall − 空程序基线」，并在 warnings 里标注含 parse/bind/渲染。
// - 绝对数值不作结论，只报比值；同时给原始累加时间、样本量、判定一致子集。

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

export interface PerfReport {
  enabled: true;
  sample: { seed: string; requested: number; size: number; referenceOk: number; referenceFailed: number };
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
 * 确定性的分层抽样：按用例路径的第一段（suite，如 compiler/conformance）分组，
 * 配额按组大小比例分配（每组至少 1），组内按 (seed,id) 的 hash 排序取前若干。
 * 同一 seed 与用例集总是得到同一批样本，跨轮可对比。
 */
export function selectPerfSample(ids: string[], size: number, seed: string): string[] {
  if (size <= 0 || ids.length === 0) return [];
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const suite = id.split("/")[0] ?? "other";
    const list = groups.get(suite);
    if (list === undefined) groups.set(suite, [id]);
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
    for (const id of ids) {
      if (picked.length >= Math.min(size, total)) break;
      if (!chosen.has(id)) picked.push(id);
    }
  }
  return picked;
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

  return {
    enabled: true,
    sample: { seed: input.seed, requested: input.requested, size: n, referenceOk: n, referenceFailed: sample.length - n },
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
    },
    warnings,
  };
}
