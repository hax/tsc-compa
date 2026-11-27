// Plan, execute and verify shards of the pinned TS7 compatibility evaluation.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { corpusRefOf, findBaseline, loadBaselines, resolveBaselineTsc, REPO_ROOT } from "../src/baselines.ts";
import { expandCaseVariants } from "../src/case.ts";
import { isValidCaseId, readCase } from "../src/discover.ts";
import { identifyTool, sha256 } from "../src/provenance.ts";
import type { Metrics, ToolIdentity } from "../src/compare.ts";

const baseline = "7.1.0-beta-official";
const candidates = ["typescript", "bun-1.4.4", "bun-1.4.5", "tsrs"] as const;
type Candidate = typeof candidates[number];
type Source = "official-baseline" | "tsc";
type Unit = { id: string; records: string[] };
type Shard = { id: string; units: Unit[]; estimatedCost: number };
interface Plan {
  version: 1;
  corpusRef: string;
  source: Source;
  candidates: Candidate[];
  shards: Shard[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const manifestHash = (ids: string[]) => sha256(JSON.stringify(ids));
const countOf = (shard: Shard) => shard.units.reduce((total, unit) => total + unit.records.length, 0);
const slug = (candidate: Candidate, shard: Shard) => `full-${candidate}-${shard.id}`;

/** Discover source cases, not ancillary JS fixtures or other TypeScript suites. */
export function compilerCaseIds(corpus: string): string[] {
  const ids: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(corpus, relative), { withFileTypes: true })) {
      const id = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(id);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
        if (!isValidCaseId(id)) throw new Error(`Invalid corpus ID: ${id}`);
        ids.push(id);
      }
    }
  };
  for (const suite of ["compiler", "conformance"]) walk(suite);
  return ids.sort();
}

export function buildPlan(corpus: string, corpusRef: string, n: number, source: Source, selected = [...candidates]): Plan {
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error("Shard count must be between 1 and 32");
  const allRecordIds = new Set<string>();
  const units = compilerCaseIds(corpus).map((id) => {
    const parsed = readCase(corpus, id);
    const expanded = parsed.skip === null && parsed.unknown.length === 0 ? expandCaseVariants(parsed) : null;
    const runnable = expanded?.status === "ok";
    const records = runnable ? expanded.variants.map((variant) => variant.variantId) : [id];
    for (const record of records) {
      if (allRecordIds.has(record)) throw new Error(`Duplicate configured ID: ${record}`);
      allRecordIds.add(record);
    }
    const bytes = parsed.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
    // A process start is a fixed cost. Use source size and configuration count only as a balancing heuristic.
    const cost = runnable ? records.length * (64 + Math.min(1024, Math.ceil(bytes / 256))) : 1;
    return { id, records, cost };
  });
  if (units.length < n) throw new Error(`Not enough sources (${units.length}) for ${n} shards`);
  const shards: Shard[] = Array.from({ length: n }, (_, i) => ({ id: String(i + 1).padStart(2, "0"), units: [], estimatedCost: 0 }));
  units.sort((a, b) => b.cost - a.cost || (a.id < b.id ? -1 : 1));
  for (const { cost, ...unit } of units) {
    const shard = shards.reduce((lightest, other) => other.estimatedCost < lightest.estimatedCost ? other : lightest);
    shard.units.push(unit);
    shard.estimatedCost += cost;
  }
  for (const shard of shards) shard.units.sort((a, b) => a.id < b.id ? -1 : 1);
  return { version: 1, corpusRef, source, candidates: selected, shards };
}

function verifyVersion(candidate: Candidate, bin: string): void {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const expected = candidate === "typescript" ? "Version 7.1.0-beta"
    : candidate === "tsrs" ? "Version 7.1.0-beta (tsrs 0.25.0-ts7.1.0-beta, microsoft/TypeScript@3e9236361fa9)"
    : candidate.slice(4);
  if (result.status !== 0 || result.stdout?.trim() !== expected) throw new Error(`${candidate}: expected ${expected}, got ${result.stdout || result.stderr || result.error}`);
}

