import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BatchAdapter } from "../src/adapters/batch.ts";
import { toTscArgs } from "../src/case.ts";
import type { CaseInput, CompilerOptions } from "../src/types.ts";
import { capabilities, rejectionCode, strictSource, targetSource, type WorkerMode } from "./fixtures/batch-options-worker.ts";

const root = join(import.meta.dir, "..");
const worker = join(import.meta.dir, "fixtures", "batch-options-worker.ts");
const makeInput = (id: string, text: string, options: CompilerOptions = [], baseArgs: string[] = []): CaseInput =>
  ({ id, files: [{ path: "a.ts", text }], options, args: toTscArgs(options, baseArgs) });
const frame = (input: CaseInput) => ({ protocol: 1, type: "check", ...input });
const shutdown = { protocol: 1, type: "shutdown" };

function transcript(mode: WorkerMode, ...requests: ReadonlyArray<CaseInput>) {
  const result = spawnSync(process.execPath, [worker, mode, "--batch"], {
    input: [...requests.map(frame), shutdown].map(row => JSON.stringify(row)).join("\n") + "\n",
    encoding: "utf8", timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

const diagnostic = (code: number) => ({ file: "a.ts", line: 0, col: 6, code, severity: "error" });

test("legacy peer accepts the existing v1 array envelope, and rejects a novel client frame or object options", () => {
  const input = makeInput("old", strictSource, [{ name: "strict", value: false }, { name: "lib", value: ["es2020"] }], ["--types", ""]);
  expect(transcript("legacy", input)).toEqual([
    { protocol: 1, type: "result", id: input.id, status: "ok", diagnostics: [diagnostic(2322)] },
  ]);
  for (const invalid of [
    { protocol: 1, type: "hello" },
    { ...frame(input), options: { strict: false } },
  ]) {
    const result = spawnSync(process.execPath, [worker, "legacy", "--batch"], {
      input: `${JSON.stringify(invalid)}\n`, encoding: "utf8", timeout: 5_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected v1 check with options array and args, or shutdown");
  }
});

test.each(["hello", "first-result"] as const)("%s advertises on the expected frame and handles request-local option changes", (mode) => {
  const inputs = [
    ...[true, false, true].map((value, i) => makeInput(`strict-${i}`, strictSource, [{ name: "strict", value }], ["--strict", "true"])),
    ...["es2015", "es2020", "es2015"].map((value, i) => makeInput(`target-${i}`, targetSource, [{ name: "target", value }])),
  ];
  const output = transcript(mode, ...inputs);
  const hello = mode === "hello" ? output.shift() : undefined;
  if (mode === "hello") expect(hello).toMatchObject({ protocol: 1, type: "hello", capabilities });
  expect(output.map(({ id }) => id)).toEqual(inputs.map(({ id }) => id));
  expect(output.map(({ status }) => status)).toEqual(inputs.map(() => "ok"));
  expect(output.map(row => row.capabilities)).toEqual(inputs.map((_, i) => mode === "first-result" && i === 0 ? capabilities : undefined));
  expect(output.map(row => row.diagnostics)).toEqual([[diagnostic(2322)], [], [diagnostic(2322)], [diagnostic(2737)], [], [diagnostic(2737)]]);
  expect(output.every(row => !Object.hasOwn(row, "fullText"))).toBe(true);
});

test("unsupported inherited flags and unsupported values carry exact names and values", () => {
  const inputs = [
    makeInput("module", "export {};\n", [], ["--module", "esnext"]),
    makeInput("skip-lib", "export {};\n", [], ["--skipLibCheck", "false"]),
    makeInput("skip-default-lib", "export {};\n", [{ name: "skipDefaultLibCheck", value: true }]),
    makeInput("target-value", targetSource, [{ name: "target", value: "es5" }]),
  ];
  const results = transcript("first-result", ...inputs, makeInput("next", targetSource, [{ name: "target", value: "es2015" }]));
  expect(results.slice(0, 4).map(({ id, status, errorCode, option, diagnostics }) => ({ id, status, errorCode, option, diagnostics }))).toEqual([
    ["module", "module", "esnext"], ["skip-lib", "skipLibCheck", "false"], ["skip-default-lib", "skipDefaultLibCheck", true], ["target-value", "target", "es5"],
  ].map(([id, name, value]) => ({ id, status: "skip", errorCode: rejectionCode, option: { name, value }, diagnostics: [] })));
  expect(results[4]).toMatchObject({ id: "next", status: "ok", diagnostics: [diagnostic(2737)] });
});

test("fixture supplies deceptive ok, unrecognized rejection, wrong status, and conflicting declaration frames", () => {
  const unsupported = makeInput("unlisted", "export {};\n", [{ name: "module", value: "esnext" }]);
  const bad = transcript("bad-ok", unsupported, makeInput("next", strictSource, [{ name: "strict", value: true }]));
  expect(bad[0]).toEqual({
    protocol: 1, type: "result", id: "unlisted", status: "ok", diagnostics: [], capabilities,
  });
  expect(bad[1]).toEqual({ protocol: 1, type: "result", id: "next", status: "ok", diagnostics: [diagnostic(2322)] });
  expect(transcript("unknown-code", unsupported)[0]).toMatchObject({ status: "skip", errorCode: "unsupported-option-typo" });
  expect(transcript("wrong-status", unsupported)[0]).toMatchObject({ status: "ok", errorCode: rejectionCode });
  const changes = transcript("changed", makeInput("first", "export {};\n"), makeInput("second", "export {};\n"));
  expect(changes[0].capabilities).toEqual(capabilities);
  expect(changes[1].capabilities.supportedOptions).toEqual(["strict", "target", "module"]);
});

test("only unmatched and expired results carry capabilities in the adverse transcripts", () => {
  const first = makeInput("first", strictSource, [{ name: "strict", value: true }]);
  const second = makeInput("second", strictSource, [{ name: "strict", value: false }]);
  const unmatched = transcript("unmatched", first);
  expect(unmatched[0]).toMatchObject({ id: "first:not-pending", capabilities });
  expect(unmatched[1].id).toBe(first.id);
  expect(unmatched[1]).not.toHaveProperty("capabilities");
  expect(transcript("late", first)).toEqual([]); // No result until the client sends another check.
  const late = transcript("late", first, second);
  expect(late[0]).toMatchObject({ id: "first", capabilities });
  expect(late[1].id).toBe(second.id);
  expect(late[1]).not.toHaveProperty("capabilities");
});

test.each(["unmatched", "late"] as const)("current v1 client correlates results in the %s scenario", async (mode) => {
  const adapter = new BatchAdapter({ name: "synthetic", command: process.execPath, args: [worker, mode, "--batch"], timeoutMs: 500, supportsOptions: false });
  try {
    const first = await adapter.check(makeInput("first", strictSource, [{ name: "strict", value: true }]));
    if (mode === "late") expect(first).toMatchObject({ id: "first", status: "timeout", diagnostics: [] });
    else expect(first).toMatchObject({ id: "first", status: "ok", diagnostics: [diagnostic(2322)] });
    expect(await adapter.check(makeInput("second", strictSource, [{ name: "strict", value: false }]))).toMatchObject({
      id: "second", status: "ok", diagnostics: [],
    });
  } finally {
    await adapter.close();
  }
});

test("legacy checker-batch official uses the case directive; fixed uses the preset and remains report-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-batch-legacy-contract-"));
  try {
    const corpus = join(dir, "tests", "cases");
    mkdirSync(join(corpus, "compiler"), { recursive: true });
    writeFileSync(join(corpus, "compiler", "sample.ts"), `// @strict: false\n${strictSource}`);
    const cases = join(dir, "cases.json");
    writeFileSync(cases, JSON.stringify(["compiler/sample.ts"]));
    const executable = join(dir, "checker");
    writeFileSync(executable, `#!${process.execPath}\nimport {runWorker} from ${JSON.stringify(worker)};\nawait runWorker("legacy");\n`, { mode: 0o755 });
    // A tiny reference command makes the runner test independent of the TS distribution.
    const reference = join(dir, "reference");
    writeFileSync(reference, `#!${process.execPath}
import {basename} from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) console.log("Version 6.0.3");
else if (args[args.lastIndexOf("--strict") + 1] === "true") {
  console.log(basename(args.at(-1)) + "(1,7): error TS2322: synthetic strict diagnostic");
  process.exitCode = 2;
}
`, { mode: 0o755 });
    for (const [mode, strict, verdict] of [["official", false, "fail"], ["fixed", true, "pass"]] as const) {
      const out = join(dir, mode);
      const result = spawnSync(process.execPath, [join(root, "src/run.ts"), "--corpus", corpus, "--cases", cases,
        "--tsc", reference, "--adapter", "checker-batch", "--mode", mode,
        "--out", out, "--report-out", out], {
        cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, CHECKER_BATCH_BIN: executable },
        encoding: "utf8", timeout: 12_000,
      });
      expect(result.error).toBeUndefined();
      if (result.status !== 0) throw new Error(`${mode} runner failed (${result.status}): ${result.stderr}\n${result.stdout}`);
      const metrics = JSON.parse(readFileSync(join(out, "metrics.json"), "utf8"));
      expect(metrics.meta).toMatchObject({ adapter: "checker-batch", mode, verdictEligible: false, expectationSource: "tsc", options: { strategy: "defaults" } });
      const [detail] = JSON.parse(readFileSync(join(out, "details.json"), "utf8"));
      expect(detail.options).toContainEqual({ name: "strict", value: strict });
      expect(detail.expected.map((d: { code: number }) => d.code)).toEqual(strict ? [2322] : []);
      expect(detail.actual.map((d: { code: number }) => d.code)).toEqual([2322]);
      expect(detail.comparison.compatibility).toBe(verdict);
      expect(detail.comparison.strict).toBe(strict ? "unknown" : "fail");
      expect(readFileSync(join(out, "report.md"), "utf8")).toContain("不可作兼容性结论");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
