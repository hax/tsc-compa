// 真实项目相位计时的纯函数测试：相位解析、诊断计数、实现 spec 解析。

import { expect, test } from "bun:test";
import {
  countDiagnostics,
  formatProjectBenchSummary,
  invocationFor,
  parseImplSpec,
  parsePhases,
} from "../src/bench-project.ts";

const TSC_OUTPUT = [
  "Files:              18",
  "Parse time:     0.032s",
  "Bind time:      0.010s",
  "Check time:     0.161s",
  "Emit time:      0.000s",
  "Total time:     0.207s",
].join("\n");

test("parsePhases 解析 extendedDiagnostics 的秒数并转毫秒", () => {
  const phases = parsePhases(TSC_OUTPUT);
  expect(phases).not.toBeNull();
  expect(phases!.parseMs).toBe(32);
  expect(phases!.bindMs).toBe(10);
  expect(phases!.checkMs).toBe(161);
  expect(phases!.totalMs).toBe(207);
  expect(phases!.startMs).toBeUndefined();
});

test("parsePhases 对没有相位输出的实现返回 null", () => {
  expect(parsePhases("src/a.ts:1:2: error TS2322: nope")).toBeNull();
});

test("countDiagnostics 只数 error TS 行", () => {
  const out = [
    "a.ts:1:2: error TS2322: x",
    "a.ts:2:3: error TS2322: y",
    "b.ts:1:1: warning TS9999: w",
    "unrelated line",
  ].join("\n");
  expect(countDiagnostics(out)).toBe(2);
});

test("parseImplSpec 支持 kind:bin 与 ::extra 附加参数", () => {
  expect(parseImplSpec("tsc:node_modules/typescript-7-1/bin/tsc")).toEqual({
    kind: "tsc",
    bin: "node_modules/typescript-7-1/bin/tsc",
    extraArgs: [],
  });
  expect(parseImplSpec("maat:/opt/maat::--noMessages")).toEqual({
    kind: "maat",
    bin: "/opt/maat",
    extraArgs: ["--noMessages"],
  });
  expect(() => parseImplSpec("nope:/bin/x")).toThrow();
});

test("invocationFor 不把兼容性套件的参数带进项目检查", () => {
  const tscArgs = invocationFor("tsc", "/proj");
  expect(tscArgs).toContain("--extendedDiagnostics");
  expect(tscArgs).toContain("/proj");
  expect(tscArgs.includes("--ignoreConfig")).toBe(false);
  const maatArgs = invocationFor("maat", "/proj");
  expect(maatArgs).toEqual(["--project=/proj"]);
});

test("formatProjectBenchSummary 标注相位来源与不可横比", () => {
  const report = {
    meta: {
      suite: "bench-project" as const,
      schema: 1 as const,
      project: "/proj",
      reps: 2,
      generatedAt: "2026-11-15T00:00:00.000Z",
      headlineMetric: "check phase (auto-reported) / wall fallback" as const,
      cacheTiers: "cold = run #1; warm = median of runs #2..N" as const,
      note: "n",
    },
    implementations: [
      {
        spec: "tsc:bin",
        kind: "tsc" as const,
        bin: "bin",
        phaseSource: "extendedDiagnostics" as const,
        includesRendering: false,
        args: [],
        diagnostics: 3,
        runs: [],
        cold: { wallMs: 10, phases: null, diagnostics: 3, exitStatus: 0 },
        warm: { wallMs: 8, checkMs: 5 },
        checkMs: 5,
        totalMs: 8,
        startupMs: 1,
      },
    ],
  };
  const text = formatProjectBenchSummary(report);
  expect(text).toContain("Check ms");
  expect(text).toContain("wall-fallback");
});
