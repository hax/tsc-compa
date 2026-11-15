import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";

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

function runGate(f: Fixture, extra: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("TSC_COMPA_") || key === "TSC_BIN" || key.startsWith("MAAT_")) continue;
    env[key] = value;
  }
  const r = spawnSync(
    process.execPath,
    [
      "src/run.ts",
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
      "--gate",
      ...extra,
    ],
    { cwd: REPO_ROOT, env, encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
    expect(r.stdout).toContain("ratchet 回落 1 例");
    expect(r.stdout).toContain("[失败] ratchet：回落 1 例：compiler/clean.ts full → none");
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

  test("--gate 要求 ratchet 清单已入库（不允许 CI 里自动初始化）", () => {
    const f = fixture();
    const missing = join(f.dir, "missing-ratchet.tsv");
    const r = runGate(f, ["--ratchet", missing, "--ratchet-init"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("门禁模式要求 ratchet 清单已入库");
  });
});
