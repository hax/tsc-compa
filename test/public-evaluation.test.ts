import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Plan } from "../scripts/full-compatibility.ts";
import { cached, makeReport, publicCatalog, reportHtml, saveReport, type Request } from "../scripts/public-evaluation.ts";
import { sha256 } from "../src/provenance.ts";

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
  const plan: Plan = { version: 1, corpusRef: "microsoft/TypeScript@fixed", source: "official-baseline", candidates: ["typescript"], shards: [{
    id: "01", units: [{ id: "compiler/<fixture>.ts", records: ["compiler/<fixture>.ts"] }, { id: "compiler/skip.ts", records: ["compiler/skip.ts"] }], estimatedCost: 1,
  }] };
  const request: Request = { version: 1, candidate: "typescript", candidateVersion: "7.1.0-beta", reference: "7.1.0-beta-official", source: "official-baseline",
    suite: "full", corpus: plan.corpusRef, planSha256: hash(plan), manifestSha256: null, harnessSha256: sha256("harness"), runner,
    platform, runnerImage: "ubuntu24", node: "v22.18.0", locale: "C.UTF-8", timezone: "UTC", adapter: "tsc-cli",
    options: { mode: "official", strategy: "aligned", referenceBaseArgs: [] }, referenceTool: tool, candidateTool,
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
  const metricsFile = join(shardRoot, "metrics.json");
  write(metricsFile, metrics);
  return { root, data, bundle, metrics, metricsFile, plan, request };
}

test("catalog lists the eight explicit public combinations without implying they have run", () => {
  const catalog = publicCatalog();
  expect(catalog.schemaVersion).toBe(1);
  expect(catalog.combinations).toHaveLength(8);
  expect(new Set(catalog.combinations.map((row) => `${row.candidate.id}:${row.candidate.version}:${row.suite.id}`)).size).toBe(8);
  expect(catalog.combinations.every((row) => row.reference.id === "7.1.0-beta-official")).toBe(true);
});

test("verified compact evidence is reusable, and distinct request fingerprints preserve history", () => fixture(({ data, bundle, root, request, plan }) => {
  const first = makeReport(request, plan, root, run, "2026-10-31T00:00:00Z");
  expect(first.summary).toMatchObject({ complete: true, records: 2, ran: 1, skipped: 1, coverage: 0 });
  expect(reportHtml(first)).toContain("compiler/&lt;fixture&gt;.ts");
  expect(JSON.stringify(first)).not.toContain("/tmp/private");
  const firstJson = join(bundle, `${first.id}.json`);
  write(firstJson, first);
  expect(cached(data, first.id)).toBe(false);
  saveReport(data, bundle, first.id);
  expect(cached(data, first.id)).toBe(true);
  const second = makeReport({ ...request, harnessSha256: sha256("new runner") }, plan, root, run, "2026-11-01T00:00:00Z");
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
  metrics.meta.options.candidateEnvArgs = ["--strict"];
  write(metricsFile, metrics);
  expect(() => makeReport(request, plan, root, run)).toThrow("identity does not match");
  metrics.meta.executionFailures.push({ id: "compiler/skip.ts", status: "crash" });
  write(metricsFile, metrics);
  expect(() => makeReport(request, plan, root, run)).toThrow("execution failures");
  rmSync(metricsFile);
  expect(() => makeReport(request, plan, root, run)).toThrow("Evaluation incomplete");
}));
