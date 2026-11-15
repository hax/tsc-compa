import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { escapeHtml, generateReport, neutralImplName, readRunData } from "../src/report.ts";

// 报告模块单测：最小 metrics 输入 → 关键字段；确定性；HTML 自包含与转义；
// delta/回归；报告 CLI 兜底；run.ts 端到端（失败 run 也出报告、写盘失败非零退出）。

const REPO_ROOT = join(import.meta.dir, "..");
const TSC_6_0 = join(REPO_ROOT, "node_modules", "typescript-6-0", "bin", "tsc");

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FixtureMetrics {
  meta?: Record<string, unknown>;
  totals?: Record<string, unknown>;
  skips?: unknown;
  byCode?: unknown;
  samples?: unknown;
}

const BASE_META: Record<string, unknown> = {
  suite: "smoke",
  corpus: "/corpus/tests/cases",
  adapter: "tsc-cli:node_modules/typescript-6-0/bin/tsc",
  mode: "official",
  verdictEligible: true,
  tscVersion: "6.0.3",
  tscBin: "node_modules/typescript-6-0/bin/tsc",
  baseline: "6.0.3",
  corpusRef: "050880ce",
  expectationSource: "official-baseline",
  generatedAt: "2026-11-16T00:00:00.000Z",
  selectedCases: 3,
};

const BASE_TOTALS: Record<string, unknown> = {
  cases: 3,
  ran: 3,
  skipped: 0,
  passCases: 2,
  fpCases: 1,
  fpTotal: 1,
  misanchorCases: 0,
  misanchorTotal: 0,
  expectTotal: 4,
  hitTotal: 3,
  missTotal: 1,
  messageMismatch: 0,
  coverage: 0.75,
  byTier: { none: 0, location: 0, category: 0, text: 1, full: 2 },
  t3Failures: [["elaboration", 1]],
};

/** 最小但完整的 metrics（只含报告用到的字段），用于断言字段与确定性。 */
function metricsOf(overrides: FixtureMetrics = {}): Record<string, unknown> {
  return {
    meta: { ...BASE_META, ...(overrides.meta ?? {}) },
    totals: { ...BASE_TOTALS, ...(overrides.totals ?? {}) },
    skips: overrides.skips ?? [],
    byCode: overrides.byCode ?? { fp: [], miss: [] },
    samples: overrides.samples ?? { fp: [], miss: [], textDiff: [], messageDiff: [], t3: [] },
  };
}

const BASE_DETAILS = [
  { id: "compiler/a.ts", status: "ran", expected: 2, actual: 2, hits: 2, fp: [], missed: [], misanchor: 0, tier: "full" },
  { id: "compiler/b.ts", status: "ran", expected: 2, actual: 3, hits: 1, fp: ["x"], missed: [], misanchor: 0, tier: "text" },
  { id: "compiler/c.ts", status: "ran", expected: 0, actual: 0, hits: 0, fp: [], missed: [], misanchor: 0, tier: "full" },
];

function detailsWithTier(entries: [string, string][]): Record<string, unknown>[] {
  return entries.map(([id, tier]) => ({
    id,
    status: "ran",
    expected: 1,
    actual: 1,
    hits: 1,
    fp: [],
    missed: [],
    misanchor: 0,
    tier,
  }));
}

