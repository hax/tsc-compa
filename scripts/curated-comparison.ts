// Read-only public-format projection of the committed #27 evidence, not a new evaluation or data-branch writer.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../src/baselines.ts";
import { sha256 } from "../src/provenance.ts";

export const suiteId = "curated-difference-v1";
const suiteLabel = "兼容性差异样本 v1（草案）";
const evidenceCommit = "90089eba7ef407b23b7c4dccc22fb555cc822e15";
const inputs = {
  "cases.json": "fa40df2eef47a456261c914746ed3092f7c11946238b855e6d414ad50f216f2b",
  "evidence.json": "7611ec06bb3a8400eb1ba6833104b61c6cd8f969adab5142a5e50427da745fac",
  "inputs.json": "ae71da89d605363a54d01a7448cb603b2ee9b787a2ef2c4aa50eae8179b2eb53",
  "artifacts.lock.json": "aa6d662b217ac537422308bfc1128b408c13f18a3becdc3066903d3a7d7a6a58",
};
const repository = "https://github.com/hax/tsc-compa";
const runUrl = (run: number) => `${repository}/actions/runs/${run}`;
const roles = { "reference-control": "官方 TS7 CLI 对照组", "public-full": "已发布全量运行", "release-preview": "只读全量预演" } as const;
const buckets = {
  "multiple-families": "多家族出现差异", "single-family": "单一家族出现差异",
  "reference-disagreement": "官方 CLI 与参考结果文件有差异（不归因于候选）",
  "intentional-skip": "明确不支持的选项", "control-with-diagnostics": "有诊断对照例", "control-without-diagnostics": "无诊断对照例",
} as const;
const statuses = { pass: "兼容", mismatch: "有差异", unknown: "无法确认", skip: "跳过" } as const;
const skipKinds = { "unsupported-option": "选项不支持", "reference-unavailable": "缺少参考证据", other: "其他" } as const;

type Point = [file: string, line: number, column: number, severity: string, code: number];
type Observation = { status: "pass" | "mismatch" | "unknown"; expected: number; actual: number; hits: number;
  extra: number[]; missing: number[]; moved: number[] } |
  { status: "skip"; kind: keyof typeof skipKinds; reason: string; optionEvidence?: { args: string[] } };
type PublicObservation = Exclude<Observation, { status: "skip" }> |
  { status: "skip"; kind: keyof typeof skipKinds; reason: string; optionArgs: string[] };
type Evidence = {
  schemaVersion: 1; suite: string; corpus: string; baseline: string;
  inventory: { sourceFiles: number; records: number };
  runs: { candidate: string; candidateVersion: string; family: string; role: keyof typeof roles;
    run: number; commit: string; attempt: number; reportId: string; adapter: string; platform: string; candidateArgs: string[];
    candidateTool: { sha256: string }; prepared: { environment: Record<string, string> } | null }[];
  cases: { source: string; configuration: string | null; bucket: keyof typeof buckets; mismatchFamilies: string[];
    observations: Record<string, Observation> }[];
  supplemental: { run: number; commit: string; attempt: number; anchors: Record<"ts6" | "ts7", { version: string }>;
    probes: { id: string; source: string; upstreamCase: string; reason: string; ts6: Point[]; ts7: Point[] }[] };
};

function requireInvariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function loadCuratedComparison(directory = join(REPO_ROOT, "config", suiteId)) {
  // V1 is bound to reviewed bytes, not merely totals or a similarly named local draft.
  const verified = new Map<string, Buffer>();
  for (const [file, digest] of Object.entries(inputs)) {
    const bytes = readFileSync(join(directory, file));
    requireInvariant(sha256(bytes) === digest, `Curated v1 input SHA-256 mismatch: ${file}`);
    verified.set(file, bytes);
  }
  const read = <T>(file: keyof typeof inputs): T => JSON.parse(verified.get(file)!.toString("utf8")) as T;
  const sourceFiles = read<string[]>("cases.json");
  const evidence = read<Evidence>("evidence.json");
  const ids = evidence.runs.map((r) => r.candidate);
  requireInvariant(evidence.schemaVersion === 1 && evidence.suite === `${suiteId}-draft` && sourceFiles.length === 33 &&
    evidence.cases.length === 33 && new Set(sourceFiles).size === 33 &&
    JSON.stringify([...sourceFiles].sort()) === JSON.stringify(evidence.cases.map((c) => c.source).sort()) &&
    ids.length === 6 && new Set(ids).size === ids.length && evidence.supplemental.probes.length === 5,
  "Unexpected curated v1 inventory");
  const counts = Object.fromEntries(ids.map((id) => [id, { pass: 0, mismatch: 0, unknown: 0, skip: 0 }]));
  const cases = evidence.cases.map(({ source, configuration, bucket, mismatchFamilies, observations }) => {
    requireInvariant(Object.hasOwn(buckets, bucket) && Object.keys(observations).length === ids.length &&
      ids.every((id) => Object.hasOwn(observations, id)), `Incomplete curated observations: ${source}`);
    const cells = ids.map((id): [string, PublicObservation] => {
      const o = observations[id]!;
      requireInvariant(Object.hasOwn(statuses, o.status), `Unknown curated status: ${source}/${id}`);
      counts[id]![o.status]++;
      if (o.status === "skip") {
        requireInvariant(Object.hasOwn(skipKinds, o.kind) && o.reason.length > 0, `Unexplained curated skip: ${source}/${id}`);
        return [id, { status: o.status, kind: o.kind, reason: o.reason, optionArgs: o.optionEvidence?.args ?? [] }];
      }
      return [id, { status: o.status, expected: o.expected, actual: o.actual, hits: o.hits,
        extra: o.extra, missing: o.missing, moved: o.moved }];
    });
    return { source, configuration, bucket, mismatchFamilies, observations: Object.fromEntries(cells) };
  });
  const { supplemental } = evidence;
  return {
    schemaVersion: 1, suite: { id: suiteId, label: suiteLabel, status: "draft" as const },
    scope: { evidence: "pinned-full-runs" as const, extrapolateCompatibility: false, corpus: evidence.corpus,
      baseline: evidence.baseline, referenceSource: "official-baseline" as const, targetConfigurations: cases.length,
      sourceFiles: sourceFiles.length, siblingConfigurations: "not-included" as const, supplementalProbes: supplemental.probes.length,
      fullInventory: { sourceFiles: evidence.inventory.sourceFiles, records: evidence.inventory.records } },
    provenance: { commit: evidenceCommit, inputs },
    candidates: evidence.runs.map((r) => ({ id: r.candidate, version: r.candidateVersion, family: r.family, role: r.role,
      run: { id: r.run, url: runUrl(r.run), attempt: r.attempt, commit: r.commit, sourceReportId: r.reportId },
      platform: r.platform, adapter: r.adapter, args: r.candidateArgs, environment: r.prepared?.environment ?? {},
      executableSha256: r.candidateTool.sha256, outcomes: counts[r.candidate]! })),
    cases,
    supplemental: { kind: "calibrated-official-version-probes" as const,
      run: { id: supplemental.run, url: runUrl(supplemental.run), commit: supplemental.commit, attempt: supplemental.attempt },
      anchors: { ts6: supplemental.anchors.ts6.version, ts7: supplemental.anchors.ts7.version },
      probes: supplemental.probes.map(({ id, source, upstreamCase, reason, ts6, ts7 }) => ({ id, source, upstreamCase, description: reason, ts6, ts7 })) },
    rerun: `${repository}/tree/${evidenceCommit}/config/${suiteId}#本地跑选中的源文件`,
  };
}
export type CuratedComparison = ReturnType<typeof loadCuratedComparison>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const repoFile = (file: string) => `${repository}/blob/${evidenceCommit}/${file.split("/").map(encodeURIComponent).join("/")}`;
const point = ([file, line, col, severity, code]: Point) => `${file}:${line}:${col} ${severity} TS${code}`;
const pointsHtml = (points: Point[]) => points.length ? points.map((p) => `<code>${esc(point(p))}</code>`).join("<br>") : "无诊断";
const codesHtml = (codes: number[]) => codes.length ? codes.map((c) => `TS${c}`).join("、") : "无";

