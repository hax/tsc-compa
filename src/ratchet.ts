// 一致性 ratchet：把「每个用例达到的最深**门禁**一致性档位」记进清单，
// 只升不降——回落即本次运行失败（退出码非零），改善自动写回清单。
//
// 门禁档位只到 T2：T3 full（整份 .errors.txt 字节相等）是报告档，读入/写回时
// 一律归一成 text（见 compare.ts 的 gateTierOf），因此 full → text 不算回落，
// text → category/location/none 才算回落。T3 的分布仍在 metrics 里报告。
//
// 清单格式（TSV，入库）：
//   # 注释行
//   <case id>\t<location|category|text>
//
// 口径说明：
// - 只登记至少达到 location（T0）的用例；none 不入清单；
// - 之前登记过的用例本次变成 skip（例如语法被整案跳过）视为回落；
// - 只检查本次运行覆盖到的用例；未出现在本次 manifest 里的条目不检查、不删除。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparisonFields, type ComparisonField, type FieldStatus, type Verdict } from "./comparison.ts";
import { gateTierOf, TIER_RANK, TIERS, type CaseRecord, type Tier } from "./compare.ts";

export type RatchetMap = Map<string, Tier>;

export interface RatchetRegression {
  id: string;
  was: Tier;
  now: Tier;
  reason?: string;
}

export interface RatchetImprovement {
  id: string;
  was: Tier | null;
  now: Tier;
}

export interface RatchetCheck {
  regressions: RatchetRegression[];
  improvements: RatchetImprovement[];
  /** 合并旧清单与本次改善后的新清单（只升不降，档位已归一为门禁档）。 */
  next: RatchetMap;
  /** 与旧清单相比是否有变化（决定是否回写）。 */
  changed: boolean;
}

const HEADER = [
  "# tsc-compa tier ratchet（只升不降）：<case id><TAB><tier>",
  "# 门禁档位：location(T0) < category(T1) < text(T2)；T3 full 只报告，清单里归一为 text。",
  "# 由 --ratchet 自动维护：改善写回，回落退出非零。",
];

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** 读清单；旧文件里的 full 归一成 text（T3 不进闸门）。 */
export function readRatchet(path: string): RatchetMap {
  const map: RatchetMap = new Map();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const [id, tier] = trimmed.split("\t");
    if (id === undefined || tier === undefined) continue;
    if (!isTier(tier)) throw new Error(`ratchet 清单里有未知档位：${path} → ${line}`);
    map.set(id, gateTierOf(tier));
  }
  return map;
}

export function serializeRatchet(map: RatchetMap): string {
  const rows = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, tier]) => `${id}\t${gateTierOf(tier)}`);
  return `${[...HEADER, ...rows].join("\n")}\n`;
}

export function writeRatchet(path: string, map: RatchetMap): void {
  writeFileSync(path, serializeRatchet(map));
}

export function checkRatchet(previous: RatchetMap, records: CaseRecord[]): RatchetCheck {
  // 旧清单可能来自「full 参与门禁」的旧口径，先统一归一到门禁档再比较。
  const previousGate: RatchetMap = new Map([...previous.entries()].map(([id, tier]) => [id, gateTierOf(tier)]));
  const next: RatchetMap = new Map(previousGate);
  const regressions: RatchetRegression[] = [];
  const improvements: RatchetImprovement[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    seen.add(record.id);
    const was = previousGate.get(record.id) ?? null;
    if (record.status === "skip") {
      if (was !== null) regressions.push({ id: record.id, was, now: "none", reason: `跳过：${record.skipReason ?? "unknown"}` });
      continue;
    }
    const now = gateTierOf(record.tier);
    if (was === null) {
      if (TIER_RANK[now] >= TIER_RANK.location) {
        next.set(record.id, now);
        improvements.push({ id: record.id, was: null, now });
      }
      continue;
    }
    if (TIER_RANK[now] < TIER_RANK[was]) {
      regressions.push({ id: record.id, was, now });
    } else if (TIER_RANK[now] > TIER_RANK[was]) {
      next.set(record.id, now);
      improvements.push({ id: record.id, was, now });
    }
  }
  for (const [id, was] of previousGate) {
    if (!seen.has(id)) regressions.push({ id, was, now: "none", reason: "未进入本次执行范围" });
  }

  // 旧清单里有 full 条目（旧口径）时也算「变化」，写回一次完成归一。
  const normalizedDiff = [...previous.entries()].some(([, tier]) => gateTierOf(tier) !== tier);
  const changed = normalizedDiff || improvements.length > 0 || next.size !== previousGate.size;
  return { regressions, improvements, next, changed };
}

