import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/baselines.ts";
import { sha256 } from "../src/provenance.ts";

// 在候选冒烟任务中显式安装固定 SDK；常规单元测试不下载候选。
test.skipIf(process.env.TSC_COMPA_TEST_TSRS_ASYNC !== "1")("tsrs-async：独立后端、结构化诊断与报告来源", () => {
  const root = mkdtempSync(join(tmpdir(), "tsc-compa-tsrs-async-test-"));
  try {
    const corpus = join(root, "cases");
    const manifest = join(root, "cases.json");
    const out = join(root, "out");
    mkdirSync(join(corpus, "compiler"), { recursive: true });
    writeFileSync(manifest, JSON.stringify(["compiler/chain.ts", "compiler/decl.ts", "compiler/clean.ts"]));
    writeFileSync(join(corpus, "compiler/chain.ts"), [
      "interface A { a: string }", "interface B { b: number }", "declare const x: A | B;", "x.a;",
      "export default class C {}", "export default class C {}",
    ].join("\n"));
    writeFileSync(join(corpus, "compiler/decl.ts"),
      "// @declaration: true\n// @noEmit: false\nexport const foo = class { private bar = 1; };\n");
    writeFileSync(join(corpus, "compiler/clean.ts"), "export const ok = 1;\n");
    const run = (extraEnv = {}) => spawnSync(process.execPath, [
      "src/run.ts", "--baseline", "7.1.0-beta-official", "--corpus", corpus, "--cases", manifest,
      "--adapter", "tsrs-async", "--expectation-source", "ts7-api", "--option-strategy", "aligned",
      "--gate", "--gate-profile", "strict", "--out", out, "--report-out", out,
    ], { cwd: REPO_ROOT, env: { ...process.env, TSRS_BINARY: "", TSC_BIN: "", ...extraEnv }, encoding: "utf8", timeout: 20_000 });
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const { meta, totals, comparison } = JSON.parse(readFileSync(join(out, "metrics.json"), "utf8"));
    expect(meta.adapter).toBe("tsrs-async");
    expect(meta.expectationSource).toBe("ts7-api");
    expect(meta.executionFailures).toEqual([]);
    expect(totals.ran).toBe(3);
    expect(comparison.strict).toEqual({ pass: 3, fail: 0, unknown: 0 });
    const { reference, candidate } = meta.tools;
    expect(reference.version).toBe("7.1.0-beta");
    expect(reference.native.sha256).not.toBe(candidate.sha256);
    expect(candidate).toMatchObject({
      version: "Version 7.1.0-beta (tsrs 0.25.0-ts7.1.0-beta, microsoft/TypeScript@3e9236361fa9)",
      sdk: { module: "tsrs/async", version: "0.25.0-ts7.1.0-beta" },
    });
    expect(candidate.path).toMatch(/[/\\]@tsrs[/\\]/);
    expect(candidate.sha256).toBe(sha256(readFileSync(candidate.path)));
    expect(candidate.sdk.sha256).toBe(sha256(readFileSync(candidate.sdk.path)));
    for (const report of ["report.md", "report.html"]) {
      expect(readFileSync(join(out, report), "utf8")).toContain(report.endsWith(".md") ? "SDK `tsrs/async`" : "SDK tsrs/async");
    }
    const [chain, declaration, clean] = JSON.parse(readFileSync(join(out, "details.json"), "utf8"));
    expect(chain.actual[0]).toMatchObject({ code: 2339, width: 1, messageChain: { children: [{ text: "Property 'a' does not exist on type 'B'." }] } });
    expect(chain.actual[1].related[0].code).toBe(2753);
    expect(declaration.actual.map((item: { code: number }) => item.code)).toEqual([4094]);
    expect(declaration.actualExitCode).toBeNull();
    expect(clean.actual).toEqual([]);
    const override = run({ TSRS_BINARY: reference.native.path });
    expect(override.status).toBe(1);
    expect(override.stderr).toContain("TSRS_BINARY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
