// Draft selection from immutable Actions evidence, not a workflow dispatcher.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../src/baselines.ts";
import { isValidCaseId } from "../src/discover.ts";
import { sha256 } from "../src/provenance.ts";
import { isKnownAuxiliaryLine } from "../src/adapters/plain-diagnostics.ts";
import type { CaseRecord } from "../src/compare.ts";
import type { Diagnostic } from "../src/types.ts";
import { verifyShard, type Plan } from "./full-compatibility.ts";

const repo = "hax/tsc-compa";
const suiteDir = join(REPO_ROOT, "config/curated-difference-v1");
const json = (value: unknown) => JSON.stringify(value);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digest = (value: unknown) => sha256(json(value));
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function check(test: unknown, message: string): asserts test {
  if (!test) throw new Error(message);
}

export type CaseKey = { source: string; configuration: string | null };
type Point = [file: string, line: number, column: number, severity: string, code: number];
export type Observation = {
  status: "pass" | "mismatch" | "unknown";
  reference: Point[];
  actual: Point[];
  hits: number;
  extra: number[];
  missing: number[];
  moved: number[];
} | { status: "skip"; kind: "unsupported-option" | "reference-unavailable" | "other"; reason: string; optionEvidence?: { args: string[]; diagnostics: string[] } };
export type Origin = { candidate: string; family: string; role: "reference-control" | "public-full" | "release-preview" };
export type Joined = CaseKey & { observations: Record<string, Observation> };
export type Bucket = "multiple-families" | "single-family" | "reference-disagreement" | "intentional-skip" | "control-with-diagnostics" | "control-without-diagnostics";
type Budgets = Record<Exclude<Bucket, "single-family"> | "single-family-per-family", number>;
type Classified = Joined & { bucket: Bucket | null; mismatchFamilies: string[]; comparableFamilies: number; cluster: string | null };
type RunPin = { run: number; attempt: number; commit: string };
type Run = Origin & RunPin & { reportId: string };
type Inputs = { suite: string; corpus: string; baseline: string; budgets: Budgets; runs: Run[]; probes: RunPin & { artifact: string } };
type Detail = Pick<CaseRecord, "id" | "status" | "skipReason" | "expected" | "actual" | "hits" | "comparison" | "misanchor" | "actualExitCode" | "actualArgs" | "actualRawOutput"> &
  { caseId?: string; configuration?: string; fp: string[]; missed: string[] };
type Tool = { version: string; sha256: string; nativeSha256: string | null; embeddedTypeScript: string | null };
type Request = { candidate: string; candidateVersion: string; suite: string; source: string; reference: string; corpus: string;
  planSha256: string; planCounts: { shards: number; sourceFiles: number; records: number };
  adapter: string; platform: string; harnessSha256: string; referenceTool: Tool; candidateTool: Tool; distributions: { reference: string; candidate: string | null };
  prepared?: { source: unknown; runtimeLibrariesSha256: string; environment: Record<string, string> };
  options: { mode: string; strategy: string; referenceBaseArgs: string[]; candidateEnvArgs?: string[] };
  inputs: { shard: string; parsedInputsSha256: string; officialInputsSha256: string }[] };
type Totals = { ran: number; skipped: number; hits: number; expected: number; fp: number; missed: number; misanchor: number;
  compatibility: { pass: number; fail: number; unknown: number } };

const points = (ds: Diagnostic[]): Point[] => ds.map((d): Point => [d.file, d.line + 1, d.col + 1, d.severity, d.code])
  .sort((a, b) => order(json(a), json(b)));
const codes = (ns: number[]): number[] => [...new Set(ns)].sort((a, b) => a - b);
const keyOf = (k: CaseKey) => json([k.source, k.configuration]);

export function caseKey(detail: Pick<Detail, "id" | "caseId" | "configuration">, source: string): CaseKey {
  check(isValidCaseId(source) && (detail.id === source
    ? detail.caseId === undefined && detail.configuration === undefined
    : detail.caseId === source && typeof detail.configuration === "string" && detail.configuration.length > 0 &&
      detail.id === source.replace(/(\.[^.\/]+)$/, `(${detail.configuration})$1`)), `Invalid configured record ${source} / ${detail.id}`);
  return { source, configuration: detail.configuration ?? null };
}

