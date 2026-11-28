import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { generateReport } from "../src/report.ts";
import { finalizeOptionAssessment } from "../src/verdict.ts";
import type { Adapter, OptionNegotiation } from "../src/types.ts";
import { compareCase, skipRecord, summarize, type Metrics, type RunMeta } from "../src/compare.ts";
import { capabilities as eulerCapabilities, strictSource, type WorkerMode } from "./fixtures/batch-options-worker.ts";

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(worker: string) {
  const dir = mkdtempSync(join(tmpdir(), "tsc-batch-options-"));
  dirs.push(dir);
  const corpus = join(dir, "tests/cases");
  mkdirSync(join(corpus, "compiler"), { recursive: true });
  mkdirSync(join(dir, "tests/baselines/reference/compiler"), { recursive: true });
  writeFileSync(join(corpus, "compiler/clean.ts"), "// @strict: false\nconst clean = true;\n");
  const manifest = join(dir, "cases.json");
  writeFileSync(manifest, '["compiler/clean.ts"]');
  const tsVersion = join(dir, "reference.sh");
  // Only the runner's --version probe is allowed. Diagnostics come from the
  // empty synthetic official-baseline tree, not an external compiler.
  writeFileSync(tsVersion, '#!/bin/sh\n[ "$1" = --version ] || exit 9\nprintf "Version 6.0.3\\n"\n', { mode: 0o755 });
  const script = join(dir, "worker.ts");
  writeFileSync(script, worker);
  const bin = join(dir, "worker.sh");
  const shell = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'fixture'; exit; fi\nexec ${shell(process.execPath)} ${shell(script)} "$@"\n`, { mode: 0o755 });
  const out = join(dir, "out");
  const ratchet = join(dir, "synthetic.tsv");
  function run(...extra: string[]) {
    rmSync(out, { recursive: true, force: true });
    const result = spawnSync(process.execPath, ["src/run.ts", "--corpus", corpus, "--cases", manifest,
      "--mode", "official", "--adapter", "checker-batch", "--expectation-source", "official-baseline", "--tsc", tsVersion,
      "--out", out, "--report-out", out, ...extra], {
      cwd: root,
      env: { PATH: process.env.PATH, CHECKER_BATCH_BIN: bin },
      encoding: "utf8", timeout: 15_000,
    });
    if (!existsSync(join(out, "metrics.json"))) throw new Error(result.error?.message ?? result.stderr ?? result.stdout);
    return {
      status: result.status, stdout: result.stdout, stderr: result.stderr,
      metrics: JSON.parse(readFileSync(join(out, "metrics.json"), "utf8")) as Metrics,
      details: JSON.parse(readFileSync(join(out, "details.json"), "utf8")) as Record<string, unknown>[],
      markdown: readFileSync(join(out, "report.md"), "utf8"),
      html: readFileSync(join(out, "report.html"), "utf8"),
    };
  }
  return { dir, corpus, manifest, ratchet, run };
}

const worker = (init: string, onCheck: string) => `
import { createInterface } from "node:readline";
const emit = (message) => console.log(JSON.stringify({ protocol: 1, ...message }));
${init}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === "shutdown") break;
  if (request.type !== "check") continue;
  const send = (message) => emit({ type: "result", id: request.id, ...message });
  ${onCheck}
}
`;
const cleanResult = `send({ status: "ok", diagnostics: [], fullText: "" });`;

test("legacy checker-batch keeps results, remains ineligible and cannot initialize a ratchet", () => {
  const f = fixture(worker(`emit({ type: "hello", implementation: { name: "legacy fixture" } });`, cleanResult));
  const run = f.run("--ratchet", f.ratchet, "--ratchet-init");
  expect(run.status).toBe(0);
  expect(run.metrics.totals).toMatchObject({ ran: 1, skipped: 0 });
  expect(run.metrics.comparison.compatibility.pass).toBe(1);
  expect(run.metrics.meta.verdictEligible).toBe(false);
  expect(run.metrics.meta.optionAssessment).toMatchObject({
    negotiation: "legacy", basis: "legacy-batch", gateAuthorized: false, ratchetWriteAuthorized: false,
  });
  expect(run.metrics.meta.ratchet).toMatchObject({ wrote: false, initialized: false });
  expect(existsSync(f.ratchet)).toBe(false);
  expect(f.run("--gate").status).toBe(1);
  const fixed = f.run("--mode", "fixed");
  expect(fixed.status).toBe(0);
  expect(fixed.metrics.meta.verdictEligible).toBe(false);
  expect(fixed.metrics.meta.optionAssessment?.basis).toBe("fixed-mode");
});

test("static official adapter retains its gate and ratchet permissions", () => {
  const f = fixture(worker("", cleanResult));
  const gate = f.run("--adapter", "none", "--gate");
  expect(gate.status).toBe(0);
  expect(gate.metrics.meta.verdictEligible).toBe(true);
  expect(gate.metrics.meta.gate?.passed).toBe(true);
  expect(gate.metrics.meta.optionAssessment).toBeUndefined();
  expect(gate.metrics.optionCoverage).toBeUndefined();
  const run = f.run("--adapter", "none", "--ratchet", f.ratchet, "--ratchet-init");
  expect(run.status).toBe(0);
  expect(run.metrics.meta.ratchet?.wrote).toBe(true);
  expect(existsSync(f.ratchet)).toBe(true);
});

test("assessment freezes adapter evidence; failed, pending and unsuccessful subset claims stay ineligible", () => {
  const capabilities = { supportsOptions: true, supportedOptions: ["strict"], responseFields: [], version: "fixture-1" };
  const batchImplementation = { name: "declared" };
  let negotiation: OptionNegotiation = "pending";
  let supportsOptions = false;
  const adapter = {
    name: "checker-batch", kind: "batch" as const, capabilities, batchImplementation,
    get optionNegotiation() { return negotiation; },
    get supportsOptions() { return supportsOptions; },
    async check() { throw new Error("unused"); },
  } satisfies Adapter;
  const evidence = { compared: 1, negotiatedComparisons: 1, candidateOverrideComparisons: 0 };
  const finalize = (overrides: Partial<typeof evidence> = {}) => finalizeOptionAssessment("official", adapter, { ...evidence, ...overrides }).assessment!;
  expect(finalize().basis).toBe("negotiation-pending");
  negotiation = "negotiated";
  expect(finalize().basis).toBe("negotiated-no-option-support");
  supportsOptions = true;
  expect(finalize({ compared: 0, negotiatedComparisons: 0 }).basis).toBe("negotiated-no-comparisons");
  expect(finalize({ negotiatedComparisons: 0 }).basis).toBe("negotiated-mixed-comparisons");
  expect(finalize({ candidateOverrideComparisons: 1 }).basis).toBe("candidate-option-overrides");
  const snapshot = finalize();
  negotiation = "failed";
  capabilities.supportedOptions.push("changed");
  batchImplementation.name = "changed";
  expect(finalize().basis).toBe("negotiation-failed");
  expect(snapshot).toMatchObject({ negotiation: "negotiated", capabilities: { supportedOptions: ["strict"] },
    batchImplementation: { name: "declared" }, comparedSubsetEligible: true, gateAuthorized: false, ratchetWriteAuthorized: false });
  expect(finalizeOptionAssessment("fixed", adapter, evidence).policy).toMatchObject({
    basis: "fixed-mode", comparedSubsetEligible: false, gateAuthorized: false, ratchetWriteAuthorized: false,
  });
});

test("negotiated report labels subset evidence; old reports keep their original eligibility wording", () => {
  const meta = { mode: "official", verdictEligible: true };
  const current = generateReport({ metrics: { meta: { ...meta, optionAssessment: {
    negotiation: "negotiated", basis: "negotiated-compared-subset", comparedSubsetEligible: true,
  } }, optionCoverage: { compared: 1, rejected: 1, byCategory: [["unsupported-value", 1]] } }, details: [] });
  for (const output of [current.markdown, current.html]) {
    expect(output).toContain("仅已比较子集可作本地兼容性证据");
    expect(output).toContain("选项协商不授权门禁或回归记录写回");
    expect(output).toContain("不进入比较分母");
    expect(output).toContain("unsupported-value");
  }
  const previous = generateReport({ metrics: { meta }, details: [] });
  expect(previous.html).toContain("（可作兼容性结论）");
  expect(previous.html).not.toContain("选项拒绝");
});


test("structured rejections stay out of both verdict and diagnostic denominators", () => {
  const meta: RunMeta = {
    suite: "synthetic", corpus: "/synthetic", adapter: "checker-batch", mode: "official",
    verdictEligible: true, tscVersion: "6.0.3", tscBin: "reference-fixture", generatedAt: "2026-11-28T00:00:00Z", selectedCases: 4,
  };
  const rejected = (id: string, kind: "unsupported-option" | "unsupported-value") => ({
    ...skipRecord(id, `选项拒绝：${kind}`, ["suite:compiler"]),
    // The reference produced a diagnostic, but there is no candidate result.
    expected: [{ file: "a.ts", line: 0, col: 0, code: 9999, severity: "error" as const }],
    optionRejection: { kind, source: "preflight" as const, reason: "synthetic", args: ["--strict", "false"], options: [] },
  });
  const m = summarize([
    compareCase("accepted", [], [], ["suite:compiler"], null, ""),
    rejected("rejected-one", "unsupported-value"), rejected("rejected-two", "unsupported-option"),
    skipRecord("unrelated", "excluded"),
  ], meta);
  expect(m.optionCoverage).toEqual({ compared: 1, rejected: 2, byCategory: [["unsupported-option", 1], ["unsupported-value", 1]] });
  expect(m.totals).toMatchObject({ cases: 4, ran: 1, skipped: 3, passCases: 1, expectTotal: 0, missTotal: 0, coverage: null });
  expect(m.byClass["suite:compiler"]).toMatchObject({ cases: 3, ran: 1, skipped: 2, expectTotal: 0 });
  expect(m.comparison.compatibility).toEqual({ pass: 1, fail: 0, unknown: 0 });
});

const negotiatedCapabilities = { supportsOptions: true, supportedOptions: ["strict", "target"], responseFields: ["fullText"], version: "fixture-v1" };
const lazyDeclaration = `send({ status: "ok", diagnostics: [], fullText: "", capabilities: ${JSON.stringify(negotiatedCapabilities)} });`;

const eulerWorker = (mode: WorkerMode) => `import { runWorker } from ${JSON.stringify(join(import.meta.dir, "fixtures/batch-options-worker.ts"))};
await runWorker(${JSON.stringify(mode)});`;

test("Euler's first-result worker: repeatable official subset, fixed reason, and no gate/writeback authorization", () => {
  const f = fixture(eulerWorker("first-result"));
  writeFileSync(join(f.corpus, "compiler/clean.ts"), `// @strict: false\n${strictSource}`);
  writeFileSync(join(f.corpus, "compiler/rejected.ts"), `// @module: esnext\n${strictSource}`);
  writeFileSync(join(f.dir, "tests/baselines/reference/compiler/rejected.errors.txt"),
    "rejected.ts(1,7): error TS2322: synthetic reference diagnostic\n====\n");
  writeFileSync(f.manifest, JSON.stringify(["compiler/clean.ts", "compiler/rejected.ts"]));
  const run = f.run("--ratchet", f.ratchet, "--ratchet-init");
  expect(run.status).toBe(0);
  expect(run.metrics.meta.verdictEligible).toBe(true);
  expect(run.metrics.meta.optionAssessment).toMatchObject({ negotiation: "negotiated", capabilities: {
    ...eulerCapabilities, responseFields: [...eulerCapabilities.responseFields].sort(),
  }, basis: "negotiated-compared-subset", negotiatedComparisons: 1, gateAuthorized: false, ratchetWriteAuthorized: false });
  expect(run.metrics.optionCoverage).toEqual({ compared: 1, rejected: 1, byCategory: [["unsupported-option", 1]] });
  expect(run.metrics.totals).toMatchObject({ cases: 2, ran: 1, skipped: 1, expectTotal: 0 });
  expect(run.metrics.comparison.compatibility).toEqual({ pass: 1, fail: 0, unknown: 0 });
  expect(run.metrics.comparison.strict).toEqual({ pass: 0, fail: 0, unknown: 1 });
  expect(run.metrics.meta.executionFailures).toEqual([]);
  expect(run.details[0]).toMatchObject({ id: "compiler/clean.ts", status: "ran", actual: [], actualOutput: null });
  expect(run.details[1]).toMatchObject({ id: "compiler/rejected.ts", status: "skip", comparison: null, actual: null,
    expected: [expect.objectContaining({ code: 2322 })], optionRejection: {
      kind: "unsupported-option", source: "preflight", option: { name: "module", value: "esnext" },
      args: ["--module", "esnext"], options: [{ name: "module", value: "esnext" }],
    } });
  expect(run.markdown).toContain("仅已比较子集可作本地兼容性证据");
  expect(existsSync(f.ratchet)).toBe(false);
  const repeat = f.run("--ratchet", f.ratchet, "--ratchet-init");
  const withoutTime = (m: Metrics) => ({ ...m, meta: { ...m.meta, generatedAt: undefined } });
  expect(repeat.status).toBe(0);
  expect(repeat.details).toEqual(run.details);
  expect(withoutTime(repeat.metrics)).toEqual(withoutTime(run.metrics));
  expect(repeat.markdown.replaceAll(repeat.metrics.meta.generatedAt, run.metrics.meta.generatedAt)).toBe(run.markdown);
  expect(repeat.html.replaceAll(repeat.metrics.meta.generatedAt, run.metrics.meta.generatedAt)).toBe(run.html);

  const fixed = f.run("--mode", "fixed");
  expect(fixed.status).toBe(0);
  expect(fixed.metrics.meta.verdictEligible).toBe(false);
  expect(fixed.metrics.meta.optionAssessment?.basis).toBe("fixed-mode");
  expect(fixed.markdown).toContain("fixed 模式只验证调用流水线");
  expect(fixed.details[0]?.options).toContainEqual({ name: "strict", value: true });

  const gate = f.run("--gate");
  expect(gate.status).toBe(1);
  expect(gate.metrics.meta.verdictEligible).toBe(true);
  expect(gate.metrics.meta.gate?.checks).toContainEqual({ name: "口径", ok: false,
    detail: expect.stringContaining("不授权门禁") });
  expect(existsSync(f.ratchet)).toBe(false);
});

