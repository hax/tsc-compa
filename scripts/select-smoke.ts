// 生成冒烟用例子集 manifest（config/smoke-cases*.json）。
//
// 目的：给 skeleton 一个确定、可复现、几十条量级的用例集，跑通
// 「解析指令 → 生成期望 → 驱动适配器 → 出指标」的流水线；不是正式统计口径。
//
// 筛选条件（多基线阶段）：
//   - 只取 compiler/ 与 conformance/ 两类（fourslash/ 是 IDE 用例，project(s)/
//     transpile/unittests 不在类型检查口径内，见 docs/DESIGN.md）；
//   - 用例不触发 skip、没有未知指令，仅选单配置（多配置使用独立清单核对）；
//   - 不含被排除的分类标签（默认 shape:parser / lang:js / lang:jsx /
//     options:module / options:lib / options:emit / env:skip）；
//   - 1~3 个虚拟文件、全部是 TS、总字符数不超过 6000；
//   - 给定 --baseline 时用该基线的 tsc 现场核对期望：剔除无法取得可比较诊断的用例。
//
// 保留多文件用例若干，单文件用例按固定步长抽样，保证可复现。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findBaseline, loadBaselines, resolveBaselineTsc } from "../src/baselines.ts";
import { classifyCase, parseTagList } from "../src/classify.ts";
import { toTscArgs } from "../src/case.ts";
import { readCase, scanCorpus } from "../src/discover.ts";
import { baselineFileOf, parseOfficialBaselineText } from "../src/officialBaseline.ts";
import { expectationOf, tscVersionOf } from "../src/tsc.ts";

const DEFAULT_EXCLUDE_TAGS = [
  "shape:parser",
  "lang:js",
  "lang:jsx",
  "options:module",
  "options:lib",
  "options:emit",
  "env:skip",
].join(",");

interface Args {
  corpus: string;
  out: string;
  single: number;
  multi: number;
  suites: string[];
  excludeTags: string[];
  baseline?: string;
  tsc?: string;
  /** 有官方 errors 基线的用例条数（官方基线冒烟用；与 --clean 一起启用分组抽样）。 */
  errors?: number;
  /** 无 errors 基线（无错用例）条数。 */
  clean?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: "",
    out: "config/smoke-cases.json",
    single: 24,
    multi: 6,
    suites: ["compiler", "conformance"],
    excludeTags: parseTagList(DEFAULT_EXCLUDE_TAGS, "--exclude-tags"),
    baseline: undefined,
    tsc: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    if (arg === "--corpus") args.corpus = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--single") args.single = Number(next());
    else if (arg === "--multi") args.multi = Number(next());
    else if (arg === "--baseline") args.baseline = next();
    else if (arg === "--tsc") args.tsc = next();
    else if (arg === "--errors") args.errors = Number(next());
    else if (arg === "--clean") args.clean = Number(next());
    else if (arg === "--exclude-tags") args.excludeTags = parseTagList(next(), "--exclude-tags");
    else if (arg === "--suites") args.suites = next().split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else throw new Error(`未知参数 ${arg}`);
  }
  if (args.corpus.length === 0) throw new Error("缺少 --corpus <tests/cases>");
  return args;
}

/**
 * 官方基线冒烟集：分两组各取 N 条（有 errors 基线的用例 / 无错用例）。
 * 只从单文件候选中取；不调用参考 tsc 核对——errors 基线本身已排除语法错误形态，
 * 无基线用例的官方语义就是「无期望错误」。
 */
