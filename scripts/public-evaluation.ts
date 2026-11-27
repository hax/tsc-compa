// Public allowlist, exact evaluation identity, and compact static report generation.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { baseline, aggregate, buildPlan, buildPlanForIds, runShard, verifyShard, verifyVersion, type Candidate, type Plan } from "./full-compatibility.ts";
import { corpusRefOf, findBaseline, loadBaselines, REPO_ROOT, resolveBaselineTsc } from "../src/baselines.ts";
import type { CaseRecord, Metrics, ToolIdentity } from "../src/compare.ts";
import { loadManifest } from "../src/discover.ts";
import { identifyTool, sha256 } from "../src/provenance.ts";

const candidates = {
  typescript: { id: "typescript", name: "TypeScript", version: "7.1.0-beta" },
  "bun-1.4.4": { id: "bun", name: "Bun", version: "1.4.4" },
  "bun-1.4.5": { id: "bun", name: "Bun", version: "1.4.5" },
  tsrs: { id: "tsrs", name: "tsrs", version: "0.25.0-ts7.1.0-beta" },
} satisfies Record<Candidate, { id: string; name: string; version: string }>;
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
const corpusRoot = (dir: string, ref: string) => {
  const path = resolve(dir);
  if (command("git", ["-C", path, "rev-parse", "HEAD"]) !== ref ||
      command("git", ["-C", path, "status", "--porcelain", "--untracked-files=all", "--", "tsc/testdata/tests/cases", "tsc/testdata/baselines/reference"])) {
    throw new Error("Corpus checkout does not match its clean, pinned commit");
  }
  return join(path, "tsc/testdata/tests/cases");
};

function semanticFingerprint(): string {
  const files = [manifest, "config/baselines.json", "config/implementations.json", "package.json", "bun.lock",
    "scripts/full-compatibility.ts", "scripts/public-evaluation.ts", "scripts/install-impl.ts", ".npmrc", ".github/workflows/public-evaluation.yml"];
  const list = (dir: string) => {
    for (const item of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) list(path);
      else if (item.isFile()) files.push(path);
    }
  };
  list("src");
  return hash(files.sort().map((path) => [path, sha256(readFileSync(join(REPO_ROOT, path)))]));
}

export function publicCatalog() {
  return { schemaVersion: 1, combinations: Object.values(candidates).flatMap((candidate) =>
    Object.values(suites).map((suite) => ({ candidate, reference, suite }))) };
}

// Store no local paths in public provenance. A wrapper-only fingerprint is not
// sufficient for npm TS7 or tsrs; identifyTool resolves their platform binaries.
function toolEvidence(tool: ToolIdentity | null | undefined) {
  if (!tool || !isHash(tool.sha256) || typeof tool.version !== "string") throw new Error("Missing executable fingerprint");
  return { version: tool.version, sha256: tool.sha256!, nativeSha256: tool.native?.sha256 ?? null, embeddedTypeScript: tool.embeddedTypeScript ?? null };
}

function installTools(candidate: Candidate, dest: string) {
  // Never use local or environment-selected binaries in the public workflow.
  delete process.env.TSRS_BINARY;
  const wrapper = resolveBaselineTsc(configuration().definition);
  const tsc = identifyTool(wrapper, "7.1.0-beta")?.native?.path;
  if (!tsc) throw new Error("Official TS7 native executable was not resolved");
  const isBun = candidate.startsWith("bun-");
  const bin = candidate === "typescript" ? tsc : command(process.execPath, ["scripts/install-impl.ts", "--name",
    isBun ? `bun-check-${candidates[candidate].version}` : "tsrs", "--source", isBun ? "release" : "npm", "--dest", dest]).split(/\r?\n/).at(-1)!;
  verifyVersion("typescript", tsc);
  if (candidate !== "typescript") verifyVersion(candidate, bin);
  const candidateTool = identifyTool(bin);
  if (isBun && candidateTool) {
    const exact = JSON.parse(command(bin, ["-p", "JSON.stringify([Bun.version, Bun.revision, process.versions.typescript, process.execPath])"]));
    if (exact[0] !== candidates[candidate].version || typeof exact[2] !== "string" || exact[3] !== candidateTool.path) {
      throw new Error("Bun candidate is not the expected standalone binary");
    }
    candidateTool.version = `Bun ${exact[0]} (${exact[1]})`;
    candidateTool.embeddedTypeScript = exact[2];
  }
  if (candidate === "tsrs" && !isHash(candidateTool?.native?.sha256)) throw new Error("tsrs native executable was not resolved");
  return { bin, reference: toolEvidence(identifyTool(tsc, "7.1.0-beta")), candidate: toolEvidence(candidateTool) };
}

