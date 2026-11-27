import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Plan } from "../scripts/full-compatibility.ts";
import { cached, makeReport, planExecution, publicCatalog, reportHtml, saveReport, semanticFingerprint, shardReceipt, verifyPublic, verifyReport, type Request } from "../scripts/public-evaluation.ts";
import { activePolicies } from "../scripts/public-evaluation-policy.ts";
import { sha256 } from "../src/provenance.ts";
import { createHash } from "node:crypto";
import { distributionSha256, shardInputEvidence, verifyCorpus } from "../scripts/public-evaluation-inputs.ts";

import { distributionContents, inspectDistribution, verifyNpmArchive } from "../scripts/public-evaluation-tools.ts";

const hash = (value: unknown) => sha256(JSON.stringify(value));
const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
const run = "https://github.com/hax/tsc-compa/actions/runs/12345678";

function fixture(test: (fixture: ReturnType<typeof createFixture>) => void) {
  const root = mkdtempSync(join(tmpdir(), "tsc-public-eval-test-"));
  try { test(createFixture(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

function createFixture(root: string) {
  const tool = { version: "7.1.0-beta", sha256: sha256("reference"), nativeSha256: null, embeddedTypeScript: null };
  const candidateTool = { ...tool, version: "Version 7.1.0-beta" };
  const platform = "linux/x64";
  const runner = "Bun 1.4.5 (pinned)";
  const plan: Plan = { version: 1, corpusRef: `microsoft/TypeScript@${"a".repeat(40)}`, source: "official-baseline", candidates: ["typescript"], shards: [{
    id: "01", units: [{ id: "compiler/<fixture>.ts", records: ["compiler/<fixture>.ts"] }, { id: "compiler/skip.ts", records: ["compiler/skip.ts"] }], estimatedCost: 1,
  }] };
  const request: Request = { version: 2, candidate: "typescript", candidateVersion: "7.1.0-beta", reference: "7.1.0-beta-official", source: "official-baseline",
    suite: "full", corpus: plan.corpusRef, planSha256: hash(plan), planCounts: { shards: 1, sourceFiles: 2, records: 2 }, manifestSha256: null, harnessSha256: sha256("harness"), runner,
    platform, runnerImage: "ubuntu24", node: "v22.18.0", locale: "C.UTF-8", timezone: "UTC", adapter: "tsc-cli",
    options: { mode: "official", strategy: "aligned", referenceBaseArgs: [] }, referenceTool: tool, candidateTool,
    distributions: { reference: sha256("dist"), candidate: sha256("dist") },
    inputs: [{ shard: "01", parsedInputsSha256: sha256("parsed"), officialInputsSha256: sha256("official") }],
  };
  const shardRoot = join(root, "full-typescript-01");
  const bundle = join(root, "bundle");
  const data = join(root, "data");
  for (const dir of [shardRoot, bundle, data]) mkdirSync(dir);
  const ids = plan.shards[0]!.units.map((u) => u.id);
  write(join(shardRoot, "cases.json"), ids);
  write(join(shardRoot, "details.json"), [{ id: ids[0], status: "ran", missed: [{}], fp: [], misanchor: 0, actualRawOutput: "/tmp/private-file" }, { id: ids[1], status: "skip" }]);
  const metrics = {
    meta: { manifest: { selectedIdsSha256: hash(ids), parsedInputsSha256: sha256("parsed"), officialInputsSha256: sha256("official") },
      selectedCases: ids.length, baseline: request.reference, corpusRef: request.corpus, expectationSource: "official-baseline", mode: "official",
      options: { strategy: "aligned", referenceBaseArgs: [], candidateArgs: [], candidateEnvArgs: [] as string[], onlyClasses: [], excludeClasses: [], sharedArgs: [] },
      adapter: "tsc-cli:/tmp/private-compiler", verdictEligible: true, executionFailures: [] as unknown[],
      tools: { runner, platform, reference: { ...tool, path: "/tmp/private-compiler" }, candidate: { ...candidateTool, path: "/tmp/private-compiler" } },
    },
    totals: { cases: 2, ran: 1, skipped: 1, hitTotal: 0, expectTotal: 1, fpTotal: 0, missTotal: 1, misanchorTotal: 0 },
    skips: [["private raw skip reason /tmp/private-file", 1]],
    comparison: { compatibility: { pass: 0, fail: 1, unknown: 0 }, strict: { pass: 0, fail: 0, unknown: 1 } },
  };
  const receipt = join(shardRoot, "public-request.json");
  write(receipt, { id: hash(request), shard: "01" });
  const metricsFile = join(shardRoot, "metrics.json");
  write(metricsFile, metrics);
  return { root, data, bundle, metrics, metricsFile, plan, request, receipt };
}

test("adds two full-only combinations in rollout order without implying they have run", () => {
  const catalog = publicCatalog();
  expect(catalog.schemaVersion).toBe(1);
  expect(catalog.combinations).toHaveLength(10);
  expect(catalog.combinations.slice(8).map((row) => [row.candidate.id, row.candidate.name, row.candidate.version, row.suite.id])).toEqual([
    ["ts-rust", "ts-rust (pingdotgg)", "0.8.0", "full"], ["tsz", "tsz", "v0.1.75", "full"],
  ]);
  expect(new Set(catalog.combinations.map((row) => `${row.candidate.id}:${row.candidate.version}:${row.suite.id}`)).size).toBe(10);
  expect(catalog.combinations.every((row) => row.reference.id === "7.1.0-beta-official")).toBe(true);
});

test("rejects the blocked tsc-rs release and fixed samples for the new full-only candidates before reading the corpus", () => {
  const plan = (candidate: string, suite: string) => execFileSync(process.execPath,
    ["scripts/public-evaluation.ts", "plan", candidate, suite, "missing-corpus", "tools", "request", "public-data"], { stdio: "pipe" });
  expect(() => plan("tsc-rs", "full")).toThrow("Not a public candidate: tsc-rs");
  for (const candidate of ["ts-rust", "tsz"]) expect(() => plan(candidate, "fixed-120")).toThrow("only selectable with the full suite");
});

test("verified compact evidence is reusable, and distinct request fingerprints preserve history", () => fixture(({ data, bundle, root, request, plan, receipt }) => {
  const first = makeReport(request, plan, root, run, "2026-10-31T00:00:00Z");
  expect(first.summary).toMatchObject({ complete: true, records: 2, ran: 1, skipped: 1, coverage: 0 });
  expect(reportHtml(first)).toContain("compiler/&lt;fixture&gt;.ts");
  expect(JSON.stringify(first)).not.toContain("/tmp/private");
  const firstJson = join(bundle, `${first.id}.json`);
  write(firstJson, first);
  expect(cached(data, first.id)).toBe(false);
  saveReport(data, bundle, first.id);
  expect(cached(data, first.id)).toBe(true);
  const secondRequest = { ...request, harnessSha256: sha256("new runner") };
  expect(() => makeReport(secondRequest, plan, root, run)).toThrow("not bound to this public request");
  write(receipt, { id: hash(secondRequest), shard: "01" });
  const second = makeReport(secondRequest, plan, root, run, "2026-11-01T00:00:00Z");
  expect(cached(data, second.id)).toBe(false);
  write(join(bundle, `${second.id}.json`), second);
  saveReport(data, bundle, second.id);
  const indexPath = join(data, "reports/index.json");
  const snapshot = readFileSync(indexPath, "utf8");
  expect(JSON.parse(snapshot).reports.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
  saveReport(data, bundle, first.id);
  expect(readFileSync(indexPath, "utf8")).toBe(snapshot);
  expect(JSON.parse(readFileSync(join(data, "reports/catalog.json"), "utf8"))).toEqual(publicCatalog());
  rmSync(join(data, first.reportPath));
  expect(cached(data, first.id)).toBe(false);
  saveReport(data, bundle, first.id);
  expect(cached(data, first.id)).toBe(true);
  write(firstJson, { ...first, summary: { ...first.summary, records: 1, sourceFiles: 1, skipped: 0 } });
  expect(() => saveReport(data, bundle, first.id)).toThrow("Invalid or incomplete");
  write(firstJson, { ...first, summary: { ...first.summary, complete: false } });
  expect(() => saveReport(data, bundle, first.id)).toThrow("Invalid or incomplete");
  expect(readFileSync(indexPath, "utf8")).toBe(snapshot);
}));

test("force changes the execution decision and refreshes only the same canonical request", () => fixture(({ data, bundle, root, request, plan, receipt }) => {
  const original = makeReport(request, plan, root, run, "2026-10-30T00:00:00Z", { number: 10, attempt: 1 });
  const path = join(bundle, `${original.id}.json`);
  const readReport = () => JSON.parse(readFileSync(join(data, `reports/${original.id}.json`), "utf8"));
  expect(planExecution(data, original.id)).toEqual({ cacheHit: false, shouldRun: true });
  expect(planExecution(data, original.id, true)).toEqual({ cacheHit: false, shouldRun: true });
  write(path, original);
  expect(saveReport(data, bundle, original.id)).toBe("stored");
  expect(planExecution(data, original.id)).toEqual({ cacheHit: true, shouldRun: false });
  expect(planExecution(data, original.id, true)).toEqual({ cacheHit: true, shouldRun: true });

  const otherRequest = { ...request, harnessSha256: sha256("another harness") };
  write(receipt, { id: hash(otherRequest), shard: "01" });
  const other = makeReport(otherRequest, plan, root, run, "2026-10-31T00:00:00Z");
  write(join(bundle, `${other.id}.json`), other);
  saveReport(data, bundle, other.id);
  const otherHtml = readFileSync(join(data, other.reportPath), "utf8");
  write(receipt, { id: original.id, shard: "01" });

  const refreshed = makeReport(request, plan, root, `${run}9`, "2026-11-01T00:00:00Z", { number: 11, attempt: 1 });
  expect(refreshed.id).toBe(original.id);
  expect(refreshed.request).toEqual(original.request);
  write(path, refreshed);
  expect(saveReport(data, bundle, original.id)).toBe("already-stored");
  expect(readReport()).toEqual(original);
  expect(saveReport(data, bundle, original.id, true)).toBe("refreshed");
  expect(readReport()).toEqual(refreshed);
  expect(readFileSync(join(data, refreshed.reportPath), "utf8")).toBe(reportHtml(refreshed));
  expect(readFileSync(join(data, other.reportPath), "utf8")).toBe(otherHtml);
  const index = join(data, "reports/index.json");
  const snapshot = readFileSync(index, "utf8");
  expect(JSON.parse(snapshot).reports).toMatchObject([{ id: original.id, runUrl: refreshed.runUrl }, { id: other.id }]);
  expect(planExecution(data, original.id)).toEqual({ cacheHit: true, shouldRun: false });

  const late = { ...original, workflowRun: { number: 10, attempt: 3 }, generatedAt: "2026-11-02T00:00:00Z" };
  write(path, late);
  expect(saveReport(data, bundle, original.id, true)).toBe("superseded");
  expect(saveReport(data, bundle, original.id)).toBe("already-stored");
  write(path, { ...refreshed, generatedAt: late.generatedAt });
  expect(saveReport(data, bundle, original.id, true)).toBe("already-stored");
  for (const invalid of [
    { ...refreshed, workflowRun: undefined },
    { ...refreshed, workflowRun: { number: 12, attempt: 0 } },
    { ...refreshed, workflowRun: { number: 12, attempt: 1 }, summary: { ...refreshed.summary, complete: false } },
  ]) {
    write(path, invalid);
    expect(() => saveReport(data, bundle, original.id, true)).toThrow();
  }
  expect(readReport()).toEqual(refreshed);
  expect(readFileSync(index, "utf8")).toBe(snapshot);

  const retry = { ...refreshed, workflowRun: { number: 11, attempt: 2 }, generatedAt: late.generatedAt };
  write(path, retry);
  expect(saveReport(data, bundle, original.id, true)).toBe("refreshed");
  expect(readReport()).toEqual(retry);
  expect(() => verifyPublic(data)).not.toThrow();
}));

test("a rejected push retries against the newer same-request evidence without changing the remote", () => fixture(({ root, bundle, data, request, plan }) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = join(root, "repo.git");
  const ref = "refs/heads/public-report-data";
  git(root, "init", "--bare", "-q", repo);
  git(repo, "config", "core.hooksPath", join(repo, "hooks"));
  git(data, "init", "-q");
  const original = makeReport(request, plan, root, run, "2026-10-30T00:00:00Z", { number: 10, attempt: 1 });
  const path = join(bundle, `${original.id}.json`);
  const stage = () => {
    git(data, "add", "reports");
    git(data, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test evidence");
  };
  const persist = (...flags: string[]) => execFileSync("bash", ["scripts/persist-public-evaluation.sh", bundle, original.id, ...flags], {
    env: { ...env, PUSH_TOKEN: "fixture", GITHUB_SERVER_URL: root, GITHUB_REPOSITORY: "repo", GITHUB_STEP_SUMMARY: join(root, "summary") },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  write(path, original);
  expect(persist()).toContain(`Stored ${original.id}`);
  git(data, "pull", "-q", repo, ref);
  const newer = { ...original, runUrl: `${run}9`, workflowRun: { number: 12, attempt: 1 } };
  write(path, newer);
  saveReport(data, bundle, original.id, true);
  stage();
  const winner = git(data, "rev-parse", "HEAD");
  git(data, "push", "-q", repo, "HEAD:refs/heads/test-winner");
  // Advance the remote after the stale attempt reads it, but before its
  // push can update the ref. The real Git ref update must reject that push.
  writeFileSync(join(repo, "hooks/pre-receive"), `#!/bin/sh
unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
git update-ref '${ref}' '${winner}'
`, { mode: 0o755 });
  write(path, { ...original, generatedAt: "2026-11-01T00:00:00Z", workflowRun: { number: 11, attempt: 1 } });
  expect(persist("--force")).toContain("newer evidence is already stored");
  expect(git(repo, "rev-parse", ref)).toBe(winner);
  expect(JSON.parse(git(repo, "show", `${ref}:reports/${original.id}.json`))).toEqual(newer);
  expect(persist()).toContain("already stored; no public data changed");
}), 30_000);

test("missing shards, execution failures and wrong tools or option strategies cannot produce a report", () => fixture(({ root, request, plan, metricsFile, metrics }) => {
  expect(() => makeReport(request, { ...plan, shards: [] }, root, run)).toThrow("Invalid public evaluation plan");
  metrics.meta.tools.candidate.sha256 = sha256("unexpected binary");
  write(metricsFile, metrics);
  expect(() => makeReport(request, plan, root, run)).toThrow("identity does not match");
  metrics.meta.tools.candidate.sha256 = request.candidateTool.sha256;
  metrics.meta.manifest.officialInputsSha256 = sha256("wrong reference input");
  write(metricsFile, metrics);
  expect(() => makeReport(request, plan, root, run)).toThrow("input evidence does not match");
  metrics.meta.manifest.officialInputsSha256 = request.inputs[0]!.officialInputsSha256;
  metrics.meta.options.candidateEnvArgs = ["--strict"];
  write(metricsFile, metrics);
  expect(() => makeReport(request, plan, root, run)).toThrow("identity does not match");
  metrics.meta.executionFailures.push({ id: "compiler/skip.ts", status: "crash" });
  write(metricsFile, metrics);
  expect(() => makeReport(request, plan, root, run)).toThrow("execution failures");
  rmSync(metricsFile);
  expect(() => makeReport(request, plan, root, run)).toThrow("Evaluation incomplete");
}));


test("a clean sparse checkout missing tracked baselines is rejected before cache lookup", () => fixture(({ root }) => {
  const cases = "tsc/testdata/tests/cases";
  const baselines = "tsc/testdata/baselines/reference";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  for (const dir of [cases, baselines]) mkdirSync(join(root, dir, "compiler"), { recursive: true });
  writeFileSync(join(root, cases, "compiler/a.ts"), "const n: number = 'x';\n");
  const errorsPath = `${baselines}/compiler/a.errors.txt`;
  const errors = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  writeFileSync(join(root, errorsPath), errors);
  writeFileSync(join(root, baselines, "keep.types"), "proof\n");
  git("add", "tsc");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture corpus");
  const ref = git("rev-parse", "HEAD");
  const corpus = verifyCorpus(root, ref);
  const evidence = shardInputEvidence(corpus, "01", ["compiler/a.ts"]);
  expect(evidence.officialInputsSha256).toBe(sha256(`${JSON.stringify(["compiler/a.ts", errors])}\n`));
  git("sparse-checkout", "set", cases);
  expect(git("status", "--porcelain", "--", "tsc")).toBe("");
  expect(() => verifyCorpus(root, ref)).toThrow("Missing or non-directory public input");
  git("sparse-checkout", "set", cases, baselines);
  expect(verifyCorpus(root, ref)).toBe(corpus);
  git("update-index", "--skip-worktree", errorsPath);
  rmSync(join(root, errorsPath));
  expect(git("status", "--porcelain", "--", "tsc")).toBe("");
  expect(() => verifyCorpus(root, ref)).toThrow("Missing tracked corpus input");
  writeFileSync(join(root, errorsPath), errors.replace("string", "unknown"));
  expect(() => verifyCorpus(root, ref)).toThrow("differs from pinned bytes");
  writeFileSync(join(root, errorsPath), errors);
  mkdirSync(join(root, baselines, "untracked.types"));
  expect(() => verifyCorpus(root, ref)).toThrow("Untracked corpus directory");
}));

test("dist identity changes when installed declaration bytes or paths change but the binary stays pinned", () => fixture(({ root }) => {
  const packageDirectory = join(root, "dist");
  mkdirSync(packageDirectory);
  write(join(packageDirectory, "package.json"), { name: "checker", version: "1.0.0" });
  writeFileSync(join(packageDirectory, "checker"), "binary bytes");
  const lib = join(packageDirectory, "lib.esnext.d.ts");
  writeFileSync(lib, "declare const foo: string;");
  const original = distributionSha256([packageDirectory]);
  writeFileSync(lib, "declare const foo: number;");
  expect(distributionSha256([packageDirectory])).not.toBe(original);
  writeFileSync(lib, "declare const foo: string;");
  expect(distributionSha256([packageDirectory])).toBe(original);
  rmSync(lib);
  expect(distributionSha256([packageDirectory])).not.toBe(original);
}));

test("cache and deploy reject invalid catalogs, nested unknown fields, or unexpected files", () => fixture(({ data, bundle, root, request, plan }) => {
  const report = makeReport(request, plan, root, run);
  const reportFile = join(bundle, `${report.id}.json`);
  write(reportFile, report);
  saveReport(data, bundle, report.id);
  expect(() => verifyPublic(data)).not.toThrow();
  const catalogPath = join(data, "reports/catalog.json");
  rmSync(catalogPath);
  expect(cached(data, report.id)).toBe(false);
  expect(() => verifyPublic(data)).toThrow("catalog or index");
  write(catalogPath, { ...publicCatalog(), secret: "not public" });
  expect(cached(data, report.id)).toBe(false);
  saveReport(data, bundle, report.id);
  expect(cached(data, report.id)).toBe(true);
  for (const invalid of [
    { ...report, raw: { path: "/tmp/private" } },
    { ...report, summary: { ...report.summary, compatibility: { ...report.summary.compatibility, private: "raw" } } },
    { ...report, summary: { ...report.summary, private: "raw" } },
    { ...report, evidence: [{ ...report.evidence[0], private: "raw" }] },
    { ...report, differences: [{ ...report.differences[0], private: "raw" }] },
  ]) {
    write(reportFile, invalid);
    expect(() => saveReport(data, bundle, report.id)).toThrow("Invalid or incomplete");
  }
  const invalidRequest = { ...report.request, referenceTool: { ...report.request.referenceTool, path: "/tmp/private" } };
  const invalidId = hash(invalidRequest);
  expect(() => verifyReport({ ...report, id: invalidId, request: invalidRequest, reportPath: `reports/${invalidId}.html` }, invalidId)).toThrow("Invalid or incomplete");
  writeFileSync(join(data, "reports", "unlisted.txt"), "not in the public contract");
  expect(() => verifyPublic(data)).toThrow("Unexpected file");
}));


test("retains historical HTML and IDs while accepting the exact legacy catalog", () => fixture(({ root, data, bundle, request, plan }) => {
  const report = makeReport(request, plan, root, run);
  write(join(bundle, `${report.id}.json`), report);
  saveReport(data, bundle, report.id);
  const html = readFileSync(join(data, report.reportPath), "utf8");
  const path = join(data, "reports/catalog.json");
  const priorCatalog = { ...publicCatalog(), combinations: publicCatalog().combinations.slice(0, 8) };
  write(path, priorCatalog);
  expect(cached(data, report.id)).toBe(true);
  expect(() => verifyPublic(data)).not.toThrow();
  expect(readFileSync(join(data, report.reportPath), "utf8")).toBe(html);
  write(path, { ...priorCatalog, combinations: priorCatalog.combinations.slice(0, 7) });
  expect(() => verifyPublic(data)).toThrow("catalog or index");
}));

test("source Markdown does not affect request identity, but harness code does", () => fixture(({ root }) => {
  for (const path of ["scripts", "config", ".github", "src"]) cpSync(path, join(root, path), { recursive: true });
  for (const path of ["package.json", "bun.lock", ".npmrc"]) cpSync(path, join(root, path));
  const original = semanticFingerprint(root);
  for (const path of ["src/README.md", "src/adapters/README.md", "src/adapters/design.MARKDOWN"]) {
    writeFileSync(join(root, path), "one");
    expect(semanticFingerprint(root)).toBe(original);
    writeFileSync(join(root, path), "two");
  }
  expect(semanticFingerprint(root)).toBe(original);
  writeFileSync(join(root, "src/adapters/index.ts"), "export {};\n");
  expect(semanticFingerprint(root)).not.toBe(original);
}));

test("validates prepared compiler provenance and exact shard options without promoting local paths", () => fixture(({ root, data, bundle, request, plan, metrics }) => {
  plan.candidates = ["tsz"];
  const { version: _version, ...old } = request;
  const policyAtRun = activePolicies.tsz;
  if (policyAtRun.source.kind !== "release") throw new Error("Missing fixture policy");
  const q = { ...old, version: 3 as const, candidate: "tsz" as const, candidateVersion: policyAtRun.candidate.version, planSha256: hash(plan),
    options: { ...old.options, candidateEnvArgs: [...policyAtRun.cliArgs] },
    candidateTool: { ...old.candidateTool, version: policyAtRun.selfReport, sha256: policyAtRun.nativeSha256 },
    prepared: { source: policyAtRun.source, runtimeLibrariesSha256: sha256("runtime"), environment: policyAtRun.environment },
  } satisfies Request;
  const oldDir = join(root, "full-typescript-01");
  const dir = join(root, "full-tsz-01");
  cpSync(oldDir, dir, { recursive: true });
  const receipt = join(dir, "public-request.json");
  write(receipt, shardReceipt(q, hash(q), "01"));
  metrics.meta.tools.candidate.version = q.candidateTool.version;
  metrics.meta.tools.candidate.sha256 = q.candidateTool.sha256;
  const metricsFile = join(dir, "metrics.json");
  metrics.meta.options.candidateEnvArgs = ["--checkers", "1"];
  write(metricsFile, metrics);
  expect(() => makeReport(q, plan, root, run)).toThrow("identity does not match");
  metrics.meta.options.candidateEnvArgs = [];
  write(metricsFile, metrics);
  const report = makeReport(q, plan, root, run);
  expect(() => verifyReport(report, report.id)).not.toThrow();
  expect(reportHtml(report)).toContain("tsz-org/tsz v0.1.75@0c0e53f");
  expect(reportHtml(report)).toContain("CLI 自报版本：<code>Version 7.0.2");
  expect(JSON.stringify(report)).not.toContain("/tmp/private");
  for (const prepared of [
    { ...q.prepared, environment: { TSZ_LIB_DIR: "/tmp/private" } },
    { ...q.prepared, source: { ...q.prepared.source, commit: "a".repeat(40) } },
    { ...q.prepared, source: { ...q.prepared.source, path: "/tmp/private" } },
    { ...q.prepared, runtimeLibrariesSha256: [sha256("runtime")] },
  ]) {
    const request = { ...q, prepared };
    const id = hash(request);
    expect(() => verifyReport({ ...report, id, request, reportPath: `reports/${id}.html` }, id)).toThrow("Invalid or incomplete");
  }
  write(join(bundle, `${report.id}.json`), report);
  expect(saveReport(data, bundle, report.id)).toBe("stored");
  // Run a fresh copy of the actual Pages staging CLI with a new active pin
  // and arguments appended. Do not mutate the running validator or registry.
  const checkout = join(root, "next-generation");
  for (const path of ["scripts", "config", "src"]) cpSync(path, join(checkout, path), { recursive: true });
  const policyPath = join(checkout, "scripts/public-evaluation-policy.ts");
  const policy = readFileSync(policyPath, "utf8");
  const next = { ...policyAtRun, candidate: { ...policyAtRun.candidate, version: "v0.1.76" }, cliArgs: ["--example"],
    source: { ...policyAtRun.source, tag: "v0.1.76", commit: "a".repeat(40) } };
  writeFileSync(policyPath, policy.replace('];\nexport const activePolicies', `];\n(policyGenerations as Generation[]).push({ policies: { ...policyGenerations[0]!.policies, tsz: ${JSON.stringify(next)} } });\nexport const activePolicies`));
  const stage = join(root, "staged");
  const stageCommand = join(checkout, "scripts/stage-public-reports.ts");
  execFileSync(process.execPath, [stageCommand, data, stage]);
  expect(readFileSync(join(stage, `${report.id}.html`), "utf8")).toBe(reportHtml(report));
  expect(JSON.parse(readFileSync(join(stage, "catalog.json"), "utf8")).combinations.at(-1).candidate.version).toBe("v0.1.76");
  // A report relabeled to the new tuple but holding the old source/args is
  // still rejected even when its own ID is recomputed.
  const relabeledRequest = { ...q, candidateVersion: next.candidate.version };
  const relabeledId = hash(relabeledRequest);
  write(join(bundle, `${relabeledId}.json`), { ...report, id: relabeledId, candidate: next.candidate,
    request: relabeledRequest, reportPath: `reports/${relabeledId}.html` });
  expect(() => execFileSync(process.execPath, [join(checkout, "scripts/public-evaluation.ts"), "save", data, bundle, relabeledId],
    { stdio: "pipe" })).toThrow("Invalid or incomplete public report");
  write(receipt, { ...shardReceipt(q, hash(q), "01"), candidateDistributionSha256: sha256("wrong distribution") });
  expect(() => makeReport(q, plan, root, run)).toThrow("not bound to this public request");
}));

test("prepared distributions reject extra files, symlinks and changed compiler bytes before execution", () => fixture(({ root }) => {
  const dist = join(root, "prepared");
  mkdirSync(dist);
  const bin = join(dist, "tsz");
  writeFileSync(bin, "expected executable");
  const exact = distributionContents("tsz", dist);
  writeFileSync(bin, "changed executable");
  const source = activePolicies.tsz.source;
  if (source.kind !== "release") throw new Error("Missing fixture policy");
  expect(() => inspectDistribution("tsz", dist, source, { ...exact, runtimeLibrariesSha256: sha256("runtime") })).toThrow("bytes changed after planning");
  const extra = join(dist, "lib.es5.d.ts");
  writeFileSync(extra, "extra library");
  expect(() => distributionContents("tsz", dist)).toThrow("Unexpected files");
  rmSync(extra);
  symlinkSync("tsz", extra);
  expect(() => distributionContents("tsz", dist)).toThrow("Non-regular public input");
}));


test("npm acquisition requires both SHA-256 and npm SHA-512 integrity", () => {
  const bytes = Buffer.from("pinned archive fixture");
  const digest = sha256(bytes);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  expect(() => verifyNpmArchive(bytes, digest, integrity)).not.toThrow();
  expect(() => verifyNpmArchive(bytes, digest, `${integrity}bad`)).toThrow("integrity mismatch");
  expect(() => verifyNpmArchive(bytes, sha256("other"), integrity)).toThrow("integrity mismatch");
});
