// Public allowlist, exact evaluation identity, and compact static report generation.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { baseline, aggregate, buildPlan, buildPlanForIds, runShard, verifyShard, verifyVersion, type Candidate, type Plan } from "./full-compatibility.ts";
import { corpusRefOf, findBaseline, loadBaselines, REPO_ROOT, resolveBaselineTsc } from "../src/baselines.ts";
import type { CaseRecord, Metrics, ToolIdentity } from "../src/compare.ts";
import { isValidCaseId, loadManifest } from "../src/discover.ts";
import { identifyTool, sha256 } from "../src/provenance.ts";
import { addedCandidate, addedCandidates, inspectDistribution, isAddedCandidate, prepareDistribution, probeDistribution, validPrepared, type PreparedEvidence } from "./public-evaluation-tools.ts";
import { distributionSha256, shardInputEvidence, verifyCorpus, type ShardInputEvidence } from "./public-evaluation-inputs.ts";

const legacyCandidates = {
  typescript: { id: "typescript", name: "TypeScript", version: "7.1.0-beta" },
  "bun-1.4.4": { id: "bun", name: "Bun", version: "1.4.4" },
  "bun-1.4.5": { id: "bun", name: "Bun", version: "1.4.5" },
  tsrs: { id: "tsrs", name: "tsrs", version: "0.25.0-ts7.1.0-beta" },
} as const;
const candidates = { ...legacyCandidates, "ts-rust": addedCandidate("ts-rust"), "tsc-rs": addedCandidate("tsc-rs"), tsz: addedCandidate("tsz") } satisfies Record<Candidate, { id: string; name: string; version: string }>;
const suites = {
  "fixed-120": { id: "fixed-120", label: "固定诊断样本（120 例）" },
  full: { id: "full", label: "全量类型检查测试集（compiler / conformance）" },
} as const;
const manifest = "config/official-baseline-cases-ts71.json";
const reference = { id: baseline, label: "TypeScript 7.1.0-beta 官方 .errors.txt" };
const expectedRepository = "microsoft/TypeScript";
const source = "official-baseline" as const;
const configuration = () => {
  const config = loadBaselines();
  const definition = findBaseline(config, baseline);
  const { repo, ref } = config.corpora[definition.corpus]!;
  if (repo !== expectedRepository || !/^[a-f0-9]{40}$/.test(ref)) throw new Error("Public evaluation requires a pinned official corpus");
  return { definition, config, repo, ref };
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (path: string, value: unknown) => writeFileSync(path, json(value));
const hash = (value: unknown) => sha256(JSON.stringify(value));
const isHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const runUrlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/[0-9]+$/;
type WorkflowRun = { number: number; attempt: number };
const output = (value: Record<string, string>) => {
  const text = Object.entries(value).map(([key, item]) => `${key}=${item}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else console.log(text.trim());
};
const asCandidate = (s: string): Candidate => {
  if (!Object.hasOwn(candidates, s)) throw new Error(`Not a public candidate: ${s}`);
  return s as Candidate;
};
const asSuite = (s: string): keyof typeof suites => {
  if (!Object.hasOwn(suites, s)) throw new Error(`Not a public suite: ${s}`);
  return s as keyof typeof suites;
};
const command = (program: string, args: string[]): string => {
  const child = spawnSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], cwd: REPO_ROOT });
  if (child.status !== 0) throw new Error(`${program} failed: ${child.error ?? child.status}`);
  return child.stdout.trim();
};

export function semanticFingerprint(root = REPO_ROOT): string {
  const files = [manifest, "config/baselines.json", "config/implementations.json", "package.json", "bun.lock",
    "scripts/full-compatibility.ts", "scripts/public-evaluation.ts", "scripts/public-evaluation-inputs.ts", "scripts/public-evaluation-tools.ts", "scripts/install-impl.ts", ".npmrc", ".github/workflows/public-evaluation.yml"];
  const list = (dir: string) => {
    for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) list(path);
      else if (item.isFile() && !/\.(?:md|markdown)$/i.test(item.name) && !/^readme(?:\.|$)/i.test(item.name)) files.push(path);
    }
  };
  list("src");
  return hash(files.sort().map((path) => [path, sha256(readFileSync(join(root, path)))]));
}

const supportsSuite = (candidate: Candidate, suite: keyof typeof suites) => !isAddedCandidate(candidate) || suite === "full";
const legacyCatalog = () => ({ schemaVersion: 1, combinations: Object.values(legacyCandidates).flatMap((candidate) =>
  Object.values(suites).map((suite) => ({ candidate, reference, suite }))) });
export function publicCatalog() {
  return { schemaVersion: 1, combinations: [...legacyCatalog().combinations,
    ...addedCandidates.map((id) => ({ candidate: candidates[id], reference, suite: suites.full }))] };
}

// Store no local paths in public provenance. A wrapper-only fingerprint is not
// sufficient for npm TS7 or tsrs; identifyTool resolves their platform binaries.
function toolEvidence(tool: ToolIdentity | null | undefined) {
  if (!tool || !isHash(tool.sha256) || typeof tool.version !== "string") throw new Error("Missing executable fingerprint");
  return { version: tool.version, sha256: tool.sha256!, nativeSha256: tool.native?.sha256 ?? null, embeddedTypeScript: tool.embeddedTypeScript ?? null };
}

type Tools = {
  bin: string; reference: ReturnType<typeof toolEvidence>; candidate: ReturnType<typeof toolEvidence>;
  distributions: { reference: string; candidate: string | null };
} & ({ prepared: PreparedEvidence; cliArgs: string[] } | { prepared?: undefined; cliArgs?: undefined });

function installTools(candidate: Candidate, dest: string, requestDir: string, request?: Request): Tools {
  // Never use local or environment-selected binaries in the public workflow.
  for (const key of Object.keys(process.env)) {
    if (/^(?:TSRS_|TSGO_|TSZ_|TS_RUST_|TSC_RS_|TYPESCRIPT_|TSC_COMPA_|LD_|DYLD_)/.test(key) || ["TSC_BIN", "BUN_CHECK_BIN", "NODE_OPTIONS", "NODE_PATH", "RUST_MIN_STACK", "RAYON_NUM_THREADS"].includes(key)) delete process.env[key];
  }
  const wrapper = resolveBaselineTsc(configuration().definition);
  const tsc = identifyTool(wrapper, "7.1.0-beta")?.native?.path;
  if (!tsc) throw new Error("Official TS7 native executable was not resolved");
  verifyVersion("typescript", tsc);
  const officialDist = distributionSha256([dirname(dirname(tsc))]);
  const referenceTool = toolEvidence(identifyTool(tsc, "7.1.0-beta"));
  if (isAddedCandidate(candidate)) {
    const dir = resolve(requestDir, "compiler");
    if (request && (request.version !== 3 || !validPrepared(candidate, request.prepared, request.options.candidateEnvArgs) || !request.distributions.candidate)) {
      throw new Error("Invalid prepared compiler request");
    }
    const preparedRequest = request?.version === 3 ? request : undefined;
    const origin = preparedRequest ? preparedRequest.prepared.source : prepareDistribution(candidate, dir);
    const compiler = inspectDistribution(candidate, dir, origin, preparedRequest && {
      executable: preparedRequest.candidateTool.sha256, distribution: preparedRequest.distributions.candidate!,
      runtimeLibrariesSha256: preparedRequest.prepared.runtimeLibrariesSha256,
    });
    probeDistribution(candidate, compiler);
    return { bin: compiler.bin, reference: referenceTool, candidate: toolEvidence(identifyTool(compiler.bin)),
      distributions: { reference: officialDist, candidate: compiler.distribution }, prepared: compiler.prepared, cliArgs: compiler.cliArgs };
  }
  const isBun = candidate.startsWith("bun-");
  const bin = candidate === "typescript" ? tsc : command(process.execPath, ["scripts/install-impl.ts", "--name",
    isBun ? `bun-check-${candidates[candidate].version}` : "tsrs", "--source", isBun ? "release" : "npm", "--dest", dest]).split(/\r?\n/).at(-1)!;
  if (candidate !== "typescript") verifyVersion(candidate, bin);
  const tsrs = candidate === "tsrs" ? identifyTool(bin) : null;
  if (candidate === "tsrs" && !tsrs?.native?.path) throw new Error("tsrs native executable was not resolved");
  const effectiveBin = tsrs?.native?.path ?? bin;
  const candidateDist = tsrs?.native?.path ? distributionSha256([dirname(tsrs.native.path)]) : isBun ? null : officialDist;
  const candidateTool = identifyTool(effectiveBin);
  if (isBun && candidateTool) {
    const exact = JSON.parse(command(bin, ["-p", "JSON.stringify([Bun.version, Bun.revision, process.versions.typescript, process.execPath])"]));
    if (exact[0] !== candidates[candidate].version || typeof exact[2] !== "string" || exact[3] !== candidateTool.path) {
      throw new Error("Bun candidate is not the expected standalone binary");
    }
    candidateTool.version = `Bun ${exact[0]} (${exact[1]})`;
    candidateTool.embeddedTypeScript = exact[2];
  }
  return { bin: effectiveBin, reference: referenceTool, candidate: toolEvidence(candidateTool),
    distributions: { reference: officialDist, candidate: candidateDist } };
}

const planCounts = (plan: Plan) => ({
  shards: plan.shards.length,
  sourceFiles: plan.shards.reduce((n, shard) => n + shard.units.length, 0),
  records: plan.shards.reduce((n, shard) => n + shard.units.reduce((m, unit) => m + unit.records.length, 0), 0),
});

function makeRequest(plan: Plan, suiteId: keyof typeof suites, tools: Tools, inputs: ShardInputEvidence[]) {
  const candidate = plan.candidates[0]!;
  const { definition } = configuration();
  const common = {
    candidate, candidateVersion: candidates[candidate].version, reference: baseline, source,
    suite: suiteId, corpus: plan.corpusRef, planSha256: hash(plan), planCounts: planCounts(plan),
    manifestSha256: suiteId === "fixed-120" ? sha256(readFileSync(join(REPO_ROOT, manifest))) : null,
    harnessSha256: semanticFingerprint(), runner: `Bun ${Bun.version} (${Bun.revision})`,
    platform: `${process.platform}/${process.arch}`, runnerImage: process.env.ImageOS ?? "local",
    node: command("node", ["--version"]), locale: process.env.LC_ALL ?? null, timezone: process.env.TZ ?? null,
    adapter: candidate.startsWith("bun-") ? "bun-check" : "tsc-cli",
    options: { mode: "official", strategy: "aligned", referenceBaseArgs: definition.baseArgs },
    referenceTool: tools.reference, candidateTool: tools.candidate, distributions: tools.distributions, inputs,
  } as const;
  return tools.prepared
    ? { ...common, version: 3 as const, options: { ...common.options, candidateEnvArgs: tools.cliArgs }, prepared: tools.prepared }
    : { version: 2 as const, ...common };
}
export type Request = ReturnType<typeof makeRequest>;

export function verifyRunIdentity(request: Request, tools: Metrics["meta"]["tools"], options: Metrics["meta"]["options"], mode: Metrics["meta"]["mode"]) {
  if (request.runner !== tools?.runner || request.platform !== tools.platform ||
      hash(request.referenceTool) !== hash(toolEvidence(tools.reference)) ||
      hash(request.candidateTool) !== hash(toolEvidence(tools.candidate)) ||
      options?.strategy !== request.options.strategy || mode !== request.options.mode ||
      hash(options.referenceBaseArgs) !== hash(request.options.referenceBaseArgs) ||
      hash(options.candidateArgs) !== hash(request.options.referenceBaseArgs) ||
      hash(options.candidateEnvArgs) !== hash(request.version === 3 ? request.options.candidateEnvArgs : []) ||
      [options.sharedArgs, options.onlyClasses, options.excludeClasses].some((list) => !Array.isArray(list) || list.length !== 0)) {
    throw new Error("Shard execution identity does not match the public request");
  }
}

export function verifyShardInputs(request: Request, shard: string, manifest: { parsedInputsSha256?: string; officialInputsSha256?: string } | undefined) {
  const expected = request.inputs.find((item) => item.shard === shard);
  if (!expected || !manifest || expected.parsedInputsSha256 !== manifest.parsedInputsSha256 || expected.officialInputsSha256 !== manifest.officialInputsSha256) {
    throw new Error(`Shard ${shard} input evidence does not match the public request`);
  }
  return expected;
}

export function shardReceipt(request: Request, id: string, shard: string) {
  return { id, shard, ...(request.version === 3 && {
    candidateDistributionSha256: request.distributions.candidate, runtimeLibrariesSha256: request.prepared.runtimeLibrariesSha256,
    candidateEnvironment: request.prepared.environment,
  }) };
}

const noDifferences = (r: CaseRecord) => r.fp.length === 0 && r.missed.length === 0 && r.misanchor === 0;
export function makeReport(request: Request, plan: Plan, root: string, runUrl: string, generatedAt = new Date().toISOString(), workflowRun?: WorkflowRun) {
  if (!runUrlPattern.test(runUrl) || !Number.isFinite(Date.parse(generatedAt)) || request.planSha256 !== hash(plan) ||
      hash(request.planCounts) !== hash(planCounts(plan)) || plan.candidates.length !== 1 || request.candidate !== plan.candidates[0] || plan.source !== source || request.corpus !== plan.corpusRef) {
    throw new Error("Invalid public evaluation plan or run provenance");
  }
  const summary = aggregate(plan, root);
  if (!summary.complete) throw new Error(`Evaluation incomplete; no public entry created:\n${summary.issues.join("\n")}`);
  const row = summary.candidates[0]!;
  const { sourceFiles, records, ran, skipped, coverage, hits, expected, fp, missed, misanchor, compatibility, strict } = row;
  const id = hash(request);
  const differences: { id: string; extra: number; missed: number; misanchor: number }[] = [];
  const evidence = [];
  for (const shard of plan.shards) {
    const dir = join(root, `full-${request.candidate}-${shard.id}`);
    const receipt = readJson<unknown>(join(dir, "public-request.json"));
    if (hash(receipt) !== hash(shardReceipt(request, id, shard.id))) throw new Error(`Shard ${shard.id} execution is not bound to this public request`);
    const metrics = verifyShard(plan, shard, dir, request.candidate);
    verifyRunIdentity(request, metrics.meta.tools, metrics.meta.options, metrics.meta.mode);
    evidence.push(verifyShardInputs(request, shard.id, metrics.meta.manifest));
    for (const record of readJson<CaseRecord[]>(join(dir, "details.json"))) {
      if (differences.length >= 8) break;
      if (record.status !== "ran" || noDifferences(record)) continue;
      differences.push({ id: record.id, extra: record.fp.length, missed: record.missed.length, misanchor: record.misanchor });
    }
  }
  return { schemaVersion: 1, id, request, candidate: candidates[request.candidate], reference, suite: suites[request.suite],
    generatedAt, reportPath: `reports/${id}.html`, runUrl, ...(workflowRun && { workflowRun }),
    summary: { complete: true, shards: summary.shards, sourceFiles, records, ran, skipped, coverage, hits, expected, fp, missed, misanchor,
      compatibility, strict }, evidence, differences };
}
export type Report = ReturnType<typeof makeReport>;
type IndexEntry = Pick<Report, "id" | "candidate" | "reference" | "suite" | "generatedAt" | "reportPath" | "runUrl" | "summary">;
const indexEntry = ({ id, candidate, reference, suite, generatedAt, reportPath, runUrl, summary }: Report): IndexEntry =>
  ({ id, candidate, reference, suite, generatedAt, reportPath, runUrl, summary });

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function preparedHtml(tool: PreparedEvidence, request: Extract<Request, { version: 3 }>): string {
  const origin = tool.source;
  const recorded = origin.kind === "npm" ? `npm ${origin.package}@${origin.version} (${origin.platformPackage}, npm gitHead ${origin.sourceCommit})`
    : `Cargo · ${origin.repository}@${origin.commit} · ${origin.rustc}`;
  return `
<li>候选来源：<code>${escapeHtml(recorded)}</code></li><li>CLI 自报版本：<code>${escapeHtml(request.candidateTool.version)}</code></li>
<li>发行目录 SHA-256：<code>${request.distributions.candidate}</code></li><li>动态库 SHA-256 清单摘要：<code>${tool.runtimeLibrariesSha256}</code></li>`;
}

export function reportHtml(r: Report): string {
  const { candidate, reference, suite, summary: s, request } = r;
  const verdict = (v: typeof s.compatibility) => `${v.pass} / ${v.fail} / ${v.unknown}`;
  const title = escapeHtml(`${candidate.name} ${candidate.version} · ${suite.label}`);
  return `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>${title} · tsc-compa</title></head>
<body><main><p><a href="../">返回报告目录</a></p><h1>${title}</h1>
<p>对照：${escapeHtml(reference.label)}。生成时间：${escapeHtml(r.generatedAt)}。</p>
<h2>比较结果</h2>
<ul><li>运行完整性：${s.shards} 个分片已核对。计划 ${s.sourceFiles} 个源文件、${s.records} 条配置记录；完成 ${s.ran}，跳过 ${s.skipped}。</li>
<li>兼容（通过 / 失败 / 未确认）：${verdict(s.compatibility)}。</li><li>严格一致（通过 / 失败 / 未确认）：${verdict(s.strict)}。</li>
<li>诊断命中：${s.hits} / ${s.expected}（${s.coverage === null ? "无期望诊断" : `${(s.coverage * 100).toFixed(2)}%`}）；多报 ${s.fp}，漏报 ${s.missed}，错锚 ${s.misanchor}。</li></ul>
<p>${suite.id === "fixed-120" ? "本测试集是固定诊断样本，不代表全量覆盖。" : "分片齐全不代表每条配置都能比较；诊断命中率只按实际比较的记录计算。"}</p>
${r.differences.length ? `<h2>差异示例（最多 8 条）</h2><ul>${r.differences.map((d) => `<li><code>${escapeHtml(d.id)}</code>：多报 ${d.extra}，漏报 ${d.missed}，错锚 ${d.misanchor}</li>`).join("")}</ul>` : ""}
<h2>运行条件与证据</h2><ul><li>语料：<code>${escapeHtml(request.corpus)}</code></li><li>适配器：<code>${escapeHtml(request.adapter)}</code></li>
<li>候选可执行文件 SHA-256：<code>${escapeHtml(request.candidateTool.nativeSha256 ?? request.candidateTool.sha256)}</code></li>${request.version === 3 ? preparedHtml(request.prepared, request) : ""}
<li>测试集计划 SHA-256：<code>${escapeHtml(request.planSha256)}</code></li><li>执行器 SHA-256：<code>${escapeHtml(request.harnessSha256)}</code></li></ul>
<p><a href="${r.id}.json">精简 JSON</a> · <a href="${escapeHtml(r.runUrl)}">GitHub Actions 运行（原始产物有保留期限）</a>${r.workflowRun ? ` · 运行编号 ${r.workflowRun.number}，第 ${r.workflowRun.attempt} 次尝试` : ""}</p>
</main></body></html>\n`;
}

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value: unknown, keys: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const expected = keys.split(" ");
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};
const isString = (value: unknown) => typeof value === "string";
const validWorkflowRun = (run: WorkflowRun) => exactKeys(run, "number attempt") &&
  [run.number, run.attempt].every((n) => count(n) && n > 0);
const digestOrNull = (value: unknown) => value === null || isHash(value);
const isDate = (value: unknown) => isString(value) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const validCounts = (s: Request["planCounts"]) => exactKeys(s, "shards sourceFiles records") && [s.shards, s.sourceFiles, s.records].every(count);
function validSummary(s: Report["summary"]) {
  if (!exactKeys(s, "complete shards sourceFiles records ran skipped coverage hits expected fp missed misanchor compatibility strict") ||
      s.complete !== true || ![s.shards, s.sourceFiles, s.records, s.ran, s.skipped, s.hits, s.expected, s.fp, s.missed, s.misanchor].every(count)) return false;
  return s.shards > 0 && s.ran > 0 && s.sourceFiles > 0 && s.records >= s.sourceFiles && s.ran + s.skipped === s.records && s.hits <= s.expected &&
    s.coverage === (s.expected === 0 ? null : s.hits / s.expected) && [s.compatibility, s.strict].every((v) =>
      exactKeys(v, "pass fail unknown") && [v.pass, v.fail, v.unknown].every(count) && v.pass + v.fail + v.unknown === s.ran);
}
const validTool = (t: Request["candidateTool"]) => exactKeys(t, "version sha256 nativeSha256 embeddedTypeScript") &&
  isString(t.version) && t.version.length <= 150 && isHash(t.sha256) && digestOrNull(t.nativeSha256) &&
  (t.embeddedTypeScript === null || (isString(t.embeddedTypeScript) && /^[\w.-]{1,32}$/.test(t.embeddedTypeScript)));
const validInputEvidence = (e: ShardInputEvidence) => exactKeys(e, "shard parsedInputsSha256 officialInputsSha256") &&
  isString(e.shard) && /^\d{2}$/.test(e.shard) && isHash(e.parsedInputsSha256) && isHash(e.officialInputsSha256);
const sameCombination = (row: IndexEntry, candidate: IndexEntry["candidate"], ref: IndexEntry["reference"], suite: IndexEntry["suite"]) =>
  exactKeys(row.candidate, "id name version") && row.candidate.id === candidate.id && row.candidate.name === candidate.name && row.candidate.version === candidate.version &&
  exactKeys(row.reference, "id label") && row.reference.id === ref.id && row.reference.label === ref.label &&
  exactKeys(row.suite, "id label") && row.suite.id === suite.id && row.suite.label === suite.label;
const validEntry = (entry: IndexEntry) => exactKeys(entry, "id candidate reference suite generatedAt reportPath runUrl summary") &&
  isHash(entry.id) && entry.reportPath === `reports/${entry.id}.html` && isString(entry.runUrl) && runUrlPattern.test(entry.runUrl) &&
  isDate(entry.generatedAt) && validSummary(entry.summary) &&
  publicCatalog().combinations.some(({ candidate, reference, suite }) => sameCombination(entry, candidate, reference, suite));

export function readIndex(data: string): { schemaVersion: 1; reports: IndexEntry[] } {
  const path = join(data, "reports/index.json");
  if (lstatSync(join(data, "reports"), { throwIfNoEntry: false })?.isSymbolicLink() ||
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Invalid public data symlink");
  if (!existsSync(path)) return { schemaVersion: 1, reports: [] };
  const index = readJson<ReturnType<typeof readIndex>>(path);
  if (!exactKeys(index, "schemaVersion reports") || index.schemaVersion !== 1 || !Array.isArray(index.reports) ||
      new Set(index.reports.map((r) => r?.id)).size !== index.reports.length) {
    throw new Error("Invalid public index; refusing to discard history");
  }
  return index;
}

// A strict public allowlist, not a type assertion on untrusted JSON. No
// report, index row or child object may smuggle raw data into the public branch.
export function verifyReport(value: unknown, id: string): asserts value is Report {
  const r = value as Report;
  const q = r?.request;
  const prepared = q?.version === 3;
  const hasWorkflowRun = r != null && Object.hasOwn(r, "workflowRun");
  if (!exactKeys(r, `schemaVersion id request candidate reference suite generatedAt reportPath runUrl summary evidence differences${hasWorkflowRun ? " workflowRun" : ""}`) ||
      (hasWorkflowRun && !validWorkflowRun(r.workflowRun!)) ||
      r.schemaVersion !== 1 || r.id !== id || !validEntry(indexEntry(r)) ||
      !exactKeys(q, `version candidate candidateVersion reference source suite corpus planSha256 planCounts manifestSha256 harnessSha256 runner platform runnerImage node locale timezone adapter options referenceTool candidateTool distributions inputs${prepared ? " prepared" : ""}`) ||
      (q.version !== 2 && q.version !== 3) || !isString(q.candidate) || !Object.hasOwn(candidates, q.candidate) ||
      prepared !== isAddedCandidate(q.candidate) || q.candidateVersion !== r.candidate.version ||
      q.source !== source || q.reference !== baseline || q.suite !== r.suite.id || !sameCombination(indexEntry(r), candidates[q.candidate], reference, suites[q.suite]) ||
      !isString(q.corpus) || !/^microsoft\/TypeScript@[a-f0-9]{40}$/.test(q.corpus) || !isHash(q.planSha256) || !isHash(q.harnessSha256) ||
      !(q.suite === "fixed-120" ? isHash(q.manifestSha256) : q.manifestSha256 === null) ||
      q.adapter !== (q.candidate.startsWith("bun-") ? "bun-check" : "tsc-cli") ||
      ![q.runner, q.platform, q.runnerImage, q.node].every((v) => isString(v) && /^[\w ()./+-]{1,120}$/.test(v)) ||
      ![q.locale, q.timezone].every((v) => v === null || (isString(v) && /^[\w.+-]{1,64}$/.test(v))) ||
      !exactKeys(q.options, `mode strategy referenceBaseArgs${prepared ? " candidateEnvArgs" : ""}`) || q.options.mode !== "official" || q.options.strategy !== "aligned" ||
      !Array.isArray(q.options.referenceBaseArgs) || !q.options.referenceBaseArgs.every((v) => isString(v) && /^[\w.+-]{1,80}$/.test(v)) ||
      !validTool(q.candidateTool) || !validTool(q.referenceTool) ||
      (q.version === 3 && (!isAddedCandidate(q.candidate) || q.platform !== "linux/x64" || q.runnerImage !== "ubuntu24" ||
        q.candidateTool.version !== (q.candidate === "tsz" ? "Version 7.0.2" : "Version 7.1.0-dev") ||
        !validPrepared(q.candidate, q.prepared, q.options.candidateEnvArgs))) ||
      !exactKeys(q.distributions, "reference candidate") || !isHash(q.distributions.reference) ||
      !(q.candidate.startsWith("bun-") ? q.distributions.candidate === null : isHash(q.distributions.candidate)) ||
      !validCounts(q.planCounts) || q.planCounts.shards !== r.summary.shards ||
      q.planCounts.records !== r.summary.records || q.planCounts.sourceFiles !== r.summary.sourceFiles ||
      !Array.isArray(q.inputs) || q.inputs.length !== r.summary.shards || !q.inputs.every(validInputEvidence) ||
      new Set(q.inputs.map((e) => e.shard)).size !== q.inputs.length || !Array.isArray(r.evidence) || !r.evidence.every(validInputEvidence) ||
      hash(q.inputs) !== hash(r.evidence) || !Array.isArray(r.differences) || r.differences.length > 8 ||
      !r.differences.every((d) => exactKeys(d, "id extra missed misanchor") && isString(d.id) && isValidCaseId(d.id) &&
        [d.extra, d.missed, d.misanchor].every(count)) || hash(q) !== id) {
    throw new Error("Invalid or incomplete public report");
  }
}

function validCatalog(data: string): boolean {
  const path = join(data, "reports/catalog.json");
  try {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
    const digest = hash(readJson<unknown>(path));
    // Older deployments have exactly the original eight entries. Accept
    // that known catalog without accepting arbitrary subsets or new fields.
    return digest === hash(publicCatalog()) || digest === hash(legacyCatalog());
  }
  catch { return false; }
}

export function verifyPublic(data: string) {
  const dir = join(data, "reports");
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || !validCatalog(data) || !lstatSync(join(dir, "index.json"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Missing or invalid public catalog or index");
  }
  const index = readIndex(data);
  const files = new Set(["catalog.json", "index.json"]);
  for (const entry of index.reports) {
    if (!cachedEntry(data, entry)) throw new Error(`Invalid public report entry: ${entry?.id}`);
    files.add(`${entry.id}.json`);
    files.add(`${entry.id}.html`);
  }
  if (readdirSync(dir).some((file) => !files.has(file))) throw new Error("Unexpected file in public report data");
}

function cachedEntry(data: string, row: IndexEntry): boolean {
  if (!validEntry(row)) return false;
  const { id } = row;
  if (![`${id}.json`, `${id}.html`].every((name) => lstatSync(join(data, "reports", name), { throwIfNoEntry: false })?.isFile())) return false;
  const report = readJson<unknown>(join(data, `reports/${id}.json`));
  verifyReport(report, id);
  return hash(row) === hash(indexEntry(report)) && readFileSync(join(data, row.reportPath), "utf8") === reportHtml(report);
}

export function cached(data: string, id: string): boolean {
  if (!isHash(id)) throw new Error("Invalid public evaluation ID");
  try {
    if (!validCatalog(data)) return false;
    const row = readIndex(data).reports.find((item) => item?.id === id);
    return row !== undefined && cachedEntry(data, row);
  } catch (error) {
    // An absent, obsolete or partial cached report must never skip execution.
    console.warn(`Ignoring invalid cached evidence for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function planExecution(data: string, id: string, force = false) {
  const cacheHit = cached(data, id);
  return { cacheHit, shouldRun: force || !cacheHit };
}

export function saveReport(data: string, bundle: string, id: string, force = false) {
  if (!isHash(id)) throw new Error("Invalid public evaluation ID");
  // Revalidate and reconstruct the only two files we copy from the trusted job.
  const report = readJson<unknown>(join(bundle, `${id}.json`));
  verifyReport(report, id);
  if (force && !report.workflowRun) throw new Error("Forced refresh requires workflow run order");
  const index = readIndex(data);
  const dir = join(data, "reports");
  for (const file of ["catalog.json", `${id}.json`, `${id}.html`]) {
    const path = lstatSync(join(dir, file), { throwIfNoEntry: false });
    if (path && !path.isFile()) throw new Error(`Invalid public data path: ${file}`);
  }
  const hit = cached(data, id);
  if (hit) {
    verifyPublic(data);
    if (!force) return "already-stored";
    const stored = readJson<Report>(join(dir, `${id}.json`)).workflowRun;
    if (!stored) throw new Error("Cannot refresh stored evidence without workflow run order");
    // Compare workflow dispatch order first: an older dispatch can finish, or
    // be re-run, after a newer one. Report generation time cannot order them.
    const incoming = report.workflowRun!;
    const order = incoming.number - stored.number || incoming.attempt - stored.attempt;
    if (order <= 0) return order === 0 ? "already-stored" : "superseded";
  }
  const previous = index.reports.filter((row) => row?.id !== id);
  if (!previous.every(validEntry)) throw new Error("Malformed previous index entry; refusing to discard history");
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${id}.json`), report);
  writeFileSync(join(dir, `${id}.html`), reportHtml(report));
  writeJson(join(dir, "index.json"), { schemaVersion: 1, reports: [indexEntry(report), ...previous].sort((a, b) =>
    b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id)) });
  writeJson(join(data, "reports/catalog.json"), publicCatalog());
  verifyPublic(data);
  return hit ? "refreshed" : "stored";
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "pin" && args.length === 0) {
    const { repo, ref } = configuration();
    output({ repo, ref });
  } else if (cmd === "plan" && (args.length === 6 || (args.length === 7 && args[6] === "--force"))) {
    const [candidateArg, suiteArg, checkout, dest, dir, data, force] = args as [string, string, string, string, string, string, "--force"?];
    const candidate = asCandidate(candidateArg);
    const suite = asSuite(suiteArg);
    if (!supportsSuite(candidate, suite)) throw new Error(`${candidate} is only selectable with the full suite`);
    const { config, definition, ref } = configuration();
    const corpus = verifyCorpus(checkout, ref);
    const corpusRef = corpusRefOf(config, definition)!;
    const ids = suite === "fixed-120" ? loadManifest(join(REPO_ROOT, manifest)) : null;
    if (ids && ids.length !== 120) throw new Error("The fixed 120 sample must have exactly 120 source files");
    const plan = ids === null ? buildPlan(corpus, corpusRef, 8, source, [candidate]) : buildPlanForIds(corpus, corpusRef, 1, source, [candidate], ids);
    const inputs = plan.shards.map((shard) => shardInputEvidence(corpus, shard.id, shard.units.map((unit) => unit.id)));
    const request = makeRequest(plan, suite, installTools(candidate, resolve(dest), dir), inputs);
    const id = hash(request);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "request.json"), request);
    writeJson(join(dir, "plan.json"), plan);
    const { cacheHit, shouldRun } = planExecution(data, id, force === "--force");
    output({ id, "cache-hit": String(cacheHit), "should-run": String(shouldRun), matrix: JSON.stringify({ shard: plan.shards.map((shard) => shard.id) }) });
  } else if (cmd === "run" && args.length === 6) {
    const [dir, id, shardId, checkout, dest, out] = args as [string, string, string, string, string, string];
    const plan = readJson<Plan>(join(dir, "plan.json"));
    const request = readJson<Request>(join(dir, "request.json"));
    const shard = plan.shards.find((item) => item.id === shardId);
    if (!shard || hash(request) !== id || plan.candidates.length !== 1 || request.planSha256 !== hash(plan)) throw new Error("Invalid evaluation shard request");
    const tools = installTools(asCandidate(request.candidate), resolve(dest), dir, request);
    const corpus = verifyCorpus(checkout, configuration().ref);
    if (hash(makeRequest(plan, asSuite(request.suite), tools, request.inputs)) !== id) throw new Error("Evaluation inputs changed after planning");
    verifyShardInputs(request, shard.id, shardInputEvidence(corpus, shard.id, shard.units.map((unit) => unit.id)));
    runShard(plan, shard, request.candidate, corpus, resolve(out), tools.bin, tools.cliArgs, tools.prepared?.environment);
    if (request.version === 3 && isAddedCandidate(request.candidate)) {
      inspectDistribution(request.candidate, join(dir, "compiler"), request.prepared.source, {
        executable: request.candidateTool.sha256, distribution: request.distributions.candidate!, runtimeLibrariesSha256: request.prepared.runtimeLibrariesSha256,
      });
    }
    const metrics = verifyShard(plan, shard, out, request.candidate);
    verifyRunIdentity(request, metrics.meta.tools, metrics.meta.options, metrics.meta.mode);
    verifyShardInputs(request, shard.id, metrics.meta.manifest);
    if (metrics.meta.executionFailures!.length) throw new Error(`${metrics.meta.executionFailures!.length} execution failures; see shard artifact`);
    writeJson(join(out, "public-request.json"), shardReceipt(request, id, shard.id));
  } else if (cmd === "report" && (args.length === 5 || args.length === 7)) {
    const [dir, id, root, bundle, runUrl, runNumber, runAttempt] = args as [string, string, string, string, string, string?, string?];
    const request = readJson<Request>(join(dir, "request.json"));
    if (hash(request) !== id) throw new Error("Evaluation request identity changed");
    const workflowRun = runNumber === undefined ? undefined : { number: Number(runNumber), attempt: Number(runAttempt) };
    const report = makeReport(request, readJson<Plan>(join(dir, "plan.json")), root, runUrl, undefined, workflowRun);
    verifyReport(report, id);
    mkdirSync(bundle, { recursive: true });
    writeJson(join(bundle, `${id}.json`), report);
    writeFileSync(join(bundle, `${id}.html`), reportHtml(report));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Public evaluation · complete\n\n- Request: \`${id}\`\n- Compared: ${report.summary.ran}/${report.summary.records}; skipped: ${report.summary.skipped}\n`);
  } else if (cmd === "save" && (args.length === 3 || (args.length === 4 && args[3] === "--force"))) {
    console.log(saveReport(args[0]!, args[1]!, args[2]!, args[3] === "--force"));
  } else if (cmd === "verify-public" && args.length === 1) {
    verifyPublic(args[0]!);
  } else if (cmd === "verify-cache" && args.length === 2) {
    if (!cached(args[0]!, args[1]!)) throw new Error("Public evaluation cache entry missing or incomplete");
  } else {
    throw new Error("Expected pin | plan <candidate> <suite> <checkout> <tools> <out> <public-data> [--force] | run <plan-dir> <id> <shard> <checkout> <tools> <out> | report <plan-dir> <id> <shard-artifacts> <bundle> <run-url> [<run-number> <run-attempt>] | save <public-data> <bundle> <id> [--force] | verify-cache <public-data> <id> | verify-public <public-data>");
  }
}

if (import.meta.main) main();
