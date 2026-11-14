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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createAdapter } from "./adapters/index.ts";
import { compareCase, formatSummary, skipRecord, summarize, type CaseRecord, type Metrics, type RunMeta } from "./compare.ts";
import { checkRatchet, ratchetPathFor, readRatchet, writeRatchet } from "./ratchet.ts";
import { corpusRefOf, findBaseline, loadBaselines, resolveBaselineTsc, REPO_ROOT } from "./baselines.ts";
import { classifyCase, exclusionOf, parseTagList, runtimeTags } from "./classify.ts";
import { loadManifest, readCase } from "./discover.ts";
import { expectationOf, resolveTscPath, shortCaseName, tscVersionOf, type ExpectationResult } from "./tsc.ts";
import { baselineFileOf, expectationFromOfficialBaseline } from "./officialBaseline.ts";
import { toTscArgs } from "./case.ts";
import {
  buildPerfReport,
  planPerfOrder,
  runReference,
  selectPerfSample,
  type PerfCaseMeta,
  type ReferenceRun,
} from "./perf.ts";
import type { Adapter, CaseFile } from "./types.ts";

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
  /** 一致性 ratchet 清单（TSV）；设置后：回落退出非零、改善写回。 */
  ratchet?: string;
  /** 按「实现 × 基线」分账：推导 config/ratchet/<impl>-<baseline>.tsv；清单不存在时自动初始化。 */
  ratchetImpl?: string;
  /** 允许 --ratchet 显式路径不存在时初始化（--ratchet-impl 隐含此语义）。 */
  ratchetInit: boolean;
  /** 附带性能附录：固定样本上跑官方 tsc 参考，输出实现/官方比值（不作门禁）。 */
  perfRatio: boolean;
  perfSample: number;
  perfSeed: string;
  perfTimeoutMs: number;
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
    ratchetInit: false,
    perfRatio: false,
    perfSample: 300,
    perfSeed: "tsc-compa-v1",
    perfTimeoutMs: 120_000,
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
      case "--ratchet":
        args.ratchet = next();
        break;
      case "--ratchet-impl":
        args.ratchetImpl = next();
        break;
      case "--ratchet-init":
        args.ratchetInit = true;
        break;
      case "--limit":
        args.limit = Number(next());
        if (!Number.isInteger(args.limit!) || args.limit! <= 0) throw new Error("--limit 需要正整数");
        break;
      case "--perf-ratio":
        args.perfRatio = true;
        break;
      case "--perf-sample": {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) throw new Error("--perf-sample 需要正整数");
        args.perfSample = value;
        break;
      }
      case "--perf-seed":
        args.perfSeed = next();
        break;
      case "--perf-timeout": {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) throw new Error("--perf-timeout 需要正整数（毫秒）");
        args.perfTimeoutMs = value;
        break;
      }
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "用法：bun src/run.ts [--corpus <tests/cases>] [--baseline <id>] [--cases <manifest>] [--tsc <bin>] " +
            "[--adapter <name>] [--mode official|fixed] [--base-arg name=value]... [--adapter-arg name=value]... " +
            "[--expectation-source tsc|official-baseline] [--exclude-class <tags>] [--only-class <tags>] " +
            "[--ratchet <file> | --ratchet-impl <impl>] [--ratchet-init] [--perf-ratio] [--perf-sample N] [--perf-seed <s>] [--perf-timeout ms] " +
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

/** 性能附录：固定样本上跑官方 tsc 参考，与实现侧免费计时算比值（不参与退出码）。
 *
 * 参考 tsc 的逐案调用与实现侧逐案调用**交错**在同一循环里（每案 impl check
 * 之后立刻跑同案 tsc），避免实现侧早跑、参考侧晚跑带来的页缓存/JIT 系统偏差。
 */