describe("报告渲染：最小 metrics 输入", () => {
  test("Markdown 含标题、摘要卡、阶梯、头部口径", () => {
    const { markdown } = generateReport({ metrics: metricsOf(), details: BASE_DETAILS, source: ".cache/run" });
    expect(markdown).toContain("# tsc-compa 兼容性报告 — 6.0.3");
    expect(markdown).toContain("覆盖 75.0%");
    expect(markdown).toContain("| 覆盖率 | 75.0% |");
    expect(markdown).toContain("| 假阳性 | 1 例 / 1 条 |");
    expect(markdown).toContain("| 漏报 | 1 条 |");
    expect(markdown).toContain("T3 全文");
    expect(markdown).toContain("生成时间");
    expect(markdown).toContain("2026-11-16T00:00:00.000Z");
    expect(markdown).toContain("期望源");
    expect(markdown).toContain("official-baseline");
    expect(markdown).toContain("pin");
    expect(markdown).toContain("050880ce");
    // 未传 --gate：明确说没启用门禁，而不是悄悄当成通过。
    expect(markdown).toContain("未启用门禁");
    expect(markdown).toContain("没有提供上次运行数据");
  });

  test("HTML 自包含：内联 CSS、内联 SVG、无外部资源标签", () => {
    const { html } = generateReport({ metrics: metricsOf(), details: BASE_DETAILS, source: ".cache/run" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("<svg");
    expect(html).toContain("T3 全文");
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\b/);
    // 唯一允许出现的 http 前缀是 SVG 命名空间；不能有真正加载外部资源的标签/URL。
    expect(html).not.toMatch(/<img\b|<iframe\b|src="https?:|url\(https?:/);
  });

  test("确定性：同输入两次生成字节一致，且渲染不改动输入对象", () => {
    const metrics = metricsOf();
    const details = BASE_DETAILS;
    const snapshot = JSON.stringify({ metrics, details });
    const first = generateReport({ metrics, details, source: ".cache/run" });
    const second = generateReport({ metrics, details, source: ".cache/run" });
    expect(first.markdown).toBe(second.markdown);
    expect(first.html).toBe(second.html);
    expect(JSON.stringify({ metrics, details })).toBe(snapshot);
  });

  test("旧版/残缺 metrics 不崩：缺 byTier/samples 时退化为 n/a", () => {
    const { markdown, html } = generateReport({
      metrics: { meta: { ...BASE_META, adapter: "none" }, totals: { cases: 1, ran: 1, skipped: 0 } },
      details: [],
    });
    expect(markdown).toContain("没有 T0–T3 分档数据");
    expect(html).toContain("没有 T0–T3 分档数据");
    expect(markdown).toContain("n/a");
    expect(markdown).toContain("none");
  });

  test("非官方期望源（tsc 现场生成）：T3 全文档标注为不可比", () => {
    const { markdown, html } = generateReport(
      { metrics: metricsOf({ meta: { expectationSource: "tsc" } }), details: BASE_DETAILS },
      {},
    );
    expect(markdown).toContain("T3 全文档只对无期望错误的用例成立");
    expect(html).toContain("T3 全文档只对无期望错误的用例成立");
  });

  test("门禁失败：Markdown 与 HTML 都给出失败结论与逐项检查", () => {
    const metrics = metricsOf({
      meta: {
        gate: {
          passed: false,
          thresholds: { maxFp: 0, maxMiss: 0, maxMisanchor: 0, minCoverage: null },
          checks: [
            { name: "口径", ok: true, detail: "可作兼容性结论（mode=official）" },
            { name: "假阳性", ok: false, detail: "1 条 > 上限 0 条" },
          ],
        },
      },
    });
    const { markdown, html } = generateReport({ metrics, details: BASE_DETAILS });
    expect(markdown).toContain("门禁：失败（1/2 项未过）");
    expect(markdown).toContain("| 假阳性 | **失败** | 1 条 > 上限 0 条 |");
    expect(markdown).toContain("门禁失败项（1）");
    expect(html).toContain("门禁：失败（1/2 项未过）");
    expect(html).toContain('class="status-bad"');
    expect(html).toContain("门禁失败项（1）");
  });

  test("HTML 转义：实现名、样例、跳过原因都不以裸 HTML 出现", () => {
    const metrics = metricsOf({
      skips: [['<script>alert("skip")</script>', 2]],
      samples: { fp: ["<img src=x onerror=alert(1)> TS9999"], miss: [], textDiff: [], messageDiff: [], t3: [] },
    });
    const { markdown, html } = generateReport(
      { metrics, details: [{ ...BASE_DETAILS[1]!, id: 'evil"><script>alert(1)</script>' }] },
      { implName: '<script>alert("impl")</script>' },
    );
    // 动态文本被转义成实体，不会形成可执行标签。
    expect(html).not.toContain('<script>alert("impl")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;impl&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    // Markdown 文本路径同样不保留裸 HTML 标签（样例在行内代码里，本身就是惰性的）。
    expect(markdown).not.toContain('<script>alert("impl")</script>');
    expect(markdown).toContain("&lt;script>alert");
  });

  test("escapeHtml 覆盖五个危险字符；neutralImplName 去掉 :<bin>", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
    expect(neutralImplName("tsc-cli:node_modules/typescript-6-0/bin/tsc")).toBe("tsc-cli");
    expect(neutralImplName("checker-batch")).toBe("checker-batch");
    expect(neutralImplName(null)).toBe("实现");
  });
});

describe("报告 delta 与逐例回归", () => {
  test("覆盖率/假阳性变化与档位回落在 Markdown 里对比出来", () => {
    const previous = {
      metrics: metricsOf({
        totals: { coverage: 1, hitTotal: 4, fpCases: 0, fpTotal: 0, passCases: 3, skipped: 0 },
        meta: { generatedAt: "2026-11-15T00:00:00.000Z" },
      }),
      details: detailsWithTier([
        ["compiler/a.ts", "full"],
        ["compiler/b.ts", "full"],
        ["compiler/c.ts", "full"],
      ]),
    };
    const current = {
      metrics: metricsOf(),
      details: [
        { id: "compiler/a.ts", status: "ran", expected: 2, actual: 2, hits: 2, fp: [], missed: [], misanchor: 0, tier: "full" },
        { id: "compiler/b.ts", status: "ran", expected: 2, actual: 2, hits: 2, fp: [], missed: [], misanchor: 0, tier: "text" },
        { id: "compiler/c.ts", status: "ran", expected: 0, actual: 0, hits: 0, fp: [], missed: [], misanchor: 0, tier: "full" },
      ],
    };
    const { markdown, html } = generateReport(current, { previous });
    expect(markdown).toContain("对比基准：2026-11-15T00:00:00.000Z");
    expect(markdown).toContain("-25.0pp");
    expect(markdown).toContain("（变差）");
    expect(markdown).toContain("逐例变化（1 例回归 / 0 例改善）");
    expect(markdown).toContain("回归** `compiler/b.ts`：T3 全文 → T2 文案");
    expect(html).toContain("回归（1）");
    expect(html).toContain("class=\"worse\"");
  });

  test("跳过与不再运行也算回归", () => {
    const previous = {
      metrics: metricsOf({ totals: { skipped: 0 } }),
      details: [{ id: "compiler/a.ts", status: "ran", expected: 1, actual: 1, hits: 1, fp: [], missed: [], misanchor: 0, tier: "full" }],
    };
    const current = {
      metrics: metricsOf({ totals: { skipped: 1, ran: 2 } }),
      details: [{ id: "compiler/a.ts", status: "skip", skipReason: "实现返回 timeout" }],
    };
    const { markdown } = generateReport(current, { previous });
    expect(markdown).toContain("不再运行：实现返回 timeout");
    expect(markdown).toContain("1 例回归");
  });
});

describe("报告 CLI（src/report.ts）", () => {
  function spawnReport(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, ["src/report.ts", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("从 metrics/details 目录生成 md/html，两次输出字节一致", () => {
    const dir = tempDir("tsc-compa-report-cli-");
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metricsOf()));
    writeFileSync(join(dir, "details.json"), JSON.stringify(BASE_DETAILS));
    const mdA = join(dir, "a.md");
    const htmlA = join(dir, "a.html");
    const r1 = spawnReport(["--from", dir, "--md", mdA, "--html", htmlA]);
    expect(r1.status).toBe(0);
    expect(readFileSync(mdA, "utf8")).toContain("覆盖率");
    expect(readFileSync(htmlA, "utf8")).toContain("<svg");
    const mdB = join(dir, "b.md");
    const htmlB = join(dir, "b.html");
    const r2 = spawnReport(["--from", dir, "--md", mdB, "--html", htmlB]);
    expect(r2.status).toBe(0);
    expect(readFileSync(mdB, "utf8")).toBe(readFileSync(mdA, "utf8"));
    expect(readFileSync(htmlB, "utf8")).toBe(readFileSync(htmlA, "utf8"));
  });

  test("metrics 缺失：写失败占位报告（exit 0）；--require-metrics 时非零退出", () => {
    const dir = tempDir("tsc-compa-report-missing-");
    const md = join(dir, "report.md");
    const html = join(dir, "report.html");
    const r = spawnReport(["--from", dir, "--md", md, "--html", html]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("失败占位报告");
    expect(readFileSync(md, "utf8")).toContain("失败占位报告");
    expect(readFileSync(html, "utf8")).toContain("失败占位报告");
    const strict = spawnReport(["--from", dir, "--md", join(dir, "strict.md"), "--require-metrics"]);
    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toContain("没有找到运行结果");
  });

  test("非法参数 / 没给输出路径 → 非零退出", () => {
    const dir = tempDir("tsc-compa-report-badargs-");
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metricsOf()));
    expect(spawnReport(["--from", dir]).status).not.toBe(0);
    expect(spawnReport(["--from", dir, "--md", join(dir, "x.md"), "--bogus"]).status).not.toBe(0);
  });

  test("readRunData 支持运行目录与 metrics.json 路径，缺目录返回 null", () => {
    const dir = tempDir("tsc-compa-report-read-");
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metricsOf()));
    writeFileSync(join(dir, "details.json"), JSON.stringify(BASE_DETAILS));
    const fromDir = readRunData(dir);
    expect(fromDir?.source).toBe(dir);
    expect((fromDir?.details as unknown[]).length).toBe(3);
    const fromFile = readRunData(join(dir, "metrics.json"));
    expect(fromFile?.source).toBe(dir);
    expect(readRunData(join(dir, "nope.json"))).toBeNull();
  });
});

