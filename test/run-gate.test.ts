import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { comparisonFields } from "../src/comparison.ts";

// 端到端验证 --gate：用临时语料 + 官方基线期望源 + “永远不报错”的 none 适配器，
// 不依赖真实 TypeScript 语料。正常例（无期望错误）应绿；人为造一条错误基线
// （实现必然漏报）或抬一篇 ratchet 清单（必然回落）应红。

const REPO_ROOT = join(import.meta.dir, "..");
const TSC_6_0 = join(REPO_ROOT, "node_modules", "typescript-6-0", "bin", "tsc");

interface Fixture {
  dir: string;
  corpus: string;
  manifest: string;
  baselineDir: string;
  out: string;
}

const fixtures: string[] = [];

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-gate-"));
  fixtures.push(dir);
  const corpus = join(dir, "tests", "cases");
  const baselineDir = join(dir, "tests", "baselines", "reference");
  mkdirSync(join(corpus, "compiler"), { recursive: true });
  mkdirSync(join(baselineDir, "compiler"), { recursive: true });
  writeFileSync(join(corpus, "compiler", "clean.ts"), "var x = 1;\n");
  const manifest = join(dir, "cases.json");
  writeFileSync(manifest, `${JSON.stringify(["compiler/clean.ts"])}\n`);
  return { dir, corpus, manifest, baselineDir, out: join(dir, "out") };
}