async function runPerfAppendix(opts: {
  adapter: Adapter;
  args: Args;
  tscBin: string;
  perfBaseArgs: string[];
  implWalls: Map<string, number>;
  implCheckMs: Map<string, number>;
  reference: Map<string, ReferenceRun>;
  meta: Map<string, PerfCaseMeta> | null;
  order: Map<string, "ref-first" | "impl-first">;
  records: CaseRecord[];
  failed: number;
}): Promise<ReturnType<typeof buildPerfReport>> {
  const { adapter, args, tscBin, perfBaseArgs, implWalls, implCheckMs, reference, meta, order, records, failed } = opts;
  const warnings: string[] = [];
  if (args.mode === "fixed") warnings.push("fixed 模式下实现忽略用例选项，性能比值仅作流水线参考");
  const sampleIds = [...reference.keys()];
  const emptyFiles: CaseFile[] = [{ path: "empty.ts", text: "export {};\n" }];

  // 空程序基线取多次的最小值：单次会被冷启动/负载噪声放大，可能把分母推成负数。
  const EMPTY_REPS = 3;
  let implEmptyWallMs: number | null = null;
  try {
    const emptyArgs = toTscArgs(args.mode === "fixed" ? (adapter.fixedOptions ?? []) : [], [...args.baseArgsExtra]);
    for (let i = 0; i < EMPTY_REPS; i++) {
      const started = performance.now();
      const outcome = await adapter.check({ id: `__perf_empty_${i}__`, files: emptyFiles, options: [], args: emptyArgs });
      if (outcome.status !== "ok") {
        warnings.push(`实现空程序基线返回 ${outcome.status}，wall-adjusted ratio 不可用`);
        implEmptyWallMs = null;
        break;
      }
      const wall = performance.now() - started;
      if (implEmptyWallMs === null || wall < implEmptyWallMs) implEmptyWallMs = wall;
    }
  } catch (e) {
    warnings.push(`实现空程序基线运行抛错：${e instanceof Error ? e.message : String(e)}`);
  }

  // 参考空程序基线与实现侧相邻测量（都在样本之后），多次取最小。
  let refEmptyBest: ReferenceRun | null = null;
  for (let i = 0; i < 5; i++) {
    const run = runReference(tscBin, emptyFiles, [...perfBaseArgs, "--extendedDiagnostics"], args.perfTimeoutMs);
    if (run.status !== "ok") continue;
    if (refEmptyBest === null || run.wallMs < refEmptyBest.wallMs) refEmptyBest = run;
  }
  if (refEmptyBest !== null) reference.set("__empty__", refEmptyBest);

  const agreementIds = new Set(
    records
      .filter((r) => r.status === "ran" && r.fp.length === 0 && r.missed.length === 0 && r.misanchor === 0)
      .map((r) => r.id),
  );
  const report = buildPerfReport({
    seed: args.perfSeed,
    requested: args.perfSample,
    sampleIds,
    implWalls,
    implCheckMs,
    implEmptyWallMs,
    reference,
    agreementIds,
    meta: meta ?? undefined,
    order,
    warnings,
  });

  const fmt = (v: number | null): string => (v === null ? "n/a" : v.toFixed(3));
  const agg = (a: { median: number; geomean: number; p25: number; p75: number } | null): string =>
    a === null ? "n/a" : `median=${fmt(a.median)} geomean=${fmt(a.geomean)} P25=${fmt(a.p25)} P75=${fmt(a.p75)}`;
  console.log(
    `性能附录（样本 ${report.sample.size}/${sampleIds.length}、参考失败 ${failed}）：` +
      `实现 ${report.impl.meanWallMs.toFixed(1)}ms/案、tsc ${report.reference.meanWallMs.toFixed(1)}ms/案；` +
      `累加 Check=${fmt(report.ratio.check)}、wall-adj=${fmt(report.ratio.wallAdjusted)}；` +
      `逐案 check[${agg(report.ratio.perCase.check)}]、wall[${agg(report.ratio.perCase.wallAdjusted)}]；` +
      `一致子集 ${report.ratio.agreementSubset.cases} 例 check=${fmt(report.ratio.agreementSubset.check)}`,
  );
  const comp = report.sample.composition;
  console.log(
    `性能样本组成：suite=${JSON.stringify(comp.suite)} 行数档=${JSON.stringify(comp.lineBucket)} ` +
      `错误=${JSON.stringify(comp.errorPresence)} 顺序=${JSON.stringify(comp.order)}`,
  );
  for (const w of report.warnings) console.warn(`性能附录警告：${w}`);
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
  // 性能附录的样本在跑之前定下来（确定性分层抽样：suite × 行数档 × 有无期望错误），
  // 参考 tsc 在逐案循环里与实现交错跑。预扫描只读主文件计行数 + （官方基线模式下）
  // 一次基线文件存在性检查，用于「有无期望错误」分层；代价随语料线性、约百毫秒级。
  let perfMeta: Map<string, PerfCaseMeta> | null = null;
  let perfSampleIds: Set<string> | null = null;
  let perfOrder = new Map<string, "ref-first" | "impl-first">();
  if (args.perfRatio) {
    perfMeta = new Map<string, PerfCaseMeta>();
    for (const id of ids) {
      let lines = 0;
      try {
        lines = readFileSync(join(args.corpus!, id), "utf8").split(/\r?\n/).length;
      } catch {
        lines = 0;
      }
      const hasErrors =
        args.expectationSource === "official-baseline" ? baselineFileOf(args.corpus!, id) !== null : undefined;
      perfMeta.set(id, { lines, hasErrors });
    }
    const sample = selectPerfSample(ids, args.perfSample, args.perfSeed, perfMeta);
    perfSampleIds = new Set(sample);
    perfOrder = planPerfOrder(sample, args.perfSeed);
  }
  const perfReference = new Map<string, ReferenceRun>();
  // 参考侧与实现侧必须拿到同一组 CLI 参数：这里用「适配器侧参数」（用例指令 +
  // --base-arg/--adapter-arg），不含期望侧的官方默认值（那是给期望生成用的，
  // 例如 skipDefaultLibCheck 会让 tsc 少做 lib 检查，混入会系统性压低参考时间）。
  const perfBaseArgs = toTscArgs([], [...args.baseArgsExtra, ...args.adapterArgsExtra]);
  let perfReferenceFailed = 0;
  const records: CaseRecord[] = [];
  let optionDirectiveIgnored = 0;
  let excludedStatic = 0;
  let excludedRuntime = 0;
  // 性能附录的数据在正常兼容跑里免费收集：实现每案 wall + 参考 tsc 需要的输入。
  const perfImplWalls = new Map<string, number>();
  const perfImplChecks = new Map<string, number>();

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
    // 官方基线原文（T3 字节比对用）；现场生成期望时为 null。
    let baselineText: string | null = null;
    if (args.expectationSource === "official-baseline") {
      const official = expectationFromOfficialBaseline(args.corpus, id, parsed);
      if (official.status === "skip") {
        records.push(skipRecord(id, `官方基线:${official.reason}`, staticTags));
        continue;
      }
      baselineText = official.text;
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
    const perfOrderKind = perfSampleIds !== null && perfSampleIds.has(id) ? perfOrder.get(id) : undefined;
    let refRun: ReferenceRun | undefined;
    if (perfOrderKind === "ref-first") {
      // 顺序对冲的前一半：先跑官方参考，再跑实现（同参数、同案、紧邻）。
      refRun = runReference(tscBin, parsed.files, [...adapterArgs, "--extendedDiagnostics"], args.perfTimeoutMs);
    }
    const implStarted = performance.now();
    const outcome = await adapter.check({ id, files: parsed.files, options, args: adapterArgs });
    const implWallMs = performance.now() - implStarted;
    if (args.perfRatio && outcome.status === "ok") {
      perfImplWalls.set(id, implWallMs);
      if (typeof outcome.checkMs === "number") perfImplChecks.set(id, outcome.checkMs);
      if (perfOrderKind !== undefined) {
        // 后一半：实现刚跑完，紧接着跑官方 tsc（同参数），两侧经历同一时间窗。
        refRun ??= runReference(tscBin, parsed.files, [...adapterArgs, "--extendedDiagnostics"], args.perfTimeoutMs);
        perfReference.set(id, refRun);
        if (refRun.status !== "ok") perfReferenceFailed++;
      }
    }
    if (outcome.status !== "ok") {
      records.push(skipRecord(id, outcome.skipReason ?? `实现返回 ${outcome.status}`, tags));
      continue;
    }
    const record = compareCase(id, expectation.diagnostics, outcome.diagnostics, tags, baselineText);
    if (args.verbose) {
      console.log(
        `${shortCaseName(id)}: [${tags.join(" ")}] expect=${record.expected.length} actual=${record.actual.length} ` +
          `fp=${record.fp.length} miss=${record.missed.length} misanchor=${record.misanchor} tier=${record.tier}`,
      );
    }
    records.push(record);
  }
  let perf: ReturnType<typeof buildPerfReport> | undefined;
  if (args.perfRatio) {
    perf = await runPerfAppendix({
      adapter,
      args,
      tscBin,
      perfBaseArgs,
      implWalls: perfImplWalls,
      implCheckMs: perfImplChecks,
      reference: perfReference,
      meta: perfMeta,
      order: perfOrder,
      records,
      failed: perfReferenceFailed,
    });
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
  const metrics = summarize(records, meta) as Metrics & { perf?: ReturnType<typeof buildPerfReport> };
  if (perf !== undefined) metrics.perf = perf;
  let exitCode = 0;
  if (args.ratchet !== undefined && args.ratchetImpl !== undefined) {
    throw new Error("--ratchet 与 --ratchet-impl 只能二选一");
  }
  let ratchetPath = args.ratchet;
  if (ratchetPath === undefined && args.ratchetImpl !== undefined) {
    if (args.baseline === undefined) throw new Error("--ratchet-impl 需要 --baseline（用于推导清单路径）");
    ratchetPath = resolve(REPO_ROOT, ratchetPathFor(args.ratchetImpl, args.baseline));
  }
  if (ratchetPath !== undefined) {
    const existed = existsSync(ratchetPath);
    if (!existed && args.ratchetImpl === undefined && !args.ratchetInit) {
      throw new Error(
        `ratchet 清单不存在：${ratchetPath}（首次接入请加 --ratchet-init，或改用 --ratchet-impl <impl> 按实现分账自动初始化）`,
      );
    }
    const previous = readRatchet(ratchetPath);
    const check = checkRatchet(previous, records);
    let wrote = false;
    if (check.changed || !existed) {
      mkdirSync(dirname(ratchetPath), { recursive: true });
      writeRatchet(ratchetPath, check.next);
      wrote = true;
    }
    meta.ratchet = {
      path: ratchetPath,
      impl: args.ratchetImpl,
      initialized: !existed,
      regressions: check.regressions.length,
      improvements: check.improvements.length,
      wrote,
    };
    if (!existed) {
      console.log(`ratchet：首次创建清单 ${ratchetPath}（只登记当前档位，不作回落判定）`);
    }
    if (check.regressions.length > 0) {
      exitCode = 1;
      console.log(`ratchet 回落 ${check.regressions.length} 例（本次运行失败）：`);
      for (const r of check.regressions.slice(0, 20)) {
        console.log(`  ${r.id}: ${r.was} → ${r.now}${r.reason !== undefined ? `（${r.reason}）` : ""}`);
      }
      if (check.regressions.length > 20) console.log(`  …… 共 ${check.regressions.length} 例`);
    } else {
      console.log(
        `ratchet：无回落；改善 ${check.improvements.length} 例` + (wrote ? `，已写回 ${ratchetPath}` : "（清单未变）"),
      );
    }
  }
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
        tier: r.tier,
      })),
      null,
      2,
    )}\n`,
  );
  console.log(formatSummary(metrics));
  console.log(`结果：${join(args.out, "metrics.json")}`);
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
