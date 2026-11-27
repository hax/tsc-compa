// Reproduce the pinned TS7 / Bun / tsrs comparisons without uploading artifacts.
// Give one candidate per invocation so timings are not affected by other candidate runs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../src/baselines.ts";

const [corpusArg, outArg, candidate, ...optional] = process.argv.slice(2);
const perf = optional.at(-1) === "--perf-ratio";
if (perf) optional.pop();
const [binArg] = optional;
const baseline = "7.1.0-beta-official";
const tsc = join(REPO_ROOT, "node_modules/typescript-7-1/bin/tsc");
const manifest = "config/official-baseline-cases-ts71.json";
if (!corpusArg || !outArg || !candidate || !["typescript", "bun-1.4.4", "bun-1.4.5", "tsrs"].includes(candidate) ||
    (candidate !== "typescript" && !binArg) || optional.length > 1 || binArg?.startsWith("--")) {
  console.error("用法：bun scripts/validate-compatibility.ts <corpus> <out> typescript|bun-1.4.4|bun-1.4.5|tsrs [<candidate-bin>] [--perf-ratio]");
  process.exit(2);
}
const corpus = resolve(corpusArg);
const out = resolve(outArg);
const bin = binArg === undefined ? tsc : resolve(binArg);
if (!existsSync(bin)) throw new Error(`候选不可用：${bin}`);
const bun = candidate.startsWith("bun-");
const expectedVersion = bun ? candidate.slice("bun-".length) : "7.1.0-beta";
const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
const reportedVersion = version.stdout?.trim();
if (version.status !== 0 || (bun
  ? reportedVersion !== expectedVersion
  : candidate === "tsrs"
    ? !/^Version 7\.1\.0-beta \(tsrs 0\.25\.0-ts7\.1\.0-beta, microsoft\/TypeScript@3e9236361fa9\)$/.test(reportedVersion ?? "")
    : reportedVersion !== `Version ${expectedVersion}`)) {
  throw new Error(`候选版本与固定版本不一致：${candidate} (${reportedVersion || version.stderr || version.error || version.status})`);
}
const adapter = `${bun ? "bun-check" : "tsc-cli"}:${bin}`;
const caseCount = JSON.parse(readFileSync(join(REPO_ROOT, manifest), "utf8")).length as number;
for (const source of ["tsc", "official-baseline"] as const) {
  const dir = join(out, source);
  const run = spawnSync(process.execPath, [
    "src/run.ts", "--baseline", baseline, "--tsc", tsc, "--corpus", corpus,
    "--cases", manifest, "--expectation-source", source,
    "--option-strategy", "aligned", "--adapter", adapter, "--report-impl-name", `${candidate} (${reportedVersion})`,
    "--out", dir, "--report-out", dir,
    ...(perf ? ["--perf-ratio", "--perf-sample", "24"] : []),
  ], { cwd: REPO_ROOT, env: { ...process.env, TSC_COMPA_ADAPTER_ARGS: "", TSC_BIN: "" }, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`${candidate} / ${source} 运行失败：${run.error ?? run.status}`);
  const metrics = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8"));
  if (!metrics.meta.verdictEligible || metrics.totals.ran !== caseCount || metrics.meta.executionFailures?.length > 0) {
    throw new Error(`${candidate} / ${source} 未完成固定测试集的全部比较；报告保存在 ${dir}`);
  }
}