// --- run.ts 端到端：报告与门禁/测试失败的关系 ---------------------------------

interface GateFixture {
  dir: string;
  corpus: string;
  manifest: string;
  baselineDir: string;
  out: string;
}

function gateFixture(): GateFixture {
  const dir = tempDir("tsc-compa-report-e2e-");
  const corpus = join(dir, "tests", "cases");
  const baselineDir = join(dir, "tests", "baselines", "reference");
  mkdirSync(join(corpus, "compiler"), { recursive: true });
  mkdirSync(join(baselineDir, "compiler"), { recursive: true });
  writeFileSync(join(corpus, "compiler", "clean.ts"), "var x = 1;\n");
  const manifest = join(dir, "cases.json");
  writeFileSync(manifest, `${JSON.stringify(["compiler/clean.ts"])}\n`);
  return { dir, corpus, manifest, baselineDir, out: join(dir, "out") };
}

function spawnRun(fixture: GateFixture, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("TSC_COMPA_") || key === "TSC_BIN") continue;
    env[key] = value;
  }
  const r = spawnSync(process.execPath, ["src/run.ts", ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function baseArgs(fixture: GateFixture): string[] {
  return [
    "--corpus",
    fixture.corpus,
    "--cases",
    fixture.manifest,
    "--adapter",
    "none",
    "--mode",
    "official",
    "--expectation-source",
    "official-baseline",
    "--tsc",
    TSC_6_0,
    "--out",
    fixture.out,
  ];
}

describe("run.ts 报告接入", () => {
  test("--report-md / --report-html 用同一份 metrics 生成报告，数字与 metrics 一致", () => {
    const fixture = gateFixture();
    // 官方基线认为有一条错误、none 适配器必然漏报：得到非空的期望分母，报告数字可对照。
    writeFileSync(
      join(fixture.baselineDir, "compiler", "clean.errors.txt"),
      "clean.ts(1,1): error TS9999: synthetic expected error\n====\n",
    );
    const markdown = join(fixture.out, "report.md");
    const html = join(fixture.out, "report.html");
    const r = spawnRun(fixture, [...baseArgs(fixture), "--report-md", markdown, "--report-html", html]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("报告（Markdown）");
    const metrics = JSON.parse(readFileSync(join(fixture.out, "metrics.json"), "utf8"));
    const md = readFileSync(markdown, "utf8");
    expect(metrics.totals.coverage).toBe(0);
    expect(metrics.totals.missTotal).toBe(1);
    expect(md).toContain("| 漏报 | 1 条 |");
    expect(md).toContain("覆盖 0.0%");
    // 未传 --gate 时报告明确写「未启用」，不冒充通过。
    expect(md).toContain("未启用门禁");
    expect(readFileSync(html, "utf8")).toContain("未启用门禁");
    // 明细也写了出来，报告 CLI 可以只凭输出目录复现同一份报告。
    expect(existsSync(join(fixture.out, "details.json"))).toBe(true);
  });

  test("门禁失败（测试失败）时报告照样生成，进程仍非零退出", () => {
    const fixture = gateFixture();
    writeFileSync(
      join(fixture.baselineDir, "compiler", "clean.errors.txt"),
      "clean.ts(1,1): error TS9999: synthetic gate failure\n====\n",
    );
    const markdown = join(fixture.out, "report.md");
    const r = spawnRun(fixture, [...baseArgs(fixture), "--gate", "--report-md", markdown]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("门禁：失败");
    expect(existsSync(markdown)).toBe(true);
    expect(readFileSync(markdown, "utf8")).toContain("门禁：失败");
  });

  test("报告写盘失败 → 非零退出（不吞掉本来通过的门禁）", () => {
    const fixture = gateFixture();
    mkdirSync(fixture.out, { recursive: true });
    // 把 --report-md 指向一个已存在的目录：写盘必然失败。
    const r = spawnRun(fixture, [...baseArgs(fixture), "--gate", "--report-md", fixture.out]);
    expect(r.status).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
    // 运行本身已经完成并写出 metrics，只是报告失败导致非零。
    expect(existsSync(join(fixture.out, "metrics.json"))).toBe(true);
  });

  test("--prev-report 指向缺失文件时显式报错", () => {
    const fixture = gateFixture();
    const r = spawnRun(fixture, [...baseArgs(fixture), "--report-md", join(fixture.out, "r.md"), "--prev-report", join(fixture.dir, "missing.json")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--prev-report");
  });
});

describe("scripts/merge-reports.ts", () => {
  function writeEntry(root: string, slug: string, metrics: Record<string, unknown>, reportMd: string, reportHtml: string): void {
    const dir = join(root, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metrics));
    writeFileSync(join(dir, "report.md"), reportMd);
    writeFileSync(join(dir, "report.html"), reportHtml);
  }

  test("合并各档为一份 Markdown 摘要 + HTML 索引（失败档高亮、缺 metrics 不消失）", () => {
    const root = tempDir("tsc-compa-merge-");
    writeEntry(
      root,
      "report-6.0.3-self",
      metricsOf({ meta: { baseline: "6.0.3" }, totals: { coverage: 1, fpCases: 0, fpTotal: 0, missTotal: 0 } }),
      "# 6.0.3 自比\n\n全部通过\n",
      "<html>ok</html>",
    );
    const failedMetrics = metricsOf({
      meta: {
        baseline: "7.1.0-beta-official",
        gate: { passed: false, thresholds: {}, checks: [{ name: "假阳性", ok: false, detail: "1 > 0" }] },
      },
    });
    writeEntry(root, "report-7.1.0-beta-official", failedMetrics, "# 7.1 official\n\n假阳性 1\n", "<html>bad</html>");
    writeEntry(
      root,
      "report-7.1.0-beta-self",
      metricsOf({ meta: { baseline: "7.1.0-beta", expectationSource: "tsc" } }),
      "# 7.1 自比\n\nT3 不可比\n",
      "<html>self</html>",
    );
    mkdirSync(join(root, "report-5.9.3-self"), { recursive: true });
    writeFileSync(join(root, "report-5.9.3-self", "report.md"), "# 5.9 占位\n");

    const md = join(root, "summary.md");
    const html = join(root, "index.html");
    const run = (): { status: number | null; stdout: string } => {
      const r = spawnSync(
        process.execPath,
        ["scripts/merge-reports.ts", "--root", root, "--md", md, "--html", html, "--run-url", "https://ci.example/run/1"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      return { status: r.status, stdout: r.stdout ?? "" };
    };
    expect(run().status).toBe(0);
    const summary = readFileSync(md, "utf8");
    expect(summary).toContain("# tsc-compa 兼容性报告汇总");
    expect(summary).toContain("CI run：https://ci.example/run/1");
    expect(summary).toContain("**门禁失败档位（1）**：7.1.0-beta-official");
    expect(summary).toContain("| 6.0.3-self | 6.0.3 / official |");
    expect(summary).toContain("无 metrics（运行失败）");
    expect(summary).toContain("| 7.1.0-beta-self | 7.1.0-beta / official | 3/3 | 75.0% | 1 例 / 1 条 | 1 | 0 | 0 | n/a | 未启用 |");
    expect(summary).toContain("全部通过");
    expect(summary).toContain("假阳性 1");
    const index = readFileSync(html, "utf8");
    expect(index).toContain("tsc-compa 兼容性报告汇总");
    expect(index).toContain('href="report-6.0.3-self/report.html"');
    expect(index).toContain('class="status-bad"');
    // 确定性：同输入再跑一次，字节一致。
    const before = readFileSync(md, "utf8");
    expect(run().status).toBe(0);
    expect(readFileSync(md, "utf8")).toBe(before);
  });

  test("root 不存在或没有任何档位 → 非零退出", () => {
    const root = tempDir("tsc-compa-merge-empty-");
    const spawn = (rootArg: string): number | null => {
      const r = spawnSync(process.execPath, ["scripts/merge-reports.ts", "--root", rootArg], { cwd: REPO_ROOT, encoding: "utf8" });
      return r.status;
    };
    expect(spawn(join(root, "nope"))).not.toBe(0);
    expect(spawn(root)).not.toBe(0);
  });
});
