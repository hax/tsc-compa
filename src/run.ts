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
import { formatBenchSummary, runBench } from "./bench.ts";
import { formatProjectBenchSummary, runProjectBench } from "./bench-project.ts";
import { createAdapter } from "./adapters/index.ts";
import { compareCase, formatSummary, skipRecord, summarize, type CaseRecord, type RunMeta } from "./compare.ts";
import { corpusRefOf, findBaseline, loadBaselines, resolveBaselineTsc, REPO_ROOT } from "./baselines.ts";
import { classifyCase, exclusionOf, parseTagList, runtimeTags } from "./classify.ts";
import { loadManifest, readCase } from "./discover.ts";
import { expectationOf, resolveTscPath, shortCaseName, tscVersionOf, type ExpectationResult } from "./tsc.ts";
import { expectationFromOfficialBaseline } from "./officialBaseline.ts";
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
  /** 追加到基础参数上的覆盖项（--base-arg name=value），期望与适配器两侧都用。 */
  baseArgsExtra: string[];
  /** 只加给适配器侧的参数（--adapter-arg name=value），用于跨版本对齐实验。 */
  adapterArgsExtra: string[];
  /** 期望来源：现场跑 tsc CLI，或直接消费官方 errors 基线子集。 */
  expectationSource: "tsc" | "official-baseline";
  /** 计时模式（与验证分离，见 src/bench.ts）。 */
  bench: boolean;
  /** 计时模式每案重复轮数。 */
  reps: number;
  /** 计时模式缓存档位：cold=每案新建适配器；warm=整个 case 集复用。 */
  cache: "cold" | "warm";
  /** 计时模式一次跑多个实现（逗号分隔，逐轮轮转顺序）。 */
  benchAdapters: string[];
  benchSkipExpectations: boolean;
  /** 真实项目目录（--bench --project）：相位计时，不走 conformance 用例集。 */
  project?: string;
  /** 项目相位计时的实现列表（tsc:<bin> / maat:<bin>）。 */
  benchImpls: string[];
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
    adapterArgsExtra: [],
    expectationSource: "tsc",
    bench: false,
    reps: 3,
    cache: "cold",
    benchAdapters: [],
    benchSkipExpectations: false,
    project: undefined,
    benchImpls: [],
  };
  let cacheChosen: "cold" | "warm" | null = null;
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
      case "--expectation-source": {
        const value = next();
        if (value !== "tsc" && value !== "official-baseline") {
          throw new Error(`--expectation-source 只接受 tsc / official-baseline，收到 ${value}`);
        }
        args.expectationSource = value;
        break;
      }
      case "--adapter-arg": {
        const value = next();
        const eq = value.indexOf("=");
        if (eq <= 0) throw new Error(`--adapter-arg 需要 name=value，收到 ${value}`);
        args.adapterArgsExtra.push(`--${value.slice(0, eq)}`, value.slice(eq + 1));
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
      case "--bench":
        args.bench = true;
        break;
      case "--reps": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) throw new Error("--reps 需要正整数");
        args.reps = value;
        break;
      }
      case "--cold":
        if (cacheChosen === "warm") throw new Error("--cold 与 --warm 只能选一个");
        cacheChosen = "cold";
        args.cache = "cold";
        break;
      case "--warm":
        if (cacheChosen === "cold") throw new Error("--cold 与 --warm 只能选一个");
        cacheChosen = "warm";
        args.cache = "warm";
        break;
      case "--bench-adapters": {
        const list = next().split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.length === 0) throw new Error("--bench-adapters 需要至少一个适配器");
        args.benchAdapters = list;
        break;
      }
      case "--bench-skip-expectations":
        args.benchSkipExpectations = true;
        break;
      case "--project":
        args.project = next();
        break;
      case "--bench-impls": {
        const list = next().split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.length === 0) throw new Error("--bench-impls 需要至少一个实现");
        args.benchImpls = list;
        break;
      }
      case "--help":
      case "-h":
        console.log(
          "用法：bun src/run.ts [--corpus <tests/cases>] [--baseline <id>] [--cases <manifest>] [--tsc <bin>] " +
            "[--adapter <name>] [--mode official|fixed] [--base-arg name=value]... [--adapter-arg name=value]... " +
            "[--expectation-source tsc|official-baseline] [--exclude-class <tags>] [--only-class <tags>] " +
            "[--out <dir>] [--limit N] [--verbose]",
        );
        console.log(
          "计时模式（与验证分离）：--bench --project <dir> --bench-impls tsc:<bin>,maat:<bin> [--reps N] " +
            "（头条=Check 相位）；或 --bench [--cases <manifest>] [--cold|--warm] 做逐案管线演示。",
        );
        console.log("基线见 config/baselines.json；标签见 src/classify.ts 的 CASE_TAGS。");
        process.exit(0);
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  if (args.corpus === undefined && !(args.bench && args.project !== undefined)) {
    throw new Error("缺少语料目录：用 --corpus 或环境变量 TSC_COMPA_CORPUS 指定 tests/cases");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.bench && args.project !== undefined) {
    // 真实项目目录的相位计时（头条 = tsc 系自报的 Check 相位）；不需要语料/期望。
    if (args.benchImpls.length === 0) {
      throw new Error("--bench --project 需要 --bench-impls tsc:<bin>,maat:<bin> 指定实现");
    }
    const projectReport = runProjectBench({
      project: args.project,
      implementations: args.benchImpls,
      reps: args.reps,
      outDir: args.out,
    });
    console.log(formatProjectBenchSummary(projectReport));
    console.log(`结果：${join(args.out, "bench-project.json")}`);
    return;
  }

  // 基线是 (tsc, baseArgs, 语料 tag, manifest) 的具名组合；不给 --baseline 时
  // 保持旧行为：--tsc / TSC_BIN 指定期望源，基础参数用 6.0 口径。
  //
  // 注意：baseline.baseArgs 是「期望侧的官方默认值」，只喂给期望生成；适配器
  // 侧只接用例指令与显式的 --base-arg / --adapter-arg，用自己的版本默认值，
  // 否则跨版本对照会把期望版本的默认口径强加到实现上（5.9 的 --target es5
  // 会被 6.0/7.1 直接判成配置错误）。
  const config = args.baseline !== undefined ? loadBaselines() : null;
  const baseline = config !== null ? findBaseline(config, args.baseline!) : null;
  const baseArgs = [...(baseline?.baseArgs ?? DEFAULT_BASE_ARGS), ...args.baseArgsExtra];
  const tscBin = resolveTscPath(args.tsc ?? (baseline !== null ? resolveBaselineTsc(baseline) : undefined));
  const tscVersion = tscVersionOf(tscBin);
  const corpusRef = config !== null && baseline !== null ? corpusRefOf(config, baseline) : undefined;
  const casesPath =
    args.cases ?? (baseline !== null ? join(REPO_ROOT, baseline.manifest) : join(REPO_ROOT, "config/smoke-cases.json"));

  const ids = loadManifest(casesPath).slice(0, args.limit ?? Number.POSITIVE_INFINITY);

  if (args.bench) {
    // 兼容性语料上的逐案计时：只作管线演示，不承载性能结论（见 docs/DESIGN）。
    const adapterSpecs = args.benchAdapters.length > 0 ? args.benchAdapters : [args.adapter];
    const report = await runBench({
      corpus: args.corpus,
      caseIds: ids,
      adapterSpecs,
      mode: args.mode,
      reps: args.reps,
      cold: args.cache === "cold",
      expectationArgs: baseArgs,
      tscBin,
      tscVersion,
      expectationSource: args.expectationSource,
      skipExpectations: args.benchSkipExpectations,
      baseline: args.baseline,
      corpusRef,
      outDir: args.out,
    });
    console.log(formatBenchSummary(report));
    console.log(`结果：${join(args.out, "bench.json")}`);
    return;
  }

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
    const expectationArgs = toTscArgs(options, baseArgs);
    // 适配器侧：用例指令 + 显式 --base-arg/--adapter-arg；不含基线的官方默认值。
    const adapterArgs = toTscArgs(options, [...args.baseArgsExtra, ...args.adapterArgsExtra]);
    let expectation: ExpectationResult;
    if (args.expectationSource === "official-baseline") {
      const official = expectationFromOfficialBaseline(args.corpus, id, parsed);
      if (official.status === "skip") {
        records.push(skipRecord(id, `官方基线:${official.reason}`, staticTags));
        continue;
      }
      expectation = { status: "ok", diagnostics: official.diagnostics };
    } else {
      expectation = expectationOf(id, parsed.files, options, {
        tscBin,
        tscVersion,
        args: expectationArgs,
        cacheDir: join(".cache", "expectations"),
      });
    }
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
    const outcome = await adapter.check({ id, files: parsed.files, options, args: adapterArgs });
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
    expectationSource: args.expectationSource,
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
