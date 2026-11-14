// tsc-compa 冒烟运行器：发现用例 → 生成期望 → 驱动适配器 → 汇总指标。
//
// 用法（在仓库根）：
//   TSC_COMPA_CORPUS=/path/to/typescript/tests/cases \
//   TSC_BIN=/path/to/tsc \
//   MAAT_ZIG_BIN=/path/to/maat-zig \
//   bun src/run.ts --adapter maat-zig --mode fixed --cases config/smoke-cases.json
//
// 运行结果写 <out>/metrics.json 与 <out>/details.json，并在 stdout 打印摘要。
// v0 没有门禁（--gate 留给后续接入基线）；退出码恒 0，除非运行本身失败。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapter } from "./adapters/index.ts";
import { compareCase, formatSummary, skipRecord, summarize, type CaseRecord, type RunMeta } from "./compare.ts";
import { loadManifest, readCase } from "./discover.ts";
import { expectationOf, resolveTscPath, shortCaseName, tscVersionOf } from "./tsc.ts";
import { toTscArgs } from "./case.ts";
import type { Adapter } from "./types.ts";

interface Args {
  corpus?: string;
  cases: string;
  tsc?: string;
  adapter: string;
  mode: "official" | "fixed";
  out: string;
  limit?: number;
  verbose: boolean;
}

const TSC_BASE_ARGS = ["--noEmit", "--ignoreConfig", "--pretty", "false"];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: process.env.TSC_COMPA_CORPUS,
    cases: "config/smoke-cases.json",
    tsc: process.env.TSC_BIN,
    adapter: process.env.TSC_COMPA_ADAPTER ?? "maat-zig",
    mode: "official",
    out: ".cache/run",
    verbose: false,
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
        console.log("用法：bun src/run.ts [--corpus <tests/cases>] [--cases <manifest>] [--tsc <bin>] [--adapter <name>] [--mode official|fixed] [--out <dir>] [--limit N] [--verbose]");
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
  const tscBin = resolveTscPath(args.tsc);
  const tscVersion = tscVersionOf(tscBin);
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

  const ids = loadManifest(args.cases).slice(0, args.limit ?? Number.POSITIVE_INFINITY);
  const records: CaseRecord[] = [];
  let optionDirectiveIgnored = 0;

  for (const id of ids) {
    const parsed = readCase(args.corpus, id);
    if (parsed.skip !== null) {
      records.push(skipRecord(id, parsed.skip));
      continue;
    }
    if (parsed.unknown.length > 0) {
      records.push(skipRecord(id, `未知指令 ${parsed.unknown[0]}`));
      continue;
    }
    const options = args.mode === "fixed" ? adapter.fixedOptions! : parsed.options;
    if (args.mode === "fixed" && parsed.options.length > 0) optionDirectiveIgnored++;
    const tscArgs = toTscArgs(options, TSC_BASE_ARGS);
    const expectation = expectationOf(id, parsed.files, options, {
      tscBin,
      tscVersion,
      args: tscArgs,
      cacheDir: join(".cache", "expectations"),
    });
    if (expectation.status !== "ok") {
      const reason =
        expectation.status === "syntax"
          ? "tsc 语法解析失败"
          : expectation.status === "timeout"
            ? "tsc 侧超时"
            : "tsc 侧异常";
      records.push(skipRecord(id, reason));
      continue;
    }
    const outcome = await adapter.check({ id, files: parsed.files, options, args: tscArgs });
    if (outcome.status !== "ok") {
      records.push(skipRecord(id, outcome.skipReason ?? `实现返回 ${outcome.status}`));
      continue;
    }
    if (args.verbose) {
      const record = compareCase(id, expectation.diagnostics, outcome.diagnostics);
      console.log(
        `${shortCaseName(id)}: expect=${record.expected.length} actual=${record.actual.length} fp=${record.fp.length} miss=${record.missed.length}`,
      );
      records.push(record);
    } else {
      records.push(compareCase(id, expectation.diagnostics, outcome.diagnostics));
    }
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
    generatedAt: new Date().toISOString(),
    selectedCases: ids.length,
  };
  const metrics = summarize(records, meta);
  if (args.mode === "fixed") {
    console.warn(`提示：--mode fixed 下共忽略 ${optionDirectiveIgnored} 个用例的编译选项指令；结果只用于验证流水线。`);
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