export interface LegacyRatchetResult {
  path: string;
  registered: number;
  regressions: RatchetRegression[];
  /** 旧 TSV 的回落项统一按 compatibility 维度报告给 v2 gate。 */
  stateRegressions: RatchetStateRegression[];
}

/** 迁移期桥接：让旧 T0–T2 清单的回落也能进入 v2 gate 的 compatibility 维度。 */
export function legacyRatchetResult(path: string, previous: RatchetMap, check: RatchetCheck): LegacyRatchetResult {
  const stateRegressions = check.regressions.map((regression) => ({
    id: regression.id,
    kind: "compatibility" as const,
    was: regression.was === "none" ? "unknown" as const : "pass" as const,
    now: regression.now === "none" ? "unknown" as const : "pass" as const,
    reasonKind: "comparison" as const,
    reason: regression.reason ?? `旧分级 ${regression.was} → ${regression.now}`,
  }));
  return { path, registered: previous.size, regressions: check.regressions, stateRegressions };
}

/** 「实现 × 基线」清单的相对路径（相对仓库根）：config/ratchet/<impl>-<baseline>.tsv。
 *  实现名/基线名做文件名安全化（保留字母数字与 . _ -，其余替换为 _）。 */
export function ratchetPathFor(impl: string, baseline: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_");
  return join("config", "ratchet", `${safe(impl)}-${safe(baseline)}.tsv`);
}

// ---------------------------------------------------------------------------
// v2：两档 + 逐字段的已验证状态
// ---------------------------------------------------------------------------
//
// 旧 TSV 只保存一个最高分级，不能证明新比较模型下的 strict 结果。迁移时只把
// T0–T2 记作 compatibility 已验证，strict 保持 unknown、逐字段保持 unavailable；
// 不根据旧档位反推严格证据。非门禁更新保留历史已验证状态，不因本次回落降级。

/** 回归维度：兼容、严格一致，或某一个独立差异项。 */
export type RegressionKind = "compatibility" | "strict" | "field";

/** v2 回归记录的逐案状态；fields 保存全部差异项，而不是只保存门禁关心的项。 */
export interface RatchetStateEntry {
  compatibility: Verdict;
  strict: Verdict;
  fields: Record<ComparisonField, FieldStatus>;
  /** 旧 TSV 行的来源档位，仅用于迁移说明，不参与 strict 推断。 */
  legacyTier?: Tier;
}

export type RatchetState = Map<string, RatchetStateEntry>;

export interface RatchetStateRegression {
  id: string;
  kind: RegressionKind;
  /** kind === "field" 时指出具体差异项。 */
  field?: ComparisonField;
  was: Verdict | FieldStatus;
  now: Verdict | FieldStatus;
  reasonKind: "comparison" | "skip" | "out-of-scope" | "missing-comparison";
  reason: string;
}

export interface RatchetStateImprovement {
  id: string;
  kind: RegressionKind;
  field?: ComparisonField;
  was: Verdict | FieldStatus | null;
  now: Verdict | FieldStatus;
}