const planCounts = (plan: Plan) => ({
  shards: plan.shards.length,
  sourceFiles: plan.shards.reduce((n, shard) => n + shard.units.length, 0),
  records: plan.shards.reduce((n, shard) => n + shard.units.reduce((m, unit) => m + unit.records.length, 0), 0),
});

function makeRequest(plan: Plan, suiteId: keyof typeof suites, tools: ReturnType<typeof installTools>) {
  const candidate = plan.candidates[0]!;
  const { definition } = configuration();
  return {
    version: 1, candidate, candidateVersion: candidates[candidate].version, reference: baseline, source,
    suite: suiteId, corpus: plan.corpusRef, planSha256: hash(plan), planCounts: planCounts(plan),
    manifestSha256: suiteId === "fixed-120" ? sha256(readFileSync(join(REPO_ROOT, manifest))) : null,
    harnessSha256: semanticFingerprint(), runner: `Bun ${Bun.version} (${Bun.revision})`,
    platform: `${process.platform}/${process.arch}`, runnerImage: process.env.ImageOS ?? "local",
    node: command("node", ["--version"]), locale: process.env.LC_ALL ?? null, timezone: process.env.TZ ?? null,
    adapter: candidate.startsWith("bun-") ? "bun-check" : "tsc-cli",
    options: { mode: "official", strategy: "aligned", referenceBaseArgs: definition.baseArgs },
    referenceTool: tools.reference, candidateTool: tools.candidate,
  } as const;
}
export type Request = ReturnType<typeof makeRequest>;

export function verifyRunIdentity(request: Request, tools: Metrics["meta"]["tools"], options: Metrics["meta"]["options"], mode: Metrics["meta"]["mode"]) {
  if (request.runner !== tools?.runner || request.platform !== tools.platform ||
      hash(request.referenceTool) !== hash(toolEvidence(tools.reference)) ||
      hash(request.candidateTool) !== hash(toolEvidence(tools.candidate)) ||
      options?.strategy !== request.options.strategy || mode !== request.options.mode ||
      hash(options.referenceBaseArgs) !== hash(request.options.referenceBaseArgs) ||
      hash(options.candidateArgs) !== hash(request.options.referenceBaseArgs) ||
      [options.sharedArgs, options.candidateEnvArgs, options.onlyClasses, options.excludeClasses].some((list) => !Array.isArray(list) || list.length !== 0)) {
    throw new Error("Shard execution identity does not match the public request");
  }
}