/** Recover narrowly evidenced option rejections from the pinned embedded-lib tsz preview. */
export function tszOptionEvidence(detail: Pick<Detail, "actual" | "actualArgs" | "actualExitCode" | "actualRawOutput">) {
  if (detail.actualExitCode !== 1 || detail.actual.length || !detail.actualArgs || !detail.actualRawOutput) return undefined;
  const last = new Map<string, string>();
  for (let i = 0; i < detail.actualArgs.length; i++) {
    const flag = detail.actualArgs[i]!;
    const value = detail.actualArgs[i + 1];
    if (flag.startsWith("--") && value && !value.startsWith("--")) last.set(flag.slice(2).toLowerCase(), value.toLowerCase());
  }
  const diagnostics = `${detail.actualRawOutput.stdout}\n${detail.actualRawOutput.stderr}`.split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => !isKnownAuxiliaryLine(line) && !/^(?:Errors|Total diagnostics):\s*\d+$/.test(line));
  const args = new Set<string>();
  for (const line of diagnostics) {
    const removed = /^error TS5108: Option '([a-zA-Z]+)=([a-zA-Z0-9]+)' has been removed\. Please remove it from your configuration\.$/.exec(line);
    const choices = /^error TS6046: Argument for '--(target|module)' option must be: ('.+')\.$/.exec(line);
    const bundler = line === "error TS5095: Option 'bundler' can only be used when 'module' is set to 'preserve', 'commonjs', or 'es2015' or later.";
    const option = removed?.[1]?.toLowerCase() ?? choices?.[1];
    const value = option === undefined ? undefined : last.get(option);
    if (removed && value === removed[2]!.toLowerCase() || choices && value &&
        [...choices[2]!.matchAll(/'([^']+)'/g)].every((m) => m[1]!.toLowerCase() !== value)) {
      args.add(`--${option}=${value}`);
    } else if (bundler && last.get("moduleresolution") === "bundler" && ["system", "umd"].includes(last.get("module") ?? "")) {
      args.add(`--module=${last.get("module")}`);
      args.add("--moduleresolution=bundler");
    } else return undefined; // Unknown/unpositioned or mixed output is not an intentional skip.
  }
  if (diagnostics.length > 0 && args.size > 0) return { args: [...args].sort(order), diagnostics: diagnostics.sort(order) };
}

export function observe(detail: Detail, tszEmbedded = false): Observation {
  if (detail.status === "skip") {
    check(typeof detail.skipReason === "string" && detail.skipReason.length, `Missing skip reason: ${detail.id}`);
    const reason = detail.skipReason;
    const optionEvidence = tszEmbedded && reason === "实现输出含无文件位置的诊断" ? tszOptionEvidence(detail) : undefined;
    // These are explicitly unsupported by the Bun adapter, not unclassified output or crashes.
    const kind = optionEvidence || /^Bun (?:check 不生成声明文件|1\.4\.x 不支持 )/.test(reason) ? "unsupported-option"
      : reason.startsWith("官方基线:") ? "reference-unavailable" : "other";
    return { status: "skip", kind, reason, ...(optionEvidence ? { optionEvidence } : {}) };
  }
  const c = detail.comparison;
  check(detail.status === "ran" && c && ["pass", "fail", "unknown"].includes(c.compatibility), `Missing comparison: ${detail.id}`);
  const code = (diagnostics: Diagnostic[], i: number) => {
    const n = diagnostics[i]?.code;
    check(Number.isInteger(n), `Invalid diagnostic index in ${detail.id}`);
    return n;
  };
  return {
    status: c.compatibility === "fail" ? "mismatch" : c.compatibility,
    reference: points(detail.expected), actual: points(detail.actual), hits: detail.hits,
    extra: c.extraErrors.map((i) => code(detail.actual, i)), missing: c.missing.map((i) => code(detail.expected, i)),
    moved: c.positionDifferences.map((pair) => code(detail.expected, pair.expected)),
  };
}