export interface RatchetStateCheck {
  regressions: RatchetStateRegression[];
  improvements: RatchetStateImprovement[];
  /** 合并历史已验证状态后的下一份记录；未完成/移出的条目保持原状。 */
  next: RatchetState;
  changed: boolean;
  /** 旧记录的条目数（不是本次选中的用例数）。 */
  registered: number;
}

const VERDICTS: readonly Verdict[] = ["pass", "fail", "unknown"];
const FIELD_STATUSES: readonly FieldStatus[] = ["equal", "different", "unavailable"];

const emptyFields = (): Record<ComparisonField, FieldStatus> =>
  Object.fromEntries(comparisonFields.map((field) => [field, "unavailable"])) as Record<ComparisonField, FieldStatus>;

function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

function isFieldStatus(value: string): value is FieldStatus {
  return (FIELD_STATUSES as readonly string[]).includes(value);
}

function parseFields(text: string, path: string, line: string): Record<ComparisonField, FieldStatus> {
  const fields = emptyFields();
  if (text === "-" || text.length === 0) return fields;
  const seen = new Set<string>();
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`ratchet 记录里字段状态格式错误：${path} → ${line}`);
    const name = pair.slice(0, eq);
    const status = pair.slice(eq + 1);
    if (!(comparisonFields as readonly string[]).includes(name)) {
      throw new Error(`ratchet 记录里有未知字段：${path} → ${name}`);
    }
    if (seen.has(name)) throw new Error(`ratchet 记录里有重复字段：${path} → ${name}`);
    seen.add(name);
    if (!isFieldStatus(status)) throw new Error(`ratchet 记录里有未知字段状态：${path} → ${status}`);
    fields[name as ComparisonField] = status;
  }
  return fields;
}

function legacyEntry(tier: Tier): RatchetStateEntry {
  return {
    compatibility: tier === "none" ? "unknown" : "pass",
    strict: "unknown",
    fields: emptyFields(),
    legacyTier: tier,
  };
}

/** 读 v2 记录；旧的两列 TSV 自动迁移，但不生成 strict 证据。 */
export function readRatchetState(path: string): RatchetState {
  const state: RatchetState = new Map();
  if (!existsSync(path)) return state;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const columns = trimmed.split("\t");
    const id = columns[0];
    if (id === undefined || id.length === 0) throw new Error(`ratchet 记录缺用例 ID：${path}`);
    if (state.has(id)) throw new Error(`ratchet 记录用例 ID 重复：${path} → ${id}`);
    if (columns.length === 2 && isTier(columns[1]!)) {
      state.set(id, legacyEntry(columns[1] as Tier));
      continue;
    }
    if (columns.length !== 4 && columns.length !== 5) {
      throw new Error(`ratchet 记录列数错误（需要 id、compatibility、strict、fields）：${path} → ${line}`);
    }
    const compatibility = columns[1]!;
    const strict = columns[2]!;
    if (!isVerdict(compatibility) || !isVerdict(strict)) {
      throw new Error(`ratchet 记录里有未知两档状态：${path} → ${line}`);
    }
    const legacy = columns[4];
    let legacyTier: Tier | undefined;
    if (legacy !== undefined && legacy !== "-" && legacy.length > 0) {
      if (!legacy.startsWith("legacy=")) throw new Error(`ratchet 记录里有未知迁移标记：${path} → ${line}`);
      const value = legacy.slice("legacy=".length);
      if (!isTier(value)) throw new Error(`ratchet 记录里有未知旧档位：${path} → ${value}`);
      legacyTier = value;
    }
    state.set(id, {
      compatibility,
      strict,
      fields: parseFields(columns[3]!, path, line),
      ...(legacyTier !== undefined ? { legacyTier } : {}),
    });
  }
  return state;
}

