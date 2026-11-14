// tsc-compa 冒烟运行器：发现用例 → 生成期望 → 驱动适配器 → 汇总指标。
//
// 用法（在仓库根）：
//   TSC_COMPA_CORPUS=/path/to/typescript/tests/cases \
//   bun src/run.ts --baseline 6.0.3 --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc
//
//   # 或显式指定 tsc 与期望参数（不读 config/baselines.json）
//   TSC_BIN=/path/to/tsc bun src/run.ts --adapter maat-zig --mode fixed --cases config/smoke-cases.json
//
// 运行结果写 <out>/metrics.json 与 <details.json>，并在 stdout 打印摘要。
// v0 没有门禁（--gate 留给后续接入基线）；退出码恒 0，除非运行本身失败。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapter } from "./adapters/index.ts";
import { compareCase, formatSummary, skipRecord, summarize, type CaseRecord, type RunMeta } from "./compare.ts";
import { corpusRefOf, findBaseline, loadBaselines, resolveBaselineTsc, REPO_ROOT } from "./baselines.ts";
import { classifyCase, exclusionOf, parseTagList, runtimeTags } from "./classify.ts";
import { loadManifest, readCase } from "./discover.ts";
import { expectationOf, resolveTscPath, shortCaseName, tscVersionOf } from "./tsc.ts";
import { toTscArgs } from "./case.ts";
import type { Adapter } from "./types.ts";

const DEFAULT_BASE_ARGS = ["--noEmit", "--ignoreConfig", "--pretty", "false"];