/** Join by source AND configuration, never by array order or source alone. Missing rows fail closed. */
export function joinEvidence(inputs: { origin: Origin; rows: (CaseKey & { observation: Observation })[] }[]): Joined[] {
  check(inputs.length > 0 && new Set(inputs.map(({ origin }) => origin.candidate)).size === inputs.length, "No inputs or duplicate candidates");
  const all = new Map<string, Joined>();
  for (const { origin, rows } of [...inputs].sort((a, b) => order(a.origin.candidate, b.origin.candidate))) {
    for (const { source, configuration, observation } of rows) {
      const key = keyOf({ source, configuration });
      const row = all.get(key) ?? { source, configuration, observations: Object.create(null) as Joined["observations"] };
      check(!Object.hasOwn(row.observations, origin.candidate), `Duplicate ${origin.candidate} record ${key}`);
      row.observations[origin.candidate] = observation;
      all.set(key, row);
    }
  }
  const rows = [...all.values()].sort((a, b) => order(keyOf(a), keyOf(b)));
  for (const row of rows) {
    const observed = Object.values(row.observations);
    check(observed.length === inputs.length, `Incomplete evidence for ${keyOf(row)}`);
    const compared = observed.filter((o) => o.status !== "skip");
    check(compared.every((o) => equal(o.reference, compared[0]!.reference)), `Different official diagnostic points for ${keyOf(row)}`);
  }
  return rows;
}

const signature = (o: Extract<Observation, { hits: number }>) => [codes(o.extra), codes(o.missing), codes(o.moved)];
export function classify(row: Joined, origins: Origin[]): Classified {
  const anchors = origins.filter((o) => o.role === "reference-control");
  check(anchors.length === 1, "Exactly one reference control is required");
  const reference = row.observations[anchors[0]!.candidate]!;
  const others = origins.filter((o) => o.role !== "reference-control").map((o) => [o.family, row.observations[o.candidate]!] as const);
  const families = new Map<string, Set<string>>();
  const comparable = new Set<string>();
  const passed = new Set<string>();
  for (const [family, observation] of others) {
    if (observation.status === "pass") passed.add(family);
    if (observation.status === "pass" || observation.status === "mismatch") comparable.add(family);
    if (observation.status !== "mismatch" || reference.status !== "pass") continue;
    const profiles = families.get(family) ?? new Set<string>();
    profiles.add(json(signature(observation)));
    families.set(family, profiles);
  }
  const mismatchFamilies = [...families.keys()].sort(order);
  const result = (bucket: Bucket | null, profile: unknown = null): Classified => ({ ...row, bucket, mismatchFamilies,
    comparableFamilies: comparable.size, cluster: bucket === null ? null : digest([bucket, profile]) });
  if (reference.status === "mismatch") return result("reference-disagreement", signature(reference));
  if (reference.status !== "pass") return result(null);
  const profile = mismatchFamilies.map((family) => [family, [...families.get(family)!].sort(order)]);
  if (mismatchFamilies.length > 1) return result("multiple-families", profile);
  if (mismatchFamilies.length === 1) return result([...passed].some((family) => family !== mismatchFamilies[0]) ? "single-family" : null, profile);
  if (others.every(([, o]) => o.status === "pass")) {
    return result(reference.reference.length ? "control-with-diagnostics" : "control-without-diagnostics",
      [row.source.startsWith("conformance/"), codes(reference.reference.map((p) => p[4]))]);
  }
  if (comparable.size > 0 && others.every(([, o]) => o.status === "pass" || o.status === "skip" && o.kind === "unsupported-option")) {
    return result("intentional-skip", [...new Set(others.flatMap(([family, o]) => o.status === "skip" ? [`${family}: ${o.optionEvidence?.args.join(" ") ?? o.reason}`] : []))].sort(order));
  }
  return result(null);
}

const buckets: Bucket[] = ["multiple-families", "single-family", "reference-disagreement", "intentional-skip",
  "control-with-diagnostics", "control-without-diagnostics"];