export function serializeRatchetState(state: RatchetState): string {
  const rows = [...state.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, entry]) => {
      const fields = comparisonFields.map((field) => `${field}=${entry.fields[field]}`).join(",");
      const legacy = entry.legacyTier !== undefined ? `legacy=${entry.legacyTier}` : "-";
      return `${id}\t${entry.compatibility}\t${entry.strict}\t${fields}\t${legacy}`;
    });
  return [
    "# tsc-compa ratchet v2（只升不降）：<case id><TAB><compatibility><TAB><strict><TAB><fields><TAB><legacy>",
    "# compatibility/strict：pass|fail|unknown；fields：name=equal|different|unavailable（- 表示全部 unavailable）。",
    "# 旧版 <case id><TAB><tier> 自动迁移为 compatibility=pass（none 除外）、strict=unknown、fields 全部 unavailable。",
    "# 非门禁更新只合并更高/更完整的已验证状态，不因本次回落降低历史保护。",
    ...rows,
  ].join("\n") + "\n";
}

export function writeRatchetState(path: string, state: RatchetState): void {
  writeFileSync(path, serializeRatchetState(state));
}

function stateEntryOf(record: CaseRecord): RatchetStateEntry | null {
  if (record.status !== "ran" || record.comparison === null) return null;
  return {
    compatibility: record.comparison.compatibility,
    strict: record.comparison.strict,
    fields: { ...record.comparison.fields },
  };
}

const verdictRank: Record<Verdict, number> = { unknown: 0, fail: 1, pass: 2 };
const fieldRank: Record<FieldStatus, number> = { unavailable: 0, different: 1, equal: 2 };

function strongerVerdict(a: Verdict, b: Verdict): Verdict {
  return verdictRank[a] >= verdictRank[b] ? a : b;
}

function strongerField(a: FieldStatus, b: FieldStatus): FieldStatus {
  return fieldRank[a] >= fieldRank[b] ? a : b;
}

/** 合并历史保护和本次已验证状态；历史 pass/equal 不会因本次失败或缺失而降级。 */
export function mergeRatchetStateEntry(previous: RatchetStateEntry, current: RatchetStateEntry): RatchetStateEntry {
  return {
    compatibility: strongerVerdict(previous.compatibility, current.compatibility),
    strict: strongerVerdict(previous.strict, current.strict),
    fields: Object.fromEntries(comparisonFields.map((field) => [
      field,
      strongerField(previous.fields[field], current.fields[field]),
    ])) as Record<ComparisonField, FieldStatus>,
    ...(previous.legacyTier !== undefined ? { legacyTier: previous.legacyTier } : {}),
  };
}

function sameEntry(a: RatchetStateEntry, b: RatchetStateEntry): boolean {
  return a.compatibility === b.compatibility && a.strict === b.strict &&
    a.legacyTier === b.legacyTier &&
    comparisonFields.every((field) => a.fields[field] === b.fields[field]);
}

function regressionFor(
  id: string,
  kind: RegressionKind,
  was: Verdict | FieldStatus,
  now: Verdict | FieldStatus,
  reasonKind: RatchetStateRegression["reasonKind"],
  reason: string,
  field?: ComparisonField,
): RatchetStateRegression {
  return { id, kind, ...(field !== undefined ? { field } : {}), was, now, reasonKind, reason };
}

function unavailableRegressions(
  id: string,
  previous: RatchetStateEntry,
  reasonKind: "skip" | "out-of-scope" | "missing-comparison",
  reason: string,
): RatchetStateRegression[] {
  const found: RatchetStateRegression[] = [];
  if (previous.compatibility === "pass") {
    found.push(regressionFor(id, "compatibility", "pass", "unknown", reasonKind, `${reason}（兼容未确认）`));
  }
  if (previous.strict === "pass") {
    found.push(regressionFor(id, "strict", "pass", "unknown", reasonKind, `${reason}（严格一致未确认）`));
  }
  for (const field of comparisonFields) {
    if (previous.fields[field] !== "equal") continue;
    found.push(regressionFor(id, "field", "equal", "unavailable", reasonKind, `${reason}（字段 ${field} 未确认）`, field));
  }
  return found;
}

