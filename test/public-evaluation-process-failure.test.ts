import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { baseline, buildPlanForIds, verifyShard } from "../scripts/full-compatibility.ts";
import { validPublicExecutionFailure, verifyPublicShardCases } from "../scripts/public-evaluation-failures.ts";
import { BunCheckAdapter } from "../src/adapters/bun-check.ts";
import { TscCliAdapter } from "../src/adapters/tsc-cli.ts";
import { processFailure } from "../src/adapters/process-failure.ts";
import { REPO_ROOT } from "../src/baselines.ts";

const input = { id: "compiler/fixture.ts", files: [{ path: "fixture.ts", text: "export {};" }], options: [], args: [] };

test("process evidence requires an actual timeout code, fatal signal or abnormal exit", () => {
  const base: SpawnSyncReturns<string> = {
    stdout: "ETIMEDOUT SIGABRT", stderr: "timed out", output: [], pid: 10, status: null, signal: null,
  };
  const error = (code: string) => Object.assign(new Error("timed out"), { code });
  expect(processFailure({ ...base, error: error("ETIMEDOUT"), signal: "SIGTERM" }, 2))
    .toEqual({ kind: "deadline", errorCode: "ETIMEDOUT", signal: "SIGTERM" });
  const timedOutExit = processFailure({ ...base, error: error("ETIMEDOUT"), status: 0 }, 2);
  expect(timedOutExit).toEqual({ kind: "deadline", errorCode: "ETIMEDOUT", signal: null, exitCode: 0 });
  expect(validPublicExecutionFailure({ id: input.id, status: "timeout", process: timedOutExit }, "tsc-cli")).toBe(true);
  expect(validPublicExecutionFailure({ id: input.id, status: "timeout", process: { ...timedOutExit, exitCode: -1 } }, "tsc-cli")).toBe(false);
  expect(processFailure({ ...base, signal: "SIGABRT" }, 2)).toEqual({ kind: "signal", signal: "SIGABRT" });
  expect(processFailure({ ...base, status: 42 }, 2)).toEqual({ kind: "exit", exitCode: 42 });
  for (const result of [base, { ...base, status: 2 }, { ...base, status: 127 }, { ...base, signal: "SIGKILL" as const },
    { ...base, error: error("ETIMEDOUT") }, { ...base, error: error("ENOENT") }, { ...base, error: error("EACCES") },
    { ...base, signal: "SIGKILL" as const, error: error("ENOBUFS") }]) {
    expect(processFailure(result, 2)).toBeUndefined();
  }
});

test("both public adapters classify controlled abnormal exits before output text and reject launch/collection faults as evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsc-public-process-fixture-"));
  try {
    const bin = join(root, "synthetic");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "tsconfig.json(1,1): error TS5108: ETIMEDOUT timed out" >&2\nexit 42\n', { mode: 0o755 });
    for (const Adapter of [TscCliAdapter, BunCheckAdapter]) {
      const abnormal = await new Adapter({ bin }).check(input);
      expect(abnormal).toMatchObject({ status: "crash", exitCode: 42, processFailure: { kind: "exit", exitCode: 42 } });
      const missing = await new Adapter({ bin: `${bin}-missing` }).check(input);
      expect(missing.status).toBe("crash");
      expect(missing.processFailure).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("both public adapters enforce a hard deadline when the child handles or ignores SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsc-public-deadline-fixture-"));
  try {
    const timeoutMs = 800;
    const bin = join(root, "synthetic");
    for (const handler of ["exit 0", ""]) {
      // Built-ins only: no orphan subprocesses. The loop is bounded so a
      // timeout regression fails the test without leaving a stuck child.
      writeFileSync(bin, `#!/bin/bash
trap '${handler}' TERM
printf 'ready\\n'
SECONDS=0
while [ "$SECONDS" -lt 4 ]; do :; done
exit 17
`, { mode: 0o755 });
      if (handler !== "") {
        const soft = spawnSync(bin, [], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGTERM" });
        expect(soft.stdout).toBe("ready\n");
        expect(soft.status).toBe(0);
        expect(processFailure(soft, 2)).toEqual({ kind: "deadline", errorCode: "ETIMEDOUT", signal: null, exitCode: 0 });
      }
      for (const Adapter of [TscCliAdapter, BunCheckAdapter]) {
        const outcome = await new Adapter({ bin, timeoutMs }).check(input);
        expect(outcome).toMatchObject({ status: "timeout", exitCode: null, rawOutput: { stdout: "ready\n" },
          processFailure: { kind: "deadline", errorCode: "ETIMEDOUT", signal: "SIGKILL" } });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("runner continues to the next synthetic case and emits verified per-case subprocess evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "tsc-public-runner-fixture-"));
  try {
    const corpus = join(root, "tests/cases");
    const out = join(root, "out");
    mkdirSync(join(corpus, "compiler"), { recursive: true });
    mkdirSync(join(root, "tests/baselines/reference/compiler"), { recursive: true });
    mkdirSync(out);
    const ids = ["compiler/syntheticExit.ts", "compiler/syntheticClean.ts"];
    for (const id of ids) writeFileSync(join(corpus, id), "export {};\n");
    const manifest = join(out, "cases.json");
    writeFileSync(manifest, JSON.stringify(ids));
    const bin = join(root, "synthetic");
    writeFileSync(bin, '#!/bin/sh\nfor arg do\n  case "$arg" in *syntheticExit.ts) exit 42;; esac\ndone\nexit 0\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, ["src/run.ts", "--baseline", baseline, "--corpus", corpus, "--cases", manifest,
      "--expectation-source", "official-baseline", "--option-strategy", "aligned", "--adapter", `tsc-cli:${bin}`, "--out", out],
    { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const { meta } = JSON.parse(readFileSync(join(out, "metrics.json"), "utf8"));
    const plan = buildPlanForIds(corpus, meta.corpusRef, 1, "official-baseline", ["typescript"], ids);
    // The real planner sorts within each shard. Keep this manifest in execution
    // order to specifically prove a case runs after an earlier failure.
    plan.shards[0]!.units.reverse();
    const metrics = verifyShard(plan, plan.shards[0]!, out, "typescript");
    expect(metrics.totals).toMatchObject({ ran: 1, skipped: 1 });
    expect(metrics.comparison.compatibility).toEqual({ pass: 1, fail: 0, unknown: 0 });
    expect(verifyPublicShardCases(metrics, out)).toEqual({ failures: [
      { id: ids[0], status: "crash", process: { kind: "exit", exitCode: 42 } },
    ], differences: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