function size(row: Joined) {
  return Math.max(0, ...Object.values(row.observations).map((o) => o.status === "skip" ? 0 : Math.max(o.reference.length, o.actual.length)));
}
function stem(source: string) {
  // Suppress numbered siblings after picking a representative, even when diagnostics drift slightly.
  return source.replace(/\d+(?=\.(?:ts|tsx|mts|cts)$)/, "");
}
export function selectCases(ledger: Classified[], budgets: Budgets, fixedSources: ReadonlySet<string> = new Set()) {
  const selected: (Classified & { bucket: Bucket; reason: string })[] = [];
  const usedSources = new Set<string>();
  const usedStems = new Set<string>();
  const usedClusters = new Set<string>();
  const counts = new Map<string, number>();
  const ranked = [...ledger].sort((a, b) => b.mismatchFamilies.length - a.mismatchFamilies.length ||
    b.comparableFamilies - a.comparableFamilies ||
    // Retain existing regression anchors when they show a new single-family difference.
    Number(b.bucket === "single-family" && fixedSources.has(b.source)) - Number(a.bucket === "single-family" && fixedSources.has(a.source)) ||
    size(a) - size(b) || order(keyOf(a), keyOf(b)));
  for (const bucket of buckets) for (const row of ranked) {
    if (row.bucket !== bucket || (bucket.startsWith("control-") && fixedSources.has(row.source)) || usedSources.has(row.source) ||
        usedStems.has(stem(row.source)) || usedClusters.has(row.cluster!)) continue;
    const quotaKey = bucket === "single-family" ? `${bucket}:${row.mismatchFamilies[0]}` : bucket;
    const count = counts.get(quotaKey) ?? 0;
    if (count >= budgets[bucket === "single-family" ? "single-family-per-family" : bucket]) continue;
    const reason = bucket === "multiple-families" ? `Compatibility mismatch in multiple families: ${row.mismatchFamilies.join(", ")}`
      : bucket === "single-family" ? `Only observed mismatch family: ${row.mismatchFamilies[0]}; at least one other family passed`
      : bucket === "reference-disagreement" ? "Official TS7 CLI itself differs from .errors.txt; not attributed to candidates"
      : bucket === "intentional-skip" ? "Explicit unsupported option in at least one candidate; all observed comparisons passed"
      : bucket === "control-with-diagnostics" ? "All runs passed against a nonempty official diagnostic set"
      : "All runs passed against an empty official diagnostic set";
    selected.push({ ...row, bucket, reason });
    counts.set(quotaKey, count + 1);
    usedSources.add(row.source);
    usedStems.add(stem(row.source));
    usedClusters.add(row.cluster!);
  }
  return selected;
}

const runUrl = (pin: RunPin) => `https://github.com/${repo}/actions/runs/${pin.run}`;
function checkRun(dir: string, pin: RunPin, workflow: string, event: string) {
  const run = read<{ id: number; run_attempt: number; head_sha: string; conclusion: string; name: string; event: string; html_url: string }>(join(dir, "run.json"));
  check(run.id === pin.run && run.run_attempt === pin.attempt && run.head_sha === pin.commit && run.conclusion === "success" &&
    run.name === workflow && run.event === event && run.html_url === runUrl(pin), `Unexpected or incomplete Actions run ${pin.run}`);
}

function coverage(rows: Observation[]) {
  const out = { records: rows.length, ran: 0, skipped: 0, pass: 0, mismatch: 0, unknown: 0, hits: 0, expected: 0,
    skipKinds: { "unsupported-option": 0, "reference-unavailable": 0, other: 0 } };
  for (const o of rows) {
    if (o.status === "skip") { out.skipped++; out.skipKinds[o.kind]++; }
    else { out.ran++; out[o.status]++; out.hits += o.hits; out.expected += o.reference.length; }
  }
  return { ...out, recordCoverage: rows.length ? out.ran / rows.length : null, diagnosticCoverage: out.expected ? out.hits / out.expected : null };
}

