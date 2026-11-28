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

function negotiatedWorker(mode: WorkerMode, timeoutMs = 3_000) {
  return new BatchAdapter({ name: "synthetic", command: process.execPath, args: [worker, mode, "--batch"], timeoutMs, negotiateOptions: true });
}

const emptyOptionsCase = (id: string) => makeInput(id, "export {};\n");
const unsupportedModule = (id: string) => makeInput(id, "export {};\n", [], ["--module", "esnext"]);
const strict = (id: string, value: boolean) => makeInput(id, strictSource, [{ name: "strict", value }]);

test.each(["first-result", "hello", "top-hello"] as const)("negotiates %s with the unchanged v1 request and exposes the frozen support flag", async mode => {
  const adapter = negotiatedWorker(mode);
  try {
    expect(adapter.optionNegotiation).toBe("pending");
    expect(adapter.supportsOptions).toBe(false);
    const outcomes = await Promise.all([adapter.check(strict("a", true)), adapter.check(strict("b", false)), adapter.check(strict("c", true))]);
    expect(outcomes.map(({ status, diagnostics }) => [status, diagnostics.map(d => d.code)])).toEqual([["ok", [2322]], ["ok", []], ["ok", [2322]]]);
    expect(adapter.optionNegotiation).toBe("negotiated");
    expect(adapter.supportsOptions).toBe(true);
    expect(adapter.capabilities).toEqual({ ...capabilities, responseFields: [...capabilities.responseFields].sort() });
    expect(Object.isFrozen(adapter.capabilities!.supportedOptions)).toBe(true);
    expect(adapter.batchImplementation?.version).toBe(mode === "hello" ? "display-2" : undefined);
    expect(outcomes[0]?.diagnostics[0]?.message).toBeUndefined();
    expect(outcomes[0]?.fullText).toBeUndefined();
    const targetModes = await Promise.all(["es2015", "es2020", "es2015"].map((value, i) =>
      adapter.check(makeInput(`target-${i}`, targetSource, [{ name: "target", value }]))));
    expect(targetModes.map(r => r.diagnostics.map(d => d.code))).toEqual([[2737], [], [2737]]);
  } finally { await adapter.close(); }
});

test("first deceptively clean result and later unsafe requests are rejected without discarding option evidence", async () => {
  const adapter = negotiatedWorker("bad-ok");
  try {
    const first = unsupportedModule("first");
    expect(await adapter.check(first)).toMatchObject({ id: first.id, status: "skip", diagnostics: [], optionRejection: {
      kind: "unsupported-option", source: "unchecked-result", option: { name: "module", value: "esnext" }, args: first.args, options: first.options,
    } });
    expect(adapter.optionNegotiation).toBe("negotiated");
    for (const [name, args, value] of [
      ["moduleResolution", ["--moduleResolution", "nodenext"], "nodenext"],
      ["skipLibCheck", ["--skipLibCheck", "false"], false],
      ["skipDefaultLibCheck", ["--skipDefaultLibCheck"], true],
      ["types", ["--types", ""], []],
    ] as const) {
      const input = makeInput(name, "export {};\n", [], [...args]);
      expect(await adapter.check(input)).toMatchObject({ status: "skip", optionRejection: {
        kind: "unsupported-option", source: "preflight", option: { name, value }, args: input.args,
      } });
    }
    for (const args of [["--foo", "true"], ["--target=es2026"], ["-t", "es2026"], ["--TARGET", "es2026"],
      ["--strict", "TRUE"], ["--target"], ["@options.rsp"], ["input.ts"]]) {
      expect(await adapter.check(makeInput("ambiguous", "export {};\n", [], args))).toMatchObject({ status: "skip", optionRejection: {
        kind: "unrecognized-argument", source: "preflight", args,
      } });
    }
    expect(await adapter.check({ ...strict("disagreement", false), args: ["--strict", "true"] })).toMatchObject({ status: "skip", optionRejection: {
      kind: "unrecognized-argument", option: { name: "strict", value: false },
    } });
    expect(await adapter.check(strict("next", true))).toMatchObject({ status: "ok", diagnostics: [diagnostic(2322)] });
    // The fixture's deceptive mode returns clean for a target it cannot handle.
    // The adapter must not impose a TS6 enum on TS7 string inputs; the normal
    // worker version of the fixture exercises explicit value rejection below.
    expect(await adapter.check(makeInput("ts7-value", targetSource, [{ name: "target", value: "es2026" }]))).toMatchObject({ status: "ok" });
  } finally { await adapter.close(); }
});

