// 生成冒烟用例子集 manifest（config/smoke-cases.json）。
//
// 目的：给 skeleton 一个确定、可复现、几十条量级的用例集，跑通
// 「解析指令 → 生成期望 → 驱动适配器 → 出指标」的流水线；不是正式统计口径。
//
// 筛选条件（v0）：
//   - 只取 compiler/ 与 conformance/ 两类（fourslash/ 是 IDE 用例，project(s)/
//     transpile/unittests 不在类型检查口径内，见 docs/DESIGN.md）；
//   - 用例不触发 skip，且没有未知指令；
//   - 1~3 个虚拟文件，全部是 TS；总字符数不超过 6000；
//   - 不含 module / moduleResolution / moduleDetection / lib 等会显著改变
//     模块解析与环境的选项（这些留给多基线阶段专门处理）。
//
// 保留多文件用例若干，单文件用例按固定步长抽样，保证可复现。

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readCase, scanCorpus } from "../src/discover.ts";

interface Args {
  corpus: string;
  out: string;
  single: number;
  multi: number;
  suites: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: "",
    out: "config/smoke-cases.json",
    single: 24,
    multi: 6,
    suites: ["compiler", "conformance"],
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
    else if (arg === "--suites") args.suites = next().split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else throw new Error(`未知参数 ${arg}`);
  }
  if (args.corpus.length === 0) throw new Error("缺少 --corpus <tests/cases>");
  return args;
}

const EXCLUDE_OPTIONS = new Set(["module", "moduleResolution", "moduleDetection", "lib", "types"]);

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const corpus = resolve(args.corpus);
  const all = scanCorpus(corpus);
  const singles: string[] = [];
  const multis: string[] = [];
  const rejected = { skip: 0, unknown: 0, shape: 0, size: 0, options: 0 };

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
    if (parsed.files.length < 1 || parsed.files.length > 3) {
      rejected.shape++;
      continue;
    }
    const chars = parsed.files.reduce((sum, f) => sum + f.text.length, 0);
    if (chars > 6000) {
      rejected.size++;
      continue;
    }
    if (parsed.options.some((o) => EXCLUDE_OPTIONS.has(o.name))) {
      rejected.options++;
      continue;
    }
    (parsed.files.length > 1 ? multis : singles).push(id);
  }

  // 多文件用例按目录轮换取前 N 个，避免全落在同一个目录。
  const multiPick: string[] = [];
  const seenDir = new Map<string, number>();
  for (const id of multis) {
    const dir = dirname(id);
    if ((seenDir.get(dir) ?? 0) >= 2) continue;
    seenDir.set(dir, (seenDir.get(dir) ?? 0) + 1);
    multiPick.push(id);
    if (multiPick.length >= args.multi) break;
  }

  // 单文件按固定步长抽样，数量固定、结果可复现。
  const singlePick: string[] = [];
  const stride = Math.max(1, Math.floor(singles.length / args.single));
  for (let i = 0; i < singles.length && singlePick.length < args.single; i += stride) {
    singlePick.push(singles[i]!);
  }

  const picked = [...multiPick, ...singlePick].sort();
  writeFileSync(args.out, `${JSON.stringify(picked, null, 2)}\n`);
  console.log(
    `候选 ${all.length}：单文件 ${singles.length}、多文件 ${multis.length}；` +
      `淘汰 skip=${rejected.skip} unknown=${rejected.unknown} shape=${rejected.shape} size=${rejected.size} options=${rejected.options}`,
  );
  console.log(`写入 ${picked.length} 条（多文件 ${multiPick.length}）→ ${join(args.out)}`);
}

main();