function loadRun(root: string, spec: Inputs, origin: Run) {
  const dir = join(root, String(origin.run));
  checkRun(dir, origin, "public-evaluation", "workflow_dispatch");
  const requestDir = join(dir, "public-evaluation-request");
  const request = read<Request>(join(requestDir, "request.json"));
  const plan = read<Plan>(join(requestDir, "plan.json"));
  const report = read<{ id: string; request: Request; runUrl: string; summary: Totals & { complete: boolean; records: number; shards: number; sourceFiles: number } }>(
    join(dir, "public-evaluation-report", `${origin.reportId}.json`));
  check(request.candidate === origin.candidate && request.suite === "full" && request.reference === spec.baseline &&
    request.corpus === spec.corpus && request.source === "official-baseline" && request.options.mode === "official" &&
    request.options.strategy === "aligned" && plan.corpusRef === spec.corpus && plan.source === request.source && plan.version === 1 &&
    equal(plan.candidates, [origin.candidate]) && request.planSha256 === digest(plan) &&
    report.id === origin.reportId && digest(request) === report.id && equal(request, report.request) &&
    report.runUrl === runUrl(origin) && report.summary.complete === true &&
    (origin.role !== "release-preview" || request.prepared !== undefined), `Inconsistent public-evaluation request/plan/report: ${origin.run}`);
  const rows: (CaseKey & { observation: Observation })[] = [];
  const sourceIds = new Set<string>();
  const artifactHashes: Record<string, { metrics: string; details: string }> = {};
  const counted = { fp: 0, missed: 0, misanchor: 0 };
  let candidateArgs: string[] | undefined;
  const seenShards = new Set<string>();
  for (const shard of plan.shards) {
    check(/^\d{2}$/.test(shard.id) && !seenShards.has(shard.id), `Invalid shard ${shard.id} in ${origin.run}`);
    seenShards.add(shard.id);
    const name = `full-${origin.candidate}-${shard.id}`;
    const path = join(dir, name);
    const metrics = verifyShard(plan, shard, path);
    const receipt = read<{ id: string; shard: string; candidateDistributionSha256?: string;
      runtimeLibrariesSha256?: string; candidateEnvironment?: Record<string, string> }>(join(path, "public-request.json"));
    const input = request.inputs.find((i) => i.shard === shard.id);
    const opts = metrics.meta.options;
    const tools = metrics.meta.tools;
    check(receipt.id === report.id && receipt.shard === shard.id && metrics.meta.mode === "official" &&
      metrics.meta.corpusRef === spec.corpus && metrics.meta.adapter.startsWith(`${request.adapter}:`) &&
      (request.prepared === undefined || (receipt.candidateDistributionSha256 === request.distributions.candidate &&
        receipt.runtimeLibrariesSha256 === request.prepared.runtimeLibrariesSha256 && equal(receipt.candidateEnvironment, request.prepared.environment))) &&
      input && input.parsedInputsSha256 === metrics.meta.manifest?.parsedInputsSha256 &&
      input.officialInputsSha256 === metrics.meta.manifest?.officialInputsSha256 &&
      equal(opts?.referenceBaseArgs, request.options.referenceBaseArgs) && equal(opts?.candidateArgs, opts?.referenceBaseArgs) &&
      equal(opts?.candidateEnvArgs, request.options.candidateEnvArgs ?? []) && opts !== undefined &&
      equal(opts.sharedArgs, []) && equal(opts.onlyClasses, []) && equal(opts.excludeClasses, []) &&
      (candidateArgs === undefined || equal(opts.candidateEnvArgs, candidateArgs)) &&
      tools?.reference.sha256 === request.referenceTool.sha256 && tools?.candidate?.sha256 === request.candidateTool.sha256 &&
      metrics.meta.executionFailures?.length === 0, `Input/identity mismatch or execution failures: ${origin.run}/${name}`);
    candidateArgs = opts.candidateEnvArgs;
    const details = read<Detail[]>(join(path, "details.json"));
    const shardRows: Observation[] = [];
    let cursor = 0;
    for (const unit of shard.units) {
      check(!sourceIds.has(unit.id), `Duplicate planned source ${unit.id} in ${origin.run}`);
      sourceIds.add(unit.id);
      for (const record of unit.records) {
        const detail = details[cursor++]!;
        check(detail.id === record, `Wrong record for ${unit.id}: ${detail.id}`);
        const observation = observe(detail, origin.candidate === "tsz" && request.prepared?.environment.TSZ_USE_EMBEDDED_LIBS === "1");
        shardRows.push(observation);
        rows.push({ ...caseKey(detail, unit.id), observation });
        counted.fp += detail.fp.length;
        counted.missed += detail.missed.length;
        counted.misanchor += detail.misanchor;
      }
    }
    const shardCounts = coverage(shardRows);
    const { totals, comparison } = metrics;
    check(shardCounts.hits === totals.hitTotal && shardCounts.expected === totals.expectTotal &&
      shardCounts.pass === comparison.compatibility.pass && shardCounts.mismatch === comparison.compatibility.fail &&
      shardCounts.unknown === comparison.compatibility.unknown, `Shard details do not match metrics: ${origin.run}/${name}`);
    artifactHashes[name] = { metrics: sha256(readFileSync(join(path, "metrics.json"))), details: sha256(readFileSync(join(path, "details.json"))) };
  }
  const counts = coverage(rows.map((r) => r.observation));
  const shape = { shards: plan.shards.length, sourceFiles: sourceIds.size, records: rows.length };
  const summary = report.summary;
  check(equal(shape, request.planCounts) && shape.shards === summary.shards && shape.sourceFiles === summary.sourceFiles &&
    shape.records === summary.records && counts.ran === summary.ran && counts.skipped === summary.skipped &&
    counts.hits === summary.hits && counts.expected === summary.expected && counts.pass === summary.compatibility.pass &&
    counts.mismatch === summary.compatibility.fail && counts.unknown === summary.compatibility.unknown &&
    counted.fp === summary.fp && counted.missed === summary.missed && counted.misanchor === summary.misanchor,
  `Run totals do not match full report: ${origin.run}`);
  return { origin, rows, referenceTool: request.referenceTool, referenceArgs: request.options.referenceBaseArgs, comparableInput: digest([plan.shards, request.inputs, request.options.referenceBaseArgs, request.referenceTool, request.distributions.reference]),
    evidence: { ...origin, url: runUrl(origin), candidateVersion: request.candidateVersion, adapter: request.adapter, candidateArgs,
      platform: request.platform, candidateTool: request.candidateTool, distributions: request.distributions, prepared: request.prepared ?? null, harnessSha256: request.harnessSha256, planSha256: request.planSha256,
      sourceFiles: sourceIds.size, ...counts, executionFailures: 0, artifacts: artifactHashes } };
}