function runShard(plan: Plan, shard: Shard, candidate: Candidate, corpus: string, dir: string, binArg?: string): void {
  const config = loadBaselines();
  const referenceWrapper = resolveBaselineTsc(findBaseline(config, baseline));
  // Bypass the npm JavaScript launcher for each case, not the pinned native compiler.
  const reference = identifyTool(referenceWrapper, "7.1.0-beta")?.native?.path ?? referenceWrapper;
  const bin = binArg === undefined && candidate === "typescript" ? reference : resolve(binArg ?? "");
  verifyVersion("typescript", reference);
  verifyVersion(candidate, bin);
  const isBun = candidate.startsWith("bun-");
  const native = isBun ? spawnSync(bin, ["-p", "process.execPath"], { encoding: "utf8", timeout: 10_000 }) : null;
  const candidateBin = native?.status === 0 && native.stdout.trim() ? native.stdout.trim() : bin;
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "cases.json");
  writeJson(manifest, shard.units.map((unit) => unit.id));
  const result = spawnSync(process.execPath, ["src/run.ts", "--baseline", baseline, "--tsc", reference,
    "--corpus", corpus, "--cases", manifest, "--expectation-source", plan.source, "--option-strategy", "aligned",
    "--adapter", `${isBun ? "bun-check" : "tsc-cli"}:${candidateBin}`, "--out", dir], {
    cwd: REPO_ROOT, env: { ...process.env, TSC_COMPA_ADAPTER_ARGS: "", TSC_BIN: "" }, stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${slug(candidate, shard)} exited: ${result.error ?? result.status}`);
}

const toolKey = (tool: ToolIdentity | null | undefined) => tool === undefined || tool === null ? null
  : [tool.version, tool.sha256, tool.native?.sha256 ?? null, tool.embeddedTypeScript ?? null];

export function verifyShard(plan: Plan, shard: Shard, dir: string, candidate?: Candidate): Metrics {
  const metrics = readJson<Metrics>(join(dir, "metrics.json"));
  const records = readJson<{ id: string; status: string }[]>(join(dir, "details.json"));
  const ids = shard.units.map((unit) => unit.id);
  const expected = shard.units.flatMap((unit) => unit.records);
  const ran = records.filter((record) => record.status === "ran").length;
  if (JSON.stringify(readJson<string[]>(join(dir, "cases.json"))) !== JSON.stringify(ids) ||
      metrics.meta?.manifest?.selectedIdsSha256 !== manifestHash(ids) || metrics.meta.selectedCases !== ids.length ||
      metrics.meta.baseline !== baseline || metrics.meta.corpusRef !== plan.corpusRef || metrics.meta.expectationSource !== plan.source ||
      metrics.meta.options?.strategy !== "aligned" || metrics.meta.verdictEligible !== true ||
      (candidate !== undefined && !metrics.meta.adapter.startsWith(candidate.startsWith("bun-") ? "bun-check:" : "tsc-cli:")) ||
      !Array.isArray(metrics.meta.executionFailures) || JSON.stringify(records.map((record) => record.id)) !== JSON.stringify(expected) ||
      records.some((record) => record.status !== "ran" && record.status !== "skip") ||
      metrics.totals.cases !== expected.length || metrics.totals.ran !== ran || metrics.totals.skipped !== expected.length - ran ||
      metrics.skips.reduce((sum, [, n]) => sum + n, 0) !== metrics.totals.skipped ||
      [metrics.comparison.compatibility, metrics.comparison.strict].some((counts) => counts.pass + counts.fail + counts.unknown !== ran)) {
    throw new Error(`Shard output does not match its case plan: ${dir}`);
  }
  return metrics;
}

export function aggregate(plan: Plan, root: string) {
  const issues: string[] = [];
  const plans = plan.shards.flatMap((shard) => shard.units);
  const recordIds = plans.flatMap((unit) => unit.records);
  if (new Set(plan.shards.map((shard) => shard.id)).size !== plan.shards.length ||
      new Set(plans.map((unit) => unit.id)).size !== plans.length || new Set(recordIds).size !== recordIds.length) {
    issues.push("Duplicate shard, source or configured case in the plan");
  }
  const referenceInputs = new Map<string, string>();
  const rows = plan.candidates.map((candidate) => {
    const output = { candidate, shards: 0, sourceFiles: 0, records: 0, ran: 0, skipped: 0, hits: 0, expected: 0,
      fp: 0, missed: 0, misanchor: 0, executionFailures: 0,
      compatibility: { pass: 0, fail: 0, unknown: 0 }, strict: { pass: 0, fail: 0, unknown: 0 },
      skipReasons: Object.create(null) as Record<string, number>, tools: null as Metrics["meta"]["tools"] | null,
    };
    let toolIdentity: string | undefined;
    for (const shard of plan.shards) {
      const name = slug(candidate, shard);
      try {
        const metrics = verifyShard(plan, shard, join(root, name), candidate);
        const tools = metrics.meta.tools;
        if (!tools?.reference.sha256 || !tools.candidate?.sha256) throw new Error("Missing executable identity");
        const identity = JSON.stringify([tools.runner, tools.platform, toolKey(tools.reference), toolKey(tools.candidate)]);
        if (toolIdentity !== undefined && toolIdentity !== identity) throw new Error("Inconsistent executable identity across shards");
        const inputs = JSON.stringify([toolKey(tools.reference), metrics.meta.manifest?.parsedInputsSha256,
          metrics.meta.manifest?.officialInputsSha256, metrics.meta.options?.referenceBaseArgs]);
        const previousInputs = referenceInputs.get(shard.id);
        if (previousInputs !== undefined && previousInputs !== inputs) throw new Error("Inconsistent reference inputs across candidates");
        referenceInputs.set(shard.id, inputs);
        toolIdentity = identity;
        output.tools = tools;
        output.shards++;
        output.sourceFiles += shard.units.length;
        output.records += metrics.totals.cases;
        output.ran += metrics.totals.ran;
        output.skipped += metrics.totals.skipped;
        output.hits += metrics.totals.hitTotal;
        output.expected += metrics.totals.expectTotal;
        output.fp += metrics.totals.fpTotal;
        output.missed += metrics.totals.missTotal;
        output.misanchor += metrics.totals.misanchorTotal;
        const failures = metrics.meta.executionFailures!.length;
        output.executionFailures += failures;
        if (failures) issues.push(`${name}: ${failures} execution failures (see shard artifact)`);
        for (const profile of ["compatibility", "strict"] as const) {
          for (const verdict of ["pass", "fail", "unknown"] as const) output[profile][verdict] += metrics.comparison[profile][verdict];
        }
        for (const [reason, n] of metrics.skips) output.skipReasons[reason] = (output.skipReasons[reason] ?? 0) + n;
      } catch (error) {
        issues.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (output.ran === 0) issues.push(`${candidate}: no comparable records`);
    return { ...output, coverage: output.expected === 0 ? null : output.hits / output.expected };
  });
  const sourceFiles = plans.length;
  const records = recordIds.length;
  return { source: plan.source, corpusRef: plan.corpusRef, planSha256: sha256(JSON.stringify(plan)), sourceFiles, records, shards: plan.shards.length,
    complete: issues.length === 0, issues, candidates: rows };
}

function main(): void {
  const [command, ...a] = process.argv.slice(2);
  if (command === "plan" && a.length === 4) {
    const [corpus, dir, count, source] = a as [string, string, string, Source];
    if (source !== "official-baseline" && source !== "tsc") throw new Error(`Unknown source: ${source}`);
    const config = loadBaselines();
    const ref = corpusRefOf(config, findBaseline(config, baseline));
    if (!ref) throw new Error("No pinned corpus");
    const plan = buildPlan(resolve(corpus), ref, Number(count), source);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "plan.json"), plan);
    const include = plan.candidates.flatMap((candidate) => plan.shards.map((shard) => ({ candidate, shard: shard.id, bun: candidate === "bun-1.4.4" ? "1.4.4" : "1.4.5" })));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include })}\n`);
    console.log(`${plan.candidates.length} candidates × ${plan.shards.length} shards: ${plan.shards.flatMap((shard) => shard.units).length} source files, ${plan.shards.reduce((n, shard) => n + countOf(shard), 0)} records per candidate`);
  } else if (command === "run" && (a.length === 5 || a.length === 6)) {
    const [planPath, shardId, candidate, corpus, dir, bin] = a as [string, string, Candidate, string, string, string?];
    const plan = readJson<Plan>(planPath);
    const shard = plan.shards.find((s) => s.id === shardId);
    if (!shard || !candidates.includes(candidate) || !plan.candidates.includes(candidate)) throw new Error("Unknown shard/candidate");
    runShard(plan, shard, candidate, resolve(corpus), resolve(dir), bin);
    const metrics = verifyShard(plan, shard, dir, candidate);
    if (metrics.meta.executionFailures!.length > 0) process.exitCode = 1;
  } else if (command === "merge" && a.length === 3) {
    const [planPath, root, out] = a as [string, string, string];
    const summary = aggregate(readJson<Plan>(planPath), root);
    mkdirSync(out, { recursive: true });
    writeJson(join(out, "summary.json"), summary);
    const lines = ["# TS7 全量类型检查对照", "", `参考：\`${summary.source}\`；测试集：\`${summary.corpusRef}\``, "",
      `每个候选计划 ${summary.sourceFiles} 个源文件、${summary.records} 条配置记录（包括未展开的跳过项）。${summary.complete ? "所有分片已核对。" : `结果不完整：${summary.issues.length} 个问题。`}`, "",
      "| 候选 | 分片 | 完成 / 跳过 | 兼容（通 / 败 / 未知） | 严格（通 / 败 / 未知） | 命中 / 期望 | 多报 / 漏报 / 错锚 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...summary.candidates.map((r) => `| ${r.candidate} | ${r.shards}/${summary.shards} | ${r.ran} / ${r.skipped} | ${r.compatibility.pass} / ${r.compatibility.fail} / ${r.compatibility.unknown} | ${r.strict.pass} / ${r.strict.fail} / ${r.strict.unknown} | ${r.hits} / ${r.expected} | ${r.fp} / ${r.missed} / ${r.misanchor} |`),
      "", "逐案明细见 `full-<候选>-<分片>` 产物；全部跳过原因与执行问题见 `full-summary` 中的 `summary.json`。", ""];
    const markdown = lines.join("\n");
    writeFileSync(join(out, "summary.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
    if (!summary.complete) process.exitCode = 1;
  } else {
    throw new Error("full-compatibility.ts plan <corpus> <out> <shards> <official-baseline|tsc> | run <plan.json> <shard> <candidate> <corpus> <out> [binary] | merge <plan.json> <artifacts> <out>");
  }
}

if (import.meta.main) main();