test("negotiated non-support, candidate-only overrides, and no compared cases cannot qualify", () => {
  const noSupport = fixture(worker("", `send({ status: "ok", diagnostics: [], capabilities: ${JSON.stringify({
    ...negotiatedCapabilities, supportsOptions: false, supportedOptions: [],
  })} });`)).run();
  expect(noSupport.metrics.meta.verdictEligible).toBe(false);
  expect(noSupport.metrics.meta.optionAssessment?.basis).toBe("negotiated-no-option-support");

  const f = fixture(worker("", lazyDeclaration));
  const override = f.run("--adapter-arg", "target=es2020");
  expect(override.metrics.meta.verdictEligible).toBe(false);
  expect(override.metrics.meta.optionAssessment).toMatchObject({ basis: "candidate-option-overrides", candidateOverrideComparisons: 1 });
  expect(override.markdown).toContain("仅供对照实验");
  writeFileSync(join(f.corpus, "compiler/clean.ts"), "// @module: esnext\nexport {};\n");
  const rejected = f.run();
  expect(rejected.metrics.meta.verdictEligible).toBe(false);
  expect(rejected.metrics.meta.optionAssessment?.basis).toBe("negotiated-no-comparisons");
  expect(rejected.metrics.optionCoverage).toMatchObject({ compared: 0, rejected: 1 });
  expect(rejected.details[0]).toMatchObject({ actual: null, optionRejection: { source: "unchecked-result" } });
});