const noDifferences = (r: CaseRecord) => r.fp.length === 0 && r.missed.length === 0 && r.misanchor === 0;
export function makeReport(request: Request, plan: Plan, root: string, runUrl: string, generatedAt = new Date().toISOString()) {
  if (!runUrlPattern.test(runUrl) || !Number.isFinite(Date.parse(generatedAt)) || request.planSha256 !== hash(plan) ||
      hash(request.planCounts) !== hash(planCounts(plan)) || plan.candidates.length !== 1 || request.candidate !== plan.candidates[0] || plan.source !== source || request.corpus !== plan.corpusRef) {
    throw new Error("Invalid public evaluation plan or run provenance");
  }
  const summary = aggregate(plan, root);
  if (!summary.complete) throw new Error(`Evaluation incomplete; no public entry created:\n${summary.issues.join("\n")}`);
  const row = summary.candidates[0]!;
  const { sourceFiles, records, ran, skipped, coverage, hits, expected, fp, missed, misanchor, compatibility, strict } = row;
  const differences: { id: string; extra: number; missed: number; misanchor: number }[] = [];
  const evidence = [];
  for (const shard of plan.shards) {
    const dir = join(root, `full-${request.candidate}-${shard.id}`);
    const metrics = verifyShard(plan, shard, dir, request.candidate);
    verifyRunIdentity(request, metrics.meta.tools, metrics.meta.options, metrics.meta.mode);
    const { parsedInputsSha256, officialInputsSha256 } = metrics.meta.manifest!;
    if (!isHash(parsedInputsSha256) || !isHash(officialInputsSha256)) throw new Error("Missing shard input evidence");
    evidence.push({ shard: shard.id, parsedInputsSha256, officialInputsSha256 });
    for (const record of readJson<CaseRecord[]>(join(dir, "details.json"))) {
      if (differences.length >= 8) break;
      if (record.status !== "ran" || noDifferences(record)) continue;
      differences.push({ id: record.id, extra: record.fp.length, missed: record.missed.length, misanchor: record.misanchor });
    }
  }
  const id = hash(request);
  return { schemaVersion: 1, id, request, candidate: candidates[request.candidate], reference, suite: suites[request.suite],
    generatedAt, reportPath: `reports/${id}.html`, runUrl,
    summary: { complete: true, shards: summary.shards, sourceFiles, records, ran, skipped, coverage, hits, expected, fp, missed, misanchor,
      compatibility, strict }, evidence, differences };
}
type Report = ReturnType<typeof makeReport>;
type IndexEntry = Pick<Report, "id" | "candidate" | "reference" | "suite" | "generatedAt" | "reportPath" | "runUrl" | "summary">;
const indexEntry = ({ id, candidate, reference, suite, generatedAt, reportPath, runUrl, summary }: Report): IndexEntry =>
  ({ id, candidate, reference, suite, generatedAt, reportPath, runUrl, summary });

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
<li>候选可执行文件 SHA-256：<code>${escapeHtml(request.candidateTool.nativeSha256 ?? request.candidateTool.sha256)}</code></li>
<li>测试集计划 SHA-256：<code>${escapeHtml(request.planSha256)}</code></li><li>执行器 SHA-256：<code>${escapeHtml(request.harnessSha256)}</code></li></ul>
<p><a href="${r.id}.json">精简 JSON</a> · <a href="${escapeHtml(r.runUrl)}">GitHub Actions 运行（原始产物有保留期限）</a></p>
</main></body></html>\n`;
}

const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
function validSummary(s: Report["summary"]) {
  if (!s || s.complete !== true || ![s.shards, s.sourceFiles, s.records, s.ran, s.skipped, s.hits, s.expected, s.fp, s.missed, s.misanchor].every(count)) return false;
  return s.shards > 0 && s.ran > 0 && s.sourceFiles > 0 && s.records >= s.sourceFiles && s.ran + s.skipped === s.records && s.hits <= s.expected &&
    s.coverage === (s.expected === 0 ? null : s.hits / s.expected) && [s.compatibility, s.strict].every((v) =>
      v && [v.pass, v.fail, v.unknown].every(count) && v.pass + v.fail + v.unknown === s.ran);
}
const validEntry = (entry: IndexEntry) => isHash(entry?.id) && entry.reportPath === `reports/${entry.id}.html` &&
  runUrlPattern.test(entry.runUrl) && Number.isFinite(Date.parse(entry.generatedAt)) && !!entry.candidate?.id && !!entry.reference?.id && !!entry.suite?.id && validSummary(entry.summary);
function readIndex(data: string): { schemaVersion: 1; reports: IndexEntry[] } {
  const path = join(data, "reports/index.json");
  if (lstatSync(join(data, "reports"), { throwIfNoEntry: false })?.isSymbolicLink() ||
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Invalid public data symlink");
  if (!existsSync(path)) return { schemaVersion: 1, reports: [] };
  const index = readJson<ReturnType<typeof readIndex>>(path);
  if (index.schemaVersion !== 1 || !Array.isArray(index.reports) || new Set(index.reports.map((r) => r?.id)).size !== index.reports.length) {
    throw new Error("Invalid public index; refusing to discard history");
  }
  return index;
}

function verifyReport(report: Report, id: string) {
  const expected = publicCatalog().combinations.some(({ candidate, reference, suite }) =>
    hash([candidate, reference, suite]) === hash([report.candidate, report.reference, report.suite]));
  if (report.schemaVersion !== 1 || report.id !== id || !validEntry(indexEntry(report)) || !expected || hash(report.request) !== id ||
      report.request.version !== 1 || report.request.reference !== baseline || report.request.suite !== report.suite.id ||
      hash(candidates[asCandidate(report.request.candidate)]) !== hash(report.candidate) || report.request.candidateVersion !== report.candidate.version ||
      !isHash(report.request.planSha256) || !isHash(report.request.harnessSha256) || !isHash(report.request.candidateTool.sha256) ||
      !isHash(report.request.referenceTool.sha256) ||
      report.request.planCounts.shards !== report.summary.shards || report.request.planCounts.records !== report.summary.records ||
      report.request.planCounts.sourceFiles !== report.summary.sourceFiles || report.evidence.length !== report.summary.shards ||
      report.evidence.some((s) => !isHash(s.parsedInputsSha256) || !isHash(s.officialInputsSha256)) || report.differences.length > 8 ||
      report.differences.some((d) => typeof d.id !== "string" || ![d.extra, d.missed, d.misanchor].every(count))) {
    throw new Error("Invalid or incomplete public report");
  }
}

export function cached(data: string, id: string): boolean {
  if (!isHash(id)) throw new Error("Invalid public evaluation ID");
  try {
    const row = readIndex(data).reports.find((item) => item?.id === id);
    if (!row || !validEntry(row)) return false;
    if (![`${id}.json`, `${id}.html`].every((name) => lstatSync(join(data, "reports", name), { throwIfNoEntry: false })?.isFile())) return false;
    const report = readJson<Report>(join(data, `reports/${id}.json`));
    verifyReport(report, id);
    return hash(row) === hash(indexEntry(report)) && readFileSync(join(data, row.reportPath), "utf8") === reportHtml(report);
  } catch (error) {
    // An absent, obsolete or partial cached report must never skip execution.
    console.warn(`Ignoring invalid cached evidence for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function saveReport(data: string, bundle: string, id: string) {
  if (!isHash(id)) throw new Error("Invalid public evaluation ID");
  // Revalidate and reconstruct the only two files we copy from the trusted job.
  const report = readJson<Report>(join(bundle, `${id}.json`));
  verifyReport(report, id);
  const index = readIndex(data);
  const dir = join(data, "reports");
  for (const file of ["catalog.json", `${id}.json`, `${id}.html`]) {
    const path = lstatSync(join(dir, file), { throwIfNoEntry: false });
    if (path && !path.isFile()) throw new Error(`Invalid public data path: ${file}`);
  }
  if (!cached(data, id)) {
    const previous = index.reports.filter((row) => row?.id !== id);
    if (!previous.every(validEntry)) throw new Error("Malformed previous index entry; refusing to discard history");
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, `${id}.json`), report);
    writeFileSync(join(dir, `${id}.html`), reportHtml(report));
    writeJson(join(dir, "index.json"), { schemaVersion: 1, reports: [indexEntry(report), ...previous].sort((a, b) =>
      b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id)) });
  }
  writeJson(join(data, "reports/catalog.json"), publicCatalog());
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "pin" && args.length === 0) {
    const { repo, ref } = configuration();
    output({ repo, ref });
  } else if (cmd === "plan" && args.length === 6) {
    const [candidateArg, suiteArg, checkout, dest, dir, data] = args as [string, string, string, string, string, string];
    const candidate = asCandidate(candidateArg);
    const suite = asSuite(suiteArg);
    const { config, definition, ref } = configuration();
    const corpus = corpusRoot(checkout, ref);
    const corpusRef = corpusRefOf(config, definition)!;
    const ids = suite === "fixed-120" ? loadManifest(join(REPO_ROOT, manifest)) : null;
    if (ids && ids.length !== 120) throw new Error("The fixed 120 sample must have exactly 120 source files");
    const plan = ids === null ? buildPlan(corpus, corpusRef, 8, source, [candidate]) : buildPlanForIds(corpus, corpusRef, 1, source, [candidate], ids);
    const request = makeRequest(plan, suite, installTools(candidate, resolve(dest)));
    const id = hash(request);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "request.json"), request);
    writeJson(join(dir, "plan.json"), plan);
    output({ id, cached: String(cached(data, id)), matrix: JSON.stringify({ shard: plan.shards.map((shard) => shard.id) }) });
  } else if (cmd === "run" && args.length === 6) {
    const [dir, id, shardId, checkout, dest, out] = args as [string, string, string, string, string, string];
    const plan = readJson<Plan>(join(dir, "plan.json"));
    const request = readJson<Request>(join(dir, "request.json"));
    const shard = plan.shards.find((item) => item.id === shardId);
    if (!shard || hash(request) !== id || plan.candidates.length !== 1 || request.planSha256 !== hash(plan)) throw new Error("Invalid evaluation shard request");
    const tools = installTools(asCandidate(request.candidate), resolve(dest));
    if (hash(makeRequest(plan, asSuite(request.suite), tools)) !== id) throw new Error("Evaluation inputs changed after planning");
    runShard(plan, shard, request.candidate, corpusRoot(checkout, configuration().ref), resolve(out), tools.bin);
    const metrics = verifyShard(plan, shard, out, request.candidate);
    verifyRunIdentity(request, metrics.meta.tools, metrics.meta.options, metrics.meta.mode);
    if (metrics.meta.executionFailures!.length) throw new Error(`${metrics.meta.executionFailures!.length} execution failures; see shard artifact`);
  } else if (cmd === "report" && args.length === 5) {
    const [dir, id, root, bundle, runUrl] = args as [string, string, string, string, string];
    const request = readJson<Request>(join(dir, "request.json"));
    if (hash(request) !== id) throw new Error("Evaluation request identity changed");
    const report = makeReport(request, readJson<Plan>(join(dir, "plan.json")), root, runUrl);
    verifyReport(report, id);
    mkdirSync(bundle, { recursive: true });
    writeJson(join(bundle, `${id}.json`), report);
    writeFileSync(join(bundle, `${id}.html`), reportHtml(report));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Public evaluation · complete\n\n- Request: \`${id}\`\n- Compared: ${report.summary.ran}/${report.summary.records}; skipped: ${report.summary.skipped}\n`);
  } else if (cmd === "save" && args.length === 3) {
    saveReport(args[0]!, args[1]!, args[2]!);
  } else if (cmd === "verify-cache" && args.length === 2) {
    if (!cached(args[0]!, args[1]!)) throw new Error("Public evaluation cache entry missing or incomplete");
  } else {
    throw new Error("Expected pin | plan <candidate> <suite> <checkout> <tools> <out> <public-data> | run <plan-dir> <id> <shard> <checkout> <tools> <out> | report <plan-dir> <id> <shard-artifacts> <bundle> <run-url> | save <public-data> <bundle> <id> | verify-cache <public-data> <id>");
  }
}

if (import.meta.main) main();