interface Args {
  corpus?: string;
  cases?: string;
  tsc?: string;
  adapter: string;
  mode: "official" | "fixed";
  out: string;
  limit?: number;
  verbose: boolean;
  baseline?: string;
  excludeClasses: string[];
  onlyClasses: string[];
  /** 追加到基础参数上的覆盖项（--base-arg name=value），两侧与期望都用。 */
  baseArgsExtra: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: process.env.TSC_COMPA_CORPUS,
    cases: undefined,
    tsc: process.env.TSC_BIN,
    adapter: process.env.TSC_COMPA_ADAPTER ?? "maat-zig",
    mode: "official",
    out: ".cache/run",
    verbose: false,
    baseline: process.env.TSC_COMPA_BASELINE,
    excludeClasses: [],
    onlyClasses: [],
    baseArgsExtra: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    switch (arg) {
      case "--corpus":
        args.corpus = next();
        break;
      case "--cases":
        args.cases = next();
        break;
      case "--tsc":
        args.tsc = next();
        break;
      case "--baseline":
        args.baseline = next();
        break;
      case "--base-arg": {
        const value = next();
        const eq = value.indexOf("=");
        if (eq <= 0) throw new Error(`--base-arg 需要 name=value，收到 ${value}`);
        args.baseArgsExtra.push(`--${value.slice(0, eq)}`, value.slice(eq + 1));
        break;
      }
      case "--exclude-class":
        args.excludeClasses = parseTagList(next(), "--exclude-class");
        break;
      case "--only-class":
        args.onlyClasses = parseTagList(next(), "--only-class");
        break;
      case "--adapter":
        args.adapter = next();
        break;
      case "--mode": {
        const value = next();
        if (value !== "official" && value !== "fixed") throw new Error(`--mode 只接受 official / fixed，收到 ${value}`);
        args.mode = value;
        break;
      }
      case "--out":
        args.out = next();
        break;
      case "--limit":
        args.limit = Number(next());
        if (!Number.isInteger(args.limit!) || args.limit! <= 0) throw new Error("--limit 需要正整数");
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "用法：bun src/run.ts [--corpus <tests/cases>] [--baseline <id>] [--cases <manifest>] [--tsc <bin>] " +
            "[--adapter <name>] [--mode official|fixed] [--base-arg name=value]... [--exclude-class <tags>] [--only-class <tags>] " +
            "[--out <dir>] [--limit N] [--verbose]",
        );
        console.log("基线见 config/baselines.json；标签见 src/classify.ts 的 CASE_TAGS。");
        process.exit(0);
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  if (args.corpus === undefined) {
    throw new Error("缺少语料目录：用 --corpus 或环境变量 TSC_COMPA_CORPUS 指定 tests/cases");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 基线是 (tsc, baseArgs, 语料 tag, manifest) 的具名组合；不给 --baseline 时
  // 保持旧行为：--tsc / TSC_BIN 指定期望源，基础参数用 6.0 口径。
  const config = args.baseline !== undefined ? loadBaselines() : null;
  const baseline = config !== null ? findBaseline(config, args.baseline!) : null;
  const baseArgs = [...(baseline?.baseArgs ?? DEFAULT_BASE_ARGS), ...args.baseArgsExtra];
  const tscBin = resolveTscPath(args.tsc ?? (baseline !== null ? resolveBaselineTsc(baseline) : undefined));
  const tscVersion = tscVersionOf(tscBin);
  const corpusRef = config !== null && baseline !== null ? corpusRefOf(config, baseline) : undefined;
  const casesPath =
    args.cases ?? (baseline !== null ? join(REPO_ROOT, baseline.manifest) : join(REPO_ROOT, "config/smoke-cases.json"));

  const adapter: Adapter = await createAdapter(args.adapter);
  await adapter.init?.();

  if (args.mode === "fixed" && adapter.fixedOptions === undefined) {
    throw new Error(`适配器 ${adapter.name} 没有声明 fixedOptions，不能用 --mode fixed`);
  }
  if (args.mode === "official" && !adapter.supportsOptions) {
    console.warn(
      `警告：适配器 ${adapter.name} 不接受外部编译选项，official 模式下 case 指令会被实现忽略；本次结果不能作为兼容性结论。`,
    );
  }

  const ids = loadManifest(casesPath).slice(0, args.limit ?? Number.POSITIVE_INFINITY);
  const records: CaseRecord[] = [];
  let optionDirectiveIgnored = 0;
  let excludedStatic = 0;
  let excludedRuntime = 0;

  for (const id of ids) {
    const parsed = readCase(args.corpus, id);
    const staticTags = classifyCase(id, parsed);
    if (parsed.skip !== null) {
      records.push(skipRecord(id, parsed.skip, staticTags));
      continue;
    }
    if (parsed.unknown.length > 0) {
      records.push(skipRecord(id, `未知指令 ${parsed.unknown[0]}`, staticTags));
      continue;
    }
    const staticExclusion = exclusionOf(staticTags, args.excludeClasses, args.onlyClasses);
    if (staticExclusion !== null) {
      excludedStatic++;
      records.push(skipRecord(id, `类排除:${staticExclusion}`, staticTags));
      continue;
    }
    const options = args.mode === "fixed" ? adapter.fixedOptions! : parsed.options;
    if (args.mode === "fixed" && parsed.options.length > 0) optionDirectiveIgnored++;
    const tscArgs = toTscArgs(options, baseArgs);
    const expectation = expectationOf(id, parsed.files, options, {
      tscBin,
      tscVersion,
      args: tscArgs,
      cacheDir: join(".cache", "expectations"),
    });
    const tags = [...staticTags, ...runtimeTags(expectation)];
    const runtimeExclusion = exclusionOf(tags, args.excludeClasses, args.onlyClasses);
    if (runtimeExclusion !== null) {
      excludedRuntime++;
      records.push(skipRecord(id, `类排除:${runtimeExclusion}`, tags));
      continue;
    }
    if (expectation.status !== "ok") {
      const reason =
        expectation.status === "syntax"
          ? "tsc 语法解析失败"
          : expectation.status === "timeout"
            ? "tsc 侧超时"
            : "tsc 侧异常";
      records.push(skipRecord(id, reason, tags));
      continue;
    }
    const outcome = await adapter.check({ id, files: parsed.files, options, args: tscArgs });
    if (outcome.status !== "ok") {
      records.push(skipRecord(id, outcome.skipReason ?? `实现返回 ${outcome.status}`, tags));
      continue;
    }
    const record = compareCase(id, expectation.diagnostics, outcome.diagnostics, tags);
    if (args.verbose) {
      console.log(
        `${shortCaseName(id)}: [${tags.join(" ")}] expect=${record.expected.length} actual=${record.actual.length} ` +
          `fp=${record.fp.length} miss=${record.missed.length} misanchor=${record.misanchor}`,
      );
    }
    records.push(record);
  }
  await adapter.close?.();

  const meta: RunMeta = {
    suite: "smoke",
    corpus: args.corpus,
    adapter: adapter.name,
    mode: args.mode,
    verdictEligible: args.mode === "official" && adapter.supportsOptions,
    tscVersion,
    tscBin,
    baseline: args.baseline,
    corpusRef,
    generatedAt: new Date().toISOString(),
    selectedCases: ids.length,
  };
  const metrics = summarize(records, meta);
  if (args.mode === "fixed") {
    console.warn(`提示：--mode fixed 下共忽略 ${optionDirectiveIgnored} 个用例的编译选项指令；结果只用于验证流水线。`);
  }
  if (excludedStatic + excludedRuntime > 0) {
    console.log(`类排除：静态 ${excludedStatic} 例、运行期 ${excludedRuntime} 例（--exclude-class / --only-class）`);
  }

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  writeFileSync(
    join(args.out, "details.json"),
    `${JSON.stringify(
      records.map((r) => ({
        id: r.id,
        status: r.status,
        skipReason: r.skipReason,
        classes: r.classes,
        expected: r.expected.length,
        actual: r.actual.length,
        hits: r.hits,
        fp: r.fp.map((d) => `${d.file}:${d.line + 1}:${d.col + 1} TS${d.code}`),
        missed: r.missed.map((d) => `${d.file}:${d.line + 1}:${d.col + 1} TS${d.code}`),
        misanchor: r.misanchor,
      })),
      null,
      2,
    )}\n`,
  );
  console.log(formatSummary(metrics));
  console.log(`结果：${join(args.out, "metrics.json")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