type ProbeManifest = { upstreamCommit: string; probes: { id: string; upstreamCase: string; description: string; ts6: PointTail[]; ts7: PointTail[] }[] };
type PointTail = [number, number, string, number];
type ProbeReport = { upstreamCommit: string; calibrated: boolean; candidate: null; anchors: Record<"ts6" | "ts7", { version: string; sha256: string; native?: { sha256: string } }>;
  probes: { id: string; upstreamCase: string; sourceSha256: string; options: unknown; calibrated: boolean;
    official: Record<"ts6" | "ts7", { status: string; fingerprint: Point[] }> }[] };
function loadProbes(root: string, spec: Inputs) {
  const { probes: pin } = spec;
  const dir = join(root, String(pin.run));
  checkRun(dir, pin, "TS version probes", "push");
  const path = join(dir, pin.artifact, "report.json");
  const report = read<ProbeReport>(path);
  const manifest = read<ProbeManifest>(join(REPO_ROOT, "config/version-probes/manifest.json"));
  check(report.upstreamCommit === manifest.upstreamCommit && spec.corpus.endsWith(`@${manifest.upstreamCommit}`) &&
    report.calibrated && report.candidate === null && report.probes.length === 5 && manifest.probes.length === report.probes.length &&
    report.anchors.ts6.version === "Version 6.0.3" && report.anchors.ts7.version === "Version 7.1.0-beta", "Uncalibrated official probes");
  const probes = manifest.probes.map((p) => {
    const actual = report.probes.find((row) => row.id === p.id);
    const source = `config/version-probes/${p.id}.ts`;
    check(actual?.calibrated && actual.upstreamCase === p.upstreamCase && actual.sourceSha256 === sha256(readFileSync(join(REPO_ROOT, source))),
      `Drifted official probe source: ${p.id}`);
    for (const anchor of ["ts6", "ts7"] as const) {
      check(actual.official[anchor].status === "checked" &&
        equal(actual.official[anchor].fingerprint, p[anchor].map((point) => [`${p.id}.ts`, ...point])), `Drifted ${anchor} probe: ${p.id}`);
    }
    return { id: p.id, source, upstreamCase: p.upstreamCase, reason: p.description, sourceSha256: actual.sourceSha256,
      options: actual.options, ts6: actual.official.ts6.fingerprint, ts7: actual.official.ts7.fingerprint };
  });
  const tool = ({ version, sha256, native }: ProbeReport["anchors"]["ts6"]) => ({ version, sha256, nativeSha256: native?.sha256 ?? null });
  return { ...pin, url: runUrl(pin), upstreamCommit: manifest.upstreamCommit, reportSha256: sha256(readFileSync(path)),
    anchors: { ts6: tool(report.anchors.ts6), ts7: tool(report.anchors.ts7) }, probes };
}