/** 回归记录中已有 pass 历史的条目数；runner 用它填 GateRatchetInput.protected。 */
export function protectedCountsOf(state: RatchetState): { compatibility: number; strict: number } {
  let compatibility = 0;
  let strict = 0;
  for (const entry of state.values()) {
    if (entry.compatibility === "pass") compatibility++;
    if (entry.strict === "pass") strict++;
  }
  return { compatibility, strict };
}

/**
 * 逐案检查两档和逐字段回归，并生成只升不降的下一份记录。
 *
 * 只有此前已验证为 pass/equal 的维度才会产生回归。此前未验证的 strict 或
 * 字段状态，即使本次 fail/different，也只作为新证据写入记录，不伪装成历史保护。
 */
export function checkRatchetState(previous: RatchetState, records: readonly CaseRecord[]): RatchetStateCheck {
  const byId = new Map<string, CaseRecord>();
  for (const record of records) byId.set(record.id, record);
  const next: RatchetState = new Map([...previous.entries()].map(([id, entry]) => [id, {
    ...entry,
    fields: { ...entry.fields },
  }]));
  const regressions: RatchetStateRegression[] = [];
  const improvements: RatchetStateImprovement[] = [];

  for (const [id, was] of previous) {
    const record = byId.get(id);
    if (record === undefined) {
      regressions.push(...unavailableRegressions(id, was, "out-of-scope", "未进入本次执行范围"));
      continue;
    }
    if (record.status === "skip") {
      regressions.push(...unavailableRegressions(id, was, "skip", `跳过：${record.skipReason ?? "unknown"}`));
      continue;
    }
    if (record.comparison === null) {
      regressions.push(...unavailableRegressions(id, was, "missing-comparison", "比较结果缺失"));
      continue;
    }
    const now = record.comparison;
    if (was.compatibility === "pass" && now.compatibility !== "pass") {
      regressions.push(regressionFor(id, "compatibility", "pass", now.compatibility, "comparison",
        `兼容由 pass 变为 ${now.compatibility}`));
    }
    if (was.strict === "pass" && now.strict !== "pass") {
      regressions.push(regressionFor(id, "strict", "pass", now.strict, "comparison",
        `严格一致由 pass 变为 ${now.strict}`));
    }
    for (const field of comparisonFields) {
      if (was.fields[field] !== "equal" || now.fields[field] === "equal") continue;
      regressions.push(regressionFor(id, "field", "equal", now.fields[field], "comparison",
        `字段 ${field} 由 equal 变为 ${now.fields[field]}`, field));
    }
  }

  for (const record of records) {
    const current = stateEntryOf(record);
    if (current === null) continue;
    const was = previous.get(record.id);
    if (was === undefined) {
      next.set(record.id, current);
      if (current.compatibility === "pass") {
        improvements.push({ id: record.id, kind: "compatibility", was: null, now: "pass" });
      }
      if (current.strict === "pass") {
        improvements.push({ id: record.id, kind: "strict", was: null, now: "pass" });
      }
      continue;
    }
    const merged = mergeRatchetStateEntry(was, current);
    next.set(record.id, merged);
    if (was.compatibility !== "pass" && current.compatibility === "pass") {
      improvements.push({ id: record.id, kind: "compatibility", was: was.compatibility, now: "pass" });
    }
    if (was.strict !== "pass" && current.strict === "pass") {
      improvements.push({ id: record.id, kind: "strict", was: was.strict, now: "pass" });
    }
    for (const field of comparisonFields) {
      if (was.fields[field] === "equal" || current.fields[field] !== "equal") continue;
      improvements.push({ id: record.id, kind: "field", field, was: was.fields[field], now: "equal" });
    }
  }

  let changed = next.size !== previous.size;
  if (!changed) {
    for (const [id, entry] of next) {
      const before = previous.get(id);
      if (before === undefined || !sameEntry(before, entry)) {
        changed = true;
        break;
      }
    }
  }
  return { regressions, improvements, next, changed, registered: previous.size };
}
