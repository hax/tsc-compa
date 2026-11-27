import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Plan } from "../scripts/full-compatibility.ts";
import { cached, makeReport, publicCatalog, reportHtml, saveReport, verifyPublic, verifyReport, type Request } from "../scripts/public-evaluation.ts";
import { sha256 } from "../src/provenance.ts";
import { distributionSha256, shardInputEvidence, verifyCorpus } from "../scripts/public-evaluation-inputs.ts";

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

test("catalog lists the eight explicit public combinations without implying they have run", () => {
  const catalog = publicCatalog();
  expect(catalog.schemaVersion).toBe(1);
  expect(catalog.combinations).toHaveLength(8);
  expect(new Set(catalog.combinations.map((row) => `${row.candidate.id}:${row.candidate.version}:${row.suite.id}`)).size).toBe(8);
  expect(catalog.combinations.every((row) => row.reference.id === "7.1.0-beta-official")).toBe(true);
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
