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

  for (const record of records) {
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

  // 旧清单里有 full 条目（旧口径）时也算「变化」，写回一次完成归一。
  const normalizedDiff = [...previous.entries()].some(([, tier]) => gateTierOf(tier) !== tier);
  const changed = normalizedDiff || improvements.length > 0 || next.size !== previousGate.size;
  return { regressions, improvements, next, changed };
}

/** 「实现 × 基线」清单的相对路径（相对仓库根）：config/ratchet/<impl>-<baseline>.tsv。
 *  实现名/基线名做文件名安全化（保留字母数字与 . _ -，其余替换为 _）。 */
export function ratchetPathFor(impl: string, baseline: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_");
  return join("config", "ratchet", `${safe(impl)}-${safe(baseline)}.tsv`);
}