function pickOfficialBaselineGroups(corpus: string, candidates: string[], errors: number, clean: number): string[] {
  const errorCandidates: string[] = [];
  const cleanCandidates: string[] = [];
  for (const id of candidates) {
    const file = baselineFileOf(corpus, id);
    if (file === null) {
      cleanCandidates.push(id);
      continue;
    }
    const parsed = parseOfficialBaselineText(readFileSync(file, "utf8"));
    if (parsed.status === "ok" && parsed.diagnostics.length > 0) errorCandidates.push(id);
  }
  const sample = (items: string[], count: number): string[] => {
    const out: string[] = [];
    const stride = Math.max(1, Math.floor(items.length / count));
    for (let i = 0; i < items.length && out.length < count; i += stride) out.push(items[i]!);
    return out;
  };
  return [...sample(errorCandidates, errors), ...sample(cleanCandidates, clean)];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const corpus = resolve(args.corpus);

  // 可选的 tsc 期望核对（剔除语法错误用例）。给了 --baseline 就用该基线的
  // tsc 与基础参数；也可以只用 --tsc 显式给二进制。
  const config = args.baseline !== undefined ? loadBaselines() : null;
  const baseline = config !== null ? findBaseline(config, args.baseline!) : null;
  const tscBin = args.tsc ?? (baseline !== null ? resolveBaselineTsc(baseline) : undefined);
  const baseArgs = baseline?.baseArgs ?? ["--noEmit", "--ignoreConfig", "--pretty", "false"];
  const tscVersion = tscBin !== undefined ? tscVersionOf(tscBin) : undefined;

  const all = scanCorpus(corpus);
  const singles: string[] = [];
  const multis: string[] = [];
  const rejected = { skip: 0, unknown: 0, variant: 0, shape: 0, size: 0, tag: new Map<string, number>(), reference: 0 };

  const cannotCompareReference = (id: string): boolean => {
    if (tscBin === undefined || tscVersion === undefined) return false;
    const parsed = readCase(corpus, id);
    const result = expectationOf(id, parsed.files, parsed.options, {
      tscBin,
      tscVersion,
      args: toTscArgs(parsed.options, baseArgs),
      cacheDir: join(".cache", "expectations"),
    });
    return result.status !== "ok";
  };

  for (const id of all) {
    const suite = id.split("/")[0] ?? "";
    if (!args.suites.includes(suite)) continue;
    const parsed = readCase(corpus, id);
    if (parsed.skip !== null) {
      rejected.skip++;
      continue;
    }
    if (parsed.unknown.length > 0) {
      rejected.unknown++;
      continue;
    }
    if (parsed.multiValueDirectives.length > 0) {
      rejected.variant++;
      continue;
    }
    const tags = classifyCase(id, parsed);
    const hit = args.excludeTags.find((t) => tags.some((tag) => tag === t));
    if (hit !== undefined) {
      rejected.tag.set(hit, (rejected.tag.get(hit) ?? 0) + 1);
      continue;
    }
    if (parsed.files.length < 1 || parsed.files.length > 3) {
      rejected.shape++;
      continue;
    }
    const chars = parsed.files.reduce((sum, f) => sum + f.text.length, 0);
    if (chars > 6000) {
      rejected.size++;
      continue;
    }
    (parsed.files.length > 1 ? multis : singles).push(id);
  }

  // 多文件用例按目录轮换取前 N 个，避免全落在同一个目录；语法错误的换下一个。
  const multiPick: string[] = [];
  const seenDir = new Map<string, number>();
  for (const id of multis) {
    if (multiPick.length >= args.multi) break;
    const dir = dirname(id);
    if ((seenDir.get(dir) ?? 0) >= 2) continue;
    if (cannotCompareReference(id)) {
      rejected.reference++;
      continue;
    }
    seenDir.set(dir, (seenDir.get(dir) ?? 0) + 1);
    multiPick.push(id);
  }

  // 单文件按固定步长抽样；语法错误的候选顺延到下一个样本点。
  const singlePick: string[] = [];
  const stride = Math.max(1, Math.floor(singles.length / args.single));
  for (let i = 0; i < singles.length && singlePick.length < args.single; i += stride) {
    const id = singles[i]!;
    if (cannotCompareReference(id)) {
      rejected.reference++;
      continue;
    }
    singlePick.push(id);
  }

  const picked =
    args.errors !== undefined && args.clean !== undefined
      ? pickOfficialBaselineGroups(corpus, singles, args.errors, args.clean).sort()
      : [...multiPick, ...singlePick].sort();
  writeFileSync(args.out, `${JSON.stringify(picked, null, 2)}\n`);
  const target = args.errors !== undefined && args.clean !== undefined ? args.errors + args.clean : args.multi + args.single;
  if (picked.length < target) {
    console.warn(`注意：只选出 ${picked.length} 条（目标 ${target}），候选不足或被过滤。`);
  }
  const tagReport = [...rejected.tag.entries()].map(([t, n]) => `${t}=${n}`).join(" ") || "无";
  console.log(
    `候选 ${all.length}：单文件 ${singles.length}、多文件 ${multis.length}；` +
      `淘汰 skip=${rejected.skip} unknown=${rejected.unknown} variant=${rejected.variant} shape=${rejected.shape} size=${rejected.size} ` +
      `reference=${rejected.reference} tag[${tagReport}]`,
  );
  console.log(`写入 ${picked.length} 条（多文件 ${multiPick.length}）→ ${join(args.out)}`);
}

main();