export function curatedComparisonHtml(data: CuratedComparison) {
  const cell = (o: PublicObservation) => o.status === "skip"
    ? `<td><strong>跳过：${skipKinds[o.kind]}</strong><br>${esc(o.reason)}${o.optionArgs.length ? `<br><code>${esc(o.optionArgs.join(" "))}</code>` : ""}</td>`
    : `<td><strong>${statuses[o.status]}</strong>${o.status === "mismatch" ? `<br>多报：${codesHtml(o.extra)}<br>漏报：${codesHtml(o.missing)}<br>位置差异：${codesHtml(o.moved)}` : ""}</td>`;
  const names = data.candidates.map((r) => `<th scope="col">${esc(r.id)}<br>${esc(r.version)}</th>`).join("");
  const groups = Object.entries(buckets).map(([key, label]) => {
    const rows = data.cases.filter((c) => c.bucket === key);
    return `<h3 id="${key}">${label}（${rows.length}）</h3>
<table border="1"><thead><tr><th scope="col">源文件 / 目标配置</th>${names}</tr></thead><tbody>
${rows.map((row) => `<tr><th scope="row"><code>${esc(row.source)}</code><br>${row.configuration === null ? "默认（无命名配置）" : `<code>${esc(row.configuration)}</code>`}${row.mismatchFamilies.length ? `<br>出现差异的家族：${esc(row.mismatchFamilies.join("、"))}` : ""}</th>${data.candidates.map(({ id }) => cell(row.observations[id]!)).join("")}</tr>`).join("\n")}
</tbody></table>`;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>${esc(data.suite.label)} · tsc-compa</title></head>
<body><main><p><a href="../../">返回公开报告目录</a> · <a href="comparison.json">下载比较数据</a></p>
<h1>${esc(data.suite.label)}</h1><p>测试集 ID：<code>${data.suite.id}</code>。</p>
<p><strong>这是为复现差异选出的样本，不是代表性样本；不能据此估算整体兼容率或给检查器排名。</strong></p>
<p>本页从六份固定的全量运行提取 ${data.scope.targetConfigurations} 个目标配置。只展示所标记的配置，不计入同文件的其他配置。比较参考为 TS 7.1.0-beta 官方 <code>.errors.txt</code>；另有 ${data.scope.supplementalProbes} 个官方版本探针，不计入比较。跳过不是通过，也不是零诊断。仅展示兼容档结论，不推断严格一致。</p>
<h2>证据来源</h2><p>语料：<code>${esc(data.scope.corpus)}</code>。Bun 的两版是同一个候选家族；官方 CLI 是参考对照组。</p><ul>
${data.candidates.map(({ id, version, role, run }) => `<li><strong>${esc(id)} ${esc(version)}</strong> · ${roles[role]} · <a href="${esc(run.url)}">Actions ${run.id}（尝试 ${run.attempt}）</a> · <code>${esc(run.commit)}</code></li>`).join("\n")}
</ul><h2>各候选的目标记录数（不是兼容率）</h2><table border="1"><thead><tr><th scope="col">候选</th><th scope="col">兼容</th><th scope="col">有差异</th><th scope="col">无法确认</th><th scope="col">跳过</th></tr></thead><tbody>
${data.candidates.map(({ id, version, outcomes: { pass, mismatch, unknown, skip } }) => `<tr><th scope="row">${esc(id)} ${esc(version)}</th><td>${pass}</td><td>${mismatch}</td><td>${unknown}</td><td>${skip}</td></tr>`).join("\n")}
</tbody></table>
<h2>逐案比较</h2><ul>${Object.entries(buckets).map(([key, label]) => `<li><a href="#${key}">${label}</a></li>`).join("")}</ul>
${groups}
<h2>独立补充：官方 TS6／TS7 校准探针</h2><p>只展示两个官方 CLI 的诊断指纹，不用于判定候选版本。<a href="${esc(data.supplemental.run.url)}">校准运行</a>。</p>
<table border="1"><thead><tr><th scope="col">探针</th><th scope="col">${esc(data.supplemental.anchors.ts6)}</th><th scope="col">${esc(data.supplemental.anchors.ts7)}</th></tr></thead><tbody>
${data.supplemental.probes.map((p) => `<tr><th scope="row"><a href="${esc(repoFile(p.source))}">${esc(p.id)}</a><br>${esc(p.description)}</th><td>${pointsHtml(p.ts6)}</td><td>${pointsHtml(p.ts7)}</td></tr>`).join("\n")}
</tbody></table>
<h2>本地复现</h2><p><a href="${esc(data.rerun)}">按固定语料重跑源文件和独立探针</a>。本地运行会展开同级配置；按源文件和配置二元键筛选，才能与本页目标对应。</p>
</main></body></html>\n`;
}

function ensureDirectory(path: string, recursive = false) {
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { recursive });
  // lstat rejects symlinks even if they point to a directory or are dangling.
  requireInvariant(lstatSync(path).isDirectory(), `Expected a real directory: ${path}`);
  return realpathSync(path);
}

/** Stage beside the catalog; never modify catalog/index/history or overwrite an existing v1 snapshot. */
export function stageCuratedComparison(webRoot: string) {
  const data = loadCuratedComparison();
  const html = curatedComparisonHtml(data);
  const requestedRoot = resolve(webRoot);
  // Canonicalize ancestors (e.g. macOS /tmp) but require the requested root's final component to be real.
  const root = ensureDirectory(requestedRoot, true);
  const reports = join(root, "reports");
  requireInvariant(ensureDirectory(reports) === reports, `Reports directory is not inside the staging root: ${reports}`);
  const destination = join(reports, suiteId);
  mkdirSync(destination); // A fresh real directory only; never follow or overwrite an existing entry.
  requireInvariant(lstatSync(destination).isDirectory() && realpathSync(destination) === destination,
    `Sidecar directory is not inside the staging root: ${destination}`);
  writeFileSync(join(destination, "index.html"), html, { flag: "wx" });
  writeFileSync(join(destination, "comparison.json"), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  return join(requestedRoot, "reports", suiteId);
}

if (import.meta.main) {
  const [output, ...rest] = process.argv.slice(2);
  if (!output || rest.length) throw new Error("Usage: bun scripts/curated-comparison.ts <staging web root>");
  console.log(stageCuratedComparison(output));
}