function main() {
  const [command, input, output, ...rest] = process.argv.slice(2);
  check(command === "generate" && input && output && !rest.length,
    "Usage: bun scripts/curate-compatibility.ts generate <Actions downloads> <output directory>");
  const spec = read<Inputs>(join(suiteDir, "inputs.json"));
  const root = resolve(input);
  const runs = spec.runs.map((origin) => loadRun(root, spec, origin));
  check(runs.every((run) => run.comparableInput === runs[0]?.comparableInput), "The full runs did not use the same corpus plan/reference inputs/options");
  const probes = loadProbes(root, spec);
  const rows = joinEvidence(runs);
  const ledger = rows.map((row) => classify(row, spec.runs));
  const reference = runs[0]!;
  const fixed = read<string[]>(join(REPO_ROOT, "config/official-baseline-cases-ts71.json"));
  const selected = selectCases(ledger, spec.budgets, new Set(fixed));
  const countBuckets = (items: Classified[]) => Object.fromEntries([...buckets, "unclassified"].map((b) =>
    [b, items.filter((r) => (r.bucket ?? "unclassified") === b).length]));
  const fixedSources = new Set(fixed);
  const fixedOverlap = (items: Classified[]) => countBuckets(items.filter((r) => fixedSources.has(r.source)));
  const familyVersionDivergence = [...new Set(spec.runs.map((r) => r.family))].flatMap((family) => {
    const versions = spec.runs.filter((r) => r.family === family).map((r) => r.candidate).sort(order);
    if (versions.length < 2) return [];
    const differs = (row: Joined) => versions.some((v) => !equal(row.observations[v], row.observations[versions[0]!]));
    return [{ family, candidates: versions, differingRecords: rows.filter(differs).length, selectedDifferingRecords: selected.filter(differs).length }];
  });
  const perCandidate = Object.fromEntries(spec.runs.map(({ candidate }) => [candidate,
    coverage(selected.map((row) => row.observations[candidate]!))]));
  const out = resolve(output);
  mkdirSync(out, { recursive: true });
  write(join(out, "cases.json"), selected.map((r) => r.source).sort(order));
  write(join(out, "evidence.json"), { schemaVersion: 1, suite: spec.suite, corpus: spec.corpus, baseline: spec.baseline, budgets: spec.budgets,
    inventory: { records: rows.length, sourceFiles: new Set(rows.map((r) => r.source)).size, buckets: countBuckets(ledger),
      fixed120OverlapByBucket: fixedOverlap(ledger) }, selected: { records: selected.length, buckets: countBuckets(selected),
      fixed120OverlapByBucket: fixedOverlap(selected), perCandidate }, familyVersionDivergence,
    reference: { source: "official-baseline", tool: reference.referenceTool, baseArgs: reference.referenceArgs },
    runs: runs.map((r) => r.evidence), cases: selected.map(({ observations, ...row }) => ({ ...row, observations: Object.fromEntries(
      Object.entries(observations).map(([name, o]) => [name, o.status === "skip" ? o : {
        status: o.status, expected: o.reference.length, actual: o.actual.length, hits: o.hits, extra: codes(o.extra),
        missing: codes(o.missing), moved: codes(o.moved), diagnosticPointsSha256: digest([o.reference, o.actual]),
      }]),
    ) })), supplemental: probes });
  // Compact, streaming-friendly ledger: one configured record with observations per line, including omissions and skips.
  writeFileSync(join(out, "ledger.jsonl"), ledger.map(json).join("\n") + "\n");
  console.log(`${spec.suite}: selected ${selected.length}/${rows.length} configured records + ${probes.probes.length} separate probes`);
}

if (import.meta.main) main();