test("accepts documented camelCase skip and explicit error alias; does not read option names from text", async () => {
  const camel = negotiatedWorker("camel-rejection");
  const alias = negotiatedWorker("error-alias");
  try {
    const input = unsupportedModule("rejected");
    expect(await camel.check(input)).toMatchObject({ status: "skip", optionRejection: {
      source: "worker", kind: "unsupported-option", errorCode: "unsupportedOption", reason: "Requested mode not implemented",
      option: { name: "module", value: "esnext" }, args: input.args, options: input.options,
    } });
    expect(camel.optionNegotiation).toBe("negotiated");
    const multiple = negotiatedWorker("camel-rejection");
    try {
      const outcome = await multiple.check(makeInput("ambiguous", "export {};\n", [], ["--module", "esnext", "--skipLibCheck"]));
      expect(outcome.optionRejection?.option).toBeUndefined();
      expect(outcome.optionRejection?.args).toEqual(["--module", "esnext", "--skipLibCheck"]);
    } finally { await multiple.close(); }
    const target = makeInput("unavailable", targetSource, [{ name: "target", value: "es2026" }]);
    expect(await alias.check(target)).toMatchObject({ status: "skip", optionRejection: {
      source: "worker", kind: "unsupported-value", errorCode: "unsupported-value", option: { name: "target", value: "es2026" },
      args: target.args, options: target.options,
    } });
  } finally { await Promise.all([camel.close(), alias.close()]); }
});

test.each(["unknown-code", "wrong-status", "malformed-result"] as const)("%s cannot qualify or masquerade as normal skip", async mode => {
  const adapter = negotiatedWorker(mode);
  try {
    const input = mode === "malformed-result" ? strict("malformed", true) : unsupportedModule("unlisted");
    const outcome = await adapter.check(input);
    expect(outcome).toMatchObject({ status: "crash", diagnostics: [] });
    expect(outcome.optionRejection).toBeUndefined();
    expect(adapter.optionNegotiation).toBe("failed");
    expect(adapter.capabilities).toBeUndefined();
  } finally { await adapter.close(); }
});

test.each(["unmatched", "late", "changed", "late-declaration", "legacy"] as const)("%s cannot promote a frozen or failed negotiation", async mode => {
  const adapter = negotiatedWorker(mode, 1_000);
  try {
    const timedOut = mode === "late";
    const declared = mode === "changed";
    const invalidSecond = declared || mode === "late-declaration";
    expect((await adapter.check(emptyOptionsCase("first"))).status).toBe(timedOut ? "timeout" : "ok");
    expect(adapter.optionNegotiation).toBe(timedOut ? "failed" : declared ? "negotiated" : "legacy");
    expect(adapter.supportsOptions).toBe(declared);
    expect((await adapter.check(emptyOptionsCase("second"))).status).toBe(invalidSecond ? "crash" : "ok");
    expect(adapter.optionNegotiation).toBe(timedOut || invalidSecond ? "failed" : "legacy");
    expect(adapter.capabilities?.supportedOptions).toEqual(declared ? ["strict", "target"] : undefined);
    expect(adapter.supportsOptions).toBe(false);
  } finally { await adapter.close(); }
});

// Unusual frames are easier to audit as literals than by extending the fixture's modes.
async function withOneReply(reply: Record<string, unknown>, check: (adapter: BatchAdapter) => Promise<void>) {
  const adapter = new BatchAdapter({ name: "literal-worker", command: process.execPath, negotiateOptions: true,
    args: ["-e", `import { createInterface } from "node:readline";
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.type === "shutdown") break;
        console.log(JSON.stringify({ protocol: 1, type: "result", id: request.id, ...${JSON.stringify(reply)} }));
      }`] });
  try { await check(adapter); } finally { await adapter.close(); }
}

test("identical reordered declarations are accepted; contradictory top and nested declarations are not", async () => {
  const reordered = { ...capabilities, supportedOptions: [...capabilities.supportedOptions].reverse() };
  await withOneReply({ status: "ok", diagnostics: [], ...capabilities, capabilities: reordered }, async adapter => {
    expect((await adapter.check(emptyOptionsCase("first"))).status).toBe("ok");
    expect((await adapter.check(emptyOptionsCase("second"))).status).toBe("ok");
    expect(adapter.supportsOptions).toBe(true);
  });
  await withOneReply({ status: "ok", diagnostics: [], ...capabilities, capabilities: { ...reordered, version: "different" } }, async adapter => {
    expect((await adapter.check(emptyOptionsCase("first"))).status).toBe("crash");
    expect(adapter.optionNegotiation).toBe("failed");
    expect(adapter.capabilities).toBeUndefined();
  });
});

test("empty option whitelist does not mean wildcard; a no-code old skip remains a skip", async () => {
  await withOneReply({ status: "ok", diagnostics: [], capabilities: { ...capabilities, supportedOptions: [] } }, async adapter => {
    const outcome = await adapter.check(strict("not-supported", true));
    expect(outcome.optionRejection).toMatchObject({ source: "unchecked-result", option: { name: "strict", value: true } });
  });
  await withOneReply({ status: "skip", skipReason: "ordinary skip" }, async adapter => {
    const outcome = await adapter.check(emptyOptionsCase("old-skip"));
    expect(outcome).toMatchObject({ status: "skip", skipReason: "ordinary skip" });
    expect(outcome.optionRejection).toBeUndefined();
    expect(adapter.optionNegotiation).toBe("legacy");
  });
});

test("announced diagnostic fields do not substitute for actual fields", async () => {
  const { severity: _severity, ...missing } = diagnostic(2322);
  await withOneReply({ status: "ok", diagnostics: [missing], capabilities }, async adapter => {
    expect((await adapter.check(strict("missing-severity", true))).status).toBe("crash");
    expect(adapter.supportsOptions).toBe(false);
    expect(adapter.capabilities).toBeUndefined();
  });
});