/** 写一条“官方基线认为有错”的基线：none 适配器必然漏报，用于制造门禁失败。 */
function writeErrorBaseline(f: Fixture): void {
  writeFileSync(
    join(f.baselineDir, "compiler", "clean.errors.txt"),
    "clean.ts(1,1): error TS9999: synthetic gate failure\n====\n",
  );
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnRun(f: Fixture, args: string[]): RunResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("TSC_COMPA_") || key === "TSC_BIN") continue;
    env[key] = value;
  }
  const r = spawnSync(process.execPath, ["src/run.ts", ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function baseArgs(f: Fixture): string[] {
  return [
    "--corpus",
    f.corpus,
    "--cases",
    f.manifest,
    "--adapter",
    "none",
    "--mode",
    "official",
    "--expectation-source",
    "official-baseline",
    "--tsc",
    TSC_6_0,
    "--out",
    f.out,
  ];
}

function runGate(f: Fixture, extra: string[]): RunResult {
  return spawnRun(f, [...baseArgs(f), "--gate", ...extra]);
}

/** 写一份 v2 记录，且两档都声明为已验证；用于验证同一回归在不同保护档下的结果。 */
function writeV2Ratchet(f: Fixture): string {
  const ratchet = join(f.dir, "ratchet-v2.tsv");
  const fields = comparisonFields.map((field) => `${field}=equal`).join(",");
  writeFileSync(ratchet, `# ratchet v2\ncompiler/clean.ts\tpass\tpass\t${fields}\t-\n`);
  return ratchet;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("--gate 端到端", () => {
  test("正常例：零差异自比 → 通过、退出码 0、metrics 记结论", () => {
    const f = fixture();
    const r = runGate(f, []);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("门禁：通过");
    const metrics = JSON.parse(readFileSync(join(f.out, "metrics.json"), "utf8"));
    expect(metrics.meta.gate.passed).toBe(true);
    expect(metrics.meta.gate.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  test("缺少整个官方基线目录不能假定没有诊断", () => {
    const f = fixture();
    const emptyCorpus = join(f.dir, "cases-only");
    mkdirSync(join(emptyCorpus, "compiler"), { recursive: true });
    writeFileSync(join(emptyCorpus, "compiler", "clean.ts"), "var x = 1;\n");
    const r = runGate(f, ["--corpus", emptyCorpus]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("官方基线目录不存在");
  });

  test("至少有一例完成时，另一例退出异常不是可忽略的跳过", () => {
    const f = fixture();
    const bin = join(f.dir, "candidate.sh");
    writeFileSync(bin, "#!/bin/sh\nfor arg do case $arg in *broken.ts) exit 70;; esac; done\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(f.corpus, "compiler", "broken.ts"), "var y = 2;\n");
    writeFileSync(f.manifest, JSON.stringify(["compiler/clean.ts", "compiler/broken.ts"]));
    const r = runGate(f, ["--adapter", `tsc-cli:${bin}`]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[失败] 执行异常");
    const metrics = JSON.parse(readFileSync(join(f.out, "metrics.json"), "utf8"));
    expect(metrics.totals.ran).toBe(1);
    expect(metrics.meta.executionFailures).toMatchObject([{ id: "compiler/broken.ts", side: "candidate", status: "crash" }]);
  });

  test("失败例：漏报 1 条超过默认上限 0 → 非零退出并说明原因", () => {
    const f = fixture();
    writeErrorBaseline(f);
    const r = runGate(f, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("门禁：失败");
    expect(r.stdout).toContain("[失败] 漏报：1 条 > 上限 0 条");
  });

  test("失败例：ratchet 清单回落 → 非零退出", () => {
    const f = fixture();
    writeErrorBaseline(f);
    const ratchet = join(f.dir, "ratchet.tsv");
    writeFileSync(ratchet, "# tier ratchet\ncompiler/clean.ts\tfull\n");
    const r = runGate(f, ["--ratchet", ratchet]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ratchet：1 项回归（1 项阻断）");
    expect(r.stdout).toContain("[阻断] compiler/clean.ts");
    expect(r.stdout).toContain("[失败] 兼容：兼容回归 1 项：compiler/clean.ts compatibility pass → fail");
    const metrics = JSON.parse(readFileSync(join(f.out, "metrics.json"), "utf8"));
    expect(metrics.meta.ratchet.regressionDetails).toEqual([
      expect.objectContaining({ kind: "compatibility", blocking: true }),
    ]);
  });

  test("门禁模式只读：改善不写回清单", () => {
    const f = fixture();
    const ratchet = join(f.dir, "ratchet.tsv");
    const content = `# tier ratchet\ncompiler/clean.ts\tlocation\n`;
    writeFileSync(ratchet, content);
    const r = runGate(f, ["--ratchet", ratchet]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("门禁模式不写回清单");
    expect(readFileSync(ratchet, "utf8")).toBe(content);
  });

  test("--gate-max-* 等阈值参数不带 --gate 时显式报错", () => {
    const f = fixture();
    const r = spawnRun(f, [...baseArgs(f), "--gate-max-fp", "1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("需要配合 --gate 使用");
  });

  test("--gate 要求 ratchet 清单已入库（不允许 CI 里自动初始化）", () => {
    const f = fixture();
    const missing = join(f.dir, "missing-ratchet.tsv");
    const r = runGate(f, ["--ratchet", missing, "--ratchet-init"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("门禁模式要求 ratchet 清单已入库");
  });
  test("同一回归：兼容档阻断兼容，严格档同时阻断兼容与严格", () => {
    const f = fixture();
    writeErrorBaseline(f);
    const ratchet = writeV2Ratchet(f);
    const fields = comparisonFields.map((field) => `${field}=equal`).join(",");

    const compatibility = runGate(f, ["--ratchet", ratchet]);
    expect(compatibility.status).toBe(1);
    expect(compatibility.stdout).toContain("ratchet：13 项回归（1 项阻断）");
    expect(compatibility.stdout).toContain("[失败] 兼容：兼容回归 1 项");
    expect(compatibility.stdout).toContain("[仅报告] 非阻断回归");
    expect(compatibility.stdout).toContain("strict pass → fail");
    const compatibilityMetrics = JSON.parse(readFileSync(join(f.out, "metrics.json"), "utf8"));
    expect(compatibilityMetrics.meta.ratchet.regressionDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "compatibility", was: "pass", now: "fail", blocking: true }),
      expect.objectContaining({ kind: "strict", was: "pass", now: "fail", blocking: false }),
      expect.objectContaining({ kind: "field", field: "message", blocking: false }),
    ]));
    expect(compatibilityMetrics.meta.ratchet.regressionDetails
      .filter((r: { kind: string }) => r.kind === "field")
      .every((r: { blocking: boolean }) => !r.blocking)).toBe(true);

    const strict = runGate(f, ["--ratchet", ratchet, "--gate-profile", "strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("ratchet：13 项回归（2 项阻断）");
    expect(strict.stdout).toContain("[失败] 严格一致：严格一致回归 2 项");
    expect(strict.stdout).toContain("compiler/clean.ts compatibility pass → fail");
    expect(strict.stdout).toContain("compiler/clean.ts strict pass → fail");
    expect(strict.stdout).toContain("[仅报告] 非阻断回归");
    const strictMetrics = JSON.parse(readFileSync(join(f.out, "metrics.json"), "utf8"));
    const strictBlocking = strictMetrics.meta.ratchet.regressionDetails.filter((r: { blocking: boolean }) => r.blocking);
    expect(strictBlocking).toHaveLength(2);
    expect(strictBlocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "compatibility", blocking: true }),
      expect.objectContaining({ kind: "strict", blocking: true }),
    ]));
    expect(strictMetrics.meta.gate.reported[0].detail).toContain("field");
    expect(strictMetrics.meta.gate.reported[0].detail).toContain("code");
    // 回归识别与门禁分离：该记录本身仍保留两档历史验证，不被本次失败改写。
    expect(readFileSync(ratchet, "utf8")).toContain(`compiler/clean.ts\tpass\tpass\t${fields}\t-`);
  });

});

describe("官方 Go 配置变体端到端", () => {
  function variantFixture(): Fixture {
    const f = fixture();
    f.corpus = join(f.dir, "testdata", "tests", "cases");
    f.baselineDir = join(f.dir, "testdata", "baselines", "reference");
    mkdirSync(join(f.corpus, "compiler"), { recursive: true });
    mkdirSync(join(f.baselineDir, "compiler"), { recursive: true });
    writeFileSync(join(f.corpus, "compiler", "clean.ts"), "// @target: es2015, es2020\nvar x = 1;\n");
    writeFileSync(join(f.baselineDir, "compiler", "clean(target=es2015).errors.txt"),
      "clean.ts(1,1): error TS9999: synthetic expected error\n====\n");
    writeFileSync(join(f.baselineDir, "compiler", "clean(target=es2020).types"), "clean.ts\n");
    return f;
  }

  test("按配置分别报告有诊断和有执行证据的零诊断", () => {
    const f = variantFixture();
    const r = runGate(f, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("漏报：1 条");
    const details = JSON.parse(readFileSync(join(f.out, "details.json"), "utf8"));
    expect(details).toEqual([
      expect.objectContaining({ id: "compiler/clean(target=es2015).ts", caseId: "compiler/clean.ts", configuration: "target=es2015", status: "ran", missed: [expect.any(String)] }),
      expect.objectContaining({ id: "compiler/clean(target=es2020).ts", caseId: "compiler/clean.ts", configuration: "target=es2020", status: "ran", missed: [] }),
    ]);
    const metrics = JSON.parse(readFileSync(join(f.out, "metrics.json"), "utf8"));
    expect(metrics.meta.selectedCases).toBe(1);
    expect(metrics.totals.cases).toBe(2);
  });

  test("未找到特定配置的官方执行证据时不冒充零诊断", () => {
    const f = variantFixture();
    rmSync(join(f.baselineDir, "compiler", "clean(target=es2020).types"));
    const r = spawnRun(f, baseArgs(f));
    expect(r.status).toBe(0);
    const details = JSON.parse(readFileSync(join(f.out, "details.json"), "utf8"));
    expect(details[1]).toMatchObject({ configuration: "target=es2020", status: "skip", skipReason: expect.stringContaining("官方基线:") });
    expect(details[1].comparison).toBeNull();
  });
});
