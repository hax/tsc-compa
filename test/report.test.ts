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
  comparison?: Record<string, unknown>;
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
    ...(overrides.comparison !== undefined ? { comparison: overrides.comparison } : {}),
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

const NEW_FIELDS = {
  code: "equal",
  severity: "equal",
  location: "equal",
  width: "equal",
  message: "equal",
  messageChain: "equal",
  related: "equal",
  attributes: "equal",
  count: "equal",
  order: "equal",
  output: "equal",
} as const;

function comparisonOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    compatibility: "pass",
    strict: "pass",
    fields: { ...NEW_FIELDS },
    matches: [],
    positionDifferences: [],
    missing: [],
    extraErrors: [],
    extraWarnings: [],
    unclassified: [],
    unresolved: { expected: [], actual: [] },
    ...overrides,
  };
}

function newDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "compiler/a.ts",
    status: "ran",
    expected: [{ file: "a.ts", line: 0, col: 0, code: 2322, severity: "error", message: "expected" }],
    actual: [{ file: "a.ts", line: 0, col: 0, code: 2322, severity: "error", message: "actual" }],
    comparison: comparisonOf(),
    expectedExitCode: 2,
    actualExitCode: 2,
    expectedOutput: "a.ts(1,1): error TS2322: expected",
    actualOutput: "a.ts(1,1): error TS2322: actual",
    options: [{ name: "strict", value: true }],
    expectedArgs: ["--strict", "true"],
    actualArgs: ["--strict", "true"],
    hits: 1,
    fp: [],
    missed: [],
    misanchor: 0,
    tier: "full",
    ...overrides,
  };
}

function v2Metrics(options: {
  compatibility?: "pass" | "fail" | "unknown";
  strict?: "pass" | "fail" | "unknown";
  generatedAt?: string;
  manifest?: Record<string, unknown> | null;
  expectationSource?: string;
  optionStrategy?: "defaults" | "aligned";
} = {}): Record<string, unknown> {
  const compatibility = options.compatibility ?? "pass";
  const strict = options.strict ?? "pass";
  return metricsOf({
    meta: {
      ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
      ...(options.expectationSource === undefined ? {} : { expectationSource: options.expectationSource }),
      ...(options.optionStrategy === undefined ? {} : { options: { strategy: options.optionStrategy } }),
    },
    comparison: {
      compatibility: { pass: compatibility === "pass" ? 1 : 0, fail: compatibility === "fail" ? 1 : 0, unknown: compatibility === "unknown" ? 1 : 0 },
      strict: { pass: strict === "pass" ? 1 : 0, fail: strict === "fail" ? 1 : 0, unknown: strict === "unknown" ? 1 : 0 },
      fields: Object.fromEntries(Object.keys(NEW_FIELDS).map((field) => [field, { equal: 1, different: 0, unavailable: 0 }])),
    },
  });
}

const SAME_V2_SCOPE = {
  path: "config/v2-cases.json",
  sha256: "manifest-a",
  selectedIdsSha256: "selected-a",
  parsedInputsSha256: "parsed-a",
  officialInputsSha256: "official-a",
};

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

  test("缺 details.json：按 metrics 的 fp/漏报/样例判断失败，不误报「未发现」", () => {
    const withSamples = generateReport({
      metrics: metricsOf({ samples: { fp: ["a.ts:1:1 TS1000", "b.ts:2:3 TS1001"], miss: [], textDiff: [], messageDiff: [], t3: [] } }),
      details: [],
    });
    expect(withSamples.markdown).not.toContain("未发现失败或回归");
    expect(withSamples.markdown).toContain("没有 `details.json`");
    expect(withSamples.markdown).toContain("a.ts:1:1 TS1000");
    expect(withSamples.html).toContain("没有 <code>details.json</code>");
    // 连样例都没保留时，totals 里的假阳性也要触发失败小节。
    const totalsOnly = generateReport({
      metrics: metricsOf({ samples: { fp: [], miss: [], textDiff: [], messageDiff: [], t3: [] } }),
      details: [],
    });
    expect(totalsOnly.markdown).not.toContain("未发现失败或回归");
    expect(totalsOnly.markdown).toContain("T3 未达 1 例");
    // 只有「位置命中但文案不同」的差异也不能落到「未发现」。
    const mismatchOnly = generateReport({
      metrics: metricsOf({
        totals: { messageMismatch: 2, fpCases: 0, fpTotal: 0, missTotal: 0, misanchorTotal: 0 },
        samples: { fp: [], miss: [], textDiff: [], messageDiff: [], t3: [] },
      }),
      details: [],
    });
    expect(mismatchOnly.markdown).toContain("首行文案不同 2 条");
    expect(mismatchOnly.markdown).not.toContain("未发现失败或回归");
  });

  test("行内代码围栏按内容里最长反引号串加长，避免提前闭合", () => {
    const { markdown } = generateReport({
      metrics: metricsOf({
        samples: { fp: ["a.ts:1:1 TS1000 ```", "c.ts:4:5 TS1002 `x`"], miss: [], textDiff: [], messageDiff: [], t3: [] },
      }),
      details: BASE_DETAILS,
    });
    // 含 3 连反引号的样例用 4 连围栏，且两侧补空格。
    expect(markdown).toContain("```` a.ts:1:1 TS1000 ``` ````");
    // 含单反引号的样例用 2 连围栏；内容以反引号收尾时两侧补空格。
    expect(markdown).toContain("`` c.ts:4:5 TS1002 `x` ``");
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

describe("新两档报告：比较主视图与逐案展开", () => {
  test("metrics.comparison 为主视图：兼容/严格各 pass/fail/unknown、字段回归表", () => {
    const metrics = metricsOf({
      comparison: {
        compatibility: { pass: 1, fail: 1, unknown: 1 },
        strict: { pass: 0, fail: 2, unknown: 1 },
        fields: {
          ...Object.fromEntries(Object.keys(NEW_FIELDS).map((field) => [field, { equal: 1, different: 1, unavailable: 1 }])),
          output: { equal: 0, different: 2, unavailable: 1 },
        },
      },
    });
    const { markdown, html } = generateReport({ metrics, details: [newDetails()] });
    expect(markdown).toContain("## 两档比较");
    expect(markdown).toContain("| 兼容通过（旧字段） | 2/3 例 |");
    expect(markdown).toContain("| 兼容档 | 1 | 1 | 1 |");
    expect(markdown).toContain("| 严格一致档 | 0 | 2 | 1 |");
    expect(markdown).toContain("| 完整输出 | 0 | 2 | 1 |");
    expect(markdown).toContain("（严格一致不是旧 T3 全文比较）");
    expect(html).toContain("<h2>两档比较</h2>");
    expect(html).toContain("兼容档");
  });

  test("逐案展开等价码/严重级别/范围/文字/related/顺序/附加诊断，位置差异仍不兼容", () => {
    const details = newDetails({
      expected: [
        { file: "a.ts", line: 0, col: 0, code: 2322, severity: "error", message: "expected" },
        { file: "a.ts", line: 2, col: 4, code: 2322, severity: "error", message: "moved" },
      ],
      actual: [
        { file: "a.ts", line: 0, col: 0, code: 2322, severity: "error", message: "actual" },
        { file: "a.ts", line: 3, col: 4, code: 2322, severity: "error", message: "moved elsewhere" },
      ],
      comparison: comparisonOf({
        compatibility: "fail",
        strict: "fail",
        fields: {
          ...NEW_FIELDS,
          code: "different",
          severity: "different",
          width: "different",
          message: "different",
          messageChain: "unavailable",
          related: "different",
          order: "different",
          output: "different",
          attributes: "unavailable",
        },
        matches: [{
          expected: 0,
          actual: 0,
          fields: {
            code: "different",
            severity: "different",
            location: "equal",
            width: "different",
            message: "different",
            messageChain: "unavailable",
            related: "different",
            attributes: "unavailable",
          },
        }],
        positionDifferences: [{
          expected: 1,
          actual: 1,
          fields: {
            code: "equal",
            severity: "equal",
            location: "different",
            width: "equal",
            message: "equal",
            messageChain: "equal",
            related: "equal",
            attributes: "equal",
          },
        }],
        missing: [1],
        extraErrors: [2],
        extraWarnings: [3],
        unclassified: [4],
        unresolved: { expected: [1], actual: [2] },
      }),
      expectedExitCode: 2,
      actualExitCode: 1,
    });
    const { markdown, html } = generateReport({ metrics: metricsOf({ comparison: { compatibility: { pass: 0, fail: 1, unknown: 0 }, strict: { pass: 0, fail: 1, unknown: 0 }, fields: {} } }), details: [details] });
    for (const text of ["诊断码（等价码差异）", "严重级别", "标记范围", "首行文字", "related 信息", "输出顺序", "其他诊断属性"]) {
      expect(markdown).toContain(text);
      expect(html).toContain(text);
    }
    expect(markdown).toContain("仅位置不同（仍判不兼容）");
    expect(markdown).toContain("expected[1] ↔ actual[1]");
    expect(markdown).toContain("TS2322 → TS2322");
    expect(markdown).toContain("完整输出（参考）");
    expect(markdown).toContain("完整输出（候选）");
    expect(markdown).toContain("```\na.ts(1,1): error TS2322: expected\n```");
    expect(markdown).toContain("未对应的参考诊断");
    expect(markdown).toContain("未能唯一对应");
    expect(markdown).toContain("1 条新增 warning");
    expect(markdown).toContain("1 条未分类诊断");
    expect(markdown).toContain("参考 2｜候选 1（不一致）");
    expect(html).toContain("仅位置不同（仍判不兼容）");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("参考 2｜候选 1（不一致）");
  });

  test("退出码、output/args/options 缺值明确标未提供，不伪造 0", () => {
    const details = newDetails({
      expectedExitCode: 0,
      actualExitCode: null,
      expectedOutput: null,
      actualOutput: "",
      expectedArgs: undefined,
      actualArgs: [],
      options: undefined,
    });
    const { markdown } = generateReport({ metrics: metricsOf({ comparison: { compatibility: { pass: 1, fail: 0, unknown: 0 }, strict: { pass: 1, fail: 0, unknown: 0 }, fields: {} } }), details: [details] });
    expect(markdown).toContain("参考 0｜未提供");
    expect(markdown).toContain("输出 未提供 / 已提供");
    expect(markdown).toContain("参考 未提供；候选 `（无）`");
  });

  test("旧详情缺 comparison：两档保持未提供，不用 T3 反推严格一致", () => {
    const { markdown, html } = generateReport({ metrics: metricsOf(), details: BASE_DETAILS });
    expect(markdown).not.toContain("## 两档比较");
    expect(markdown).not.toContain("严格一致档 通过");
    expect(html).not.toContain("<h2>两档比较</h2>");
    // 旧 T3 仍显示，但明确是过渡参考。
    expect(markdown).toContain("旧 metrics.totals 的 T0–T3 阶梯");
  });

  test("meta 的可追溯信息：manifest/选项策略/参考与候选 provenance；默认与对齐可区分", () => {
    const defaults = generateReport({
      metrics: metricsOf({
        meta: {
          manifest: { path: "config/cases.json", sha256: "abc" },
          options: { strategy: "defaults", referenceBaseArgs: ["--noEmit"], sharedArgs: [], candidateArgs: [], candidateEnvArgs: [], onlyClasses: [], excludeClasses: [] },
          tools: {
            runner: "Bun 1.4.5",
            platform: "darwin/arm64",
            reference: { path: "/ref/tsc", version: "6.0.3", sha256: "refhash" },
            candidate: { path: "/impl/bin", version: "0.1.0", sha256: "implhash" },
          },
        },
      }),
      details: [],
    }).markdown;
    expect(defaults).toContain("默认设置（参考与候选各自使用默认值，未显式对齐）");
    expect(defaults).toContain("`config/cases.json`");
    expect(defaults).toContain("`/ref/tsc`");
    expect(defaults).toContain("`implhash`");
    const aligned = generateReport({
      metrics: metricsOf({
        meta: { options: { strategy: "aligned", referenceBaseArgs: ["--noEmit"], sharedArgs: ["--target", "es2022"], candidateArgs: ["--noEmit", "--target", "es2022"], candidateEnvArgs: [], onlyClasses: [], excludeClasses: [] } },
      }),
      details: [],
    }).markdown;
    expect(aligned).toContain("对齐设置（候选使用参考配置的基础参数）");
    expect(aligned).toContain("参考基础参数");
    expect(aligned).toContain("候选基础参数");
  });

  test("meta.tools 的候选工具标志：embeddedTypeScript 与原生 hash 明确展示", () => {
    const { markdown, html } = generateReport({
      metrics: metricsOf({
        meta: {
          tools: {
            runner: "Bun 1.4.5",
            platform: "darwin/arm64",
            reference: { path: "/ref/tsc", version: "6.0.3", sha256: "refhash", native: { path: "/ref/native", sha256: "refnative" } },
            candidate: { path: "/impl/bin", version: "bun 1.2", sha256: "implhash", embeddedTypeScript: "5.9.0", native: { path: "/impl/native", sha256: "implnative" } },
          },
        },
      }),
      details: [],
    });
    expect(markdown).toContain("内置 TypeScript `5.9.0`（Bun 内置版本，不是参考 tsc 版本）");
    expect(markdown).toContain("原生 sha256 `implnative`");
    expect(markdown).toContain("原生 sha256 `refnative`");
    expect(html).toContain("内置 TypeScript");
  });

  test("metrics.perf 渲染：Check 口径、兼容通过子集、样本构成与 warnings", () => {
    const perf = {
      enabled: true,
      sample: {
        seed: "s1",
        requested: 20,
        size: 18,
        referenceOk: 18,
        referenceFailed: 2,
        composition: {
          suite: { compiler: 12, conformance: 6 },
          lineBucket: { "<=50": 10, "51-200": 8 },
          errorPresence: { errors: 15, clean: 3 },
          order: { "ref-first": 9, "impl-first": 9 },
        },
      },
      metric: "check",
      impl: { sumWallMs: 100, meanWallMs: 5.5, emptyBaselineMs: 2, checkSumMs: 70 },
      reference: { sumWallMs: 200, meanWallMs: 11.1, emptyBaselineMs: 3, checkSumMs: 100, parseSumMs: 20, bindSumMs: 10, counts: {} },
      ratio: {
        wallAdjusted: 0.94,
        wall: 0.91,
        check: 0.7,
        agreementSubset: {
          cases: 16, implWallMs: 160, referenceWallMs: 200, wall: 0.8, wallAdjusted: 0.9, check: 0.68,
        },
        perCase: {
          check: { n: 18, median: 0.71, geomean: 0.7, p25: 0.6, p75: 0.8 },
          wallAdjusted: null,
        },
      },
      warnings: ["实现未自报 Check 相位；使用 wall − 空程序基线"],
    };
    const metrics = metricsOf({ comparison: { compatibility: { pass: 18, fail: 0, unknown: 0 }, strict: { pass: 17, fail: 1, unknown: 0 }, fields: {} } });
    metrics.perf = perf;
    const { markdown, html } = generateReport({ metrics, details: [] });
    expect(markdown).toContain("## 性能附录");
    expect(markdown).toContain("Check 相位累加（两侧都自报）");
    expect(markdown).toContain("总比值（Check） | 0.700");
    expect(markdown).toContain("总比值（原始实际耗时） | 0.910");
    expect(markdown).toContain("兼容通过子集 | 16 例；原始实际耗时 0.800（160.0 / 200.0 ms）；Check 0.680");
    expect(markdown).toContain("suite：compiler 12，conformance 6");
    expect(markdown).toContain("实现未自报 Check 相位");
    expect(markdown).toContain("性能比值");
    expect(html).toContain("<h2>性能附录</h2>");
    expect(html).toContain("Check 相位累加");
    expect(html).toContain("实现未自报 Check 相位");
  });
});

describe("meta.ratchet / meta.gate.reported", () => {
  test("展示保护档、阻断回归、逐项回归与非阻断摘要；字段回归不阻断", () => {
    const metrics = metricsOf({
      meta: {
        gate: {
          passed: true,
          thresholds: { maxFp: null, maxMiss: null, maxMisanchor: null, minCoverage: null },
          checks: [{ name: "兼容", ok: true, detail: "无兼容回归" }],
          reported: [{ name: "非阻断回归", detail: "1 项不在兼容保护档内" }],
        },
        ratchet: {
          path: "config/ratchet/x.tsv",
          impl: "x",
          initialized: false,
          wrote: false,
          profile: "compatibility",
          regressions: 2,
          blockingRegressions: 0,
          improvements: 1,
          regressionDetails: [
            { id: "a.ts", kind: "strict", was: "pass", now: "fail", reasonKind: "comparison", reason: "严格一致回退", blocking: false },
            { id: "b.ts", kind: "field", field: "message", was: "equal", now: "different", reasonKind: "comparison", reason: "文案变化", blocking: false },
          ],
        },
      },
      comparison: { compatibility: { pass: 1, fail: 0, unknown: 0 }, strict: { pass: 0, fail: 1, unknown: 0 }, fields: {} },
    });
    const { markdown, html } = generateReport({ metrics, details: [newDetails({ comparison: comparisonOf({ strict: "fail" }) })] });
    expect(markdown).toContain("| 回归保护档 | 兼容（阻断 0 项） |");
    expect(markdown).toContain("| `a.ts` | 严格一致 | — | pass → fail | `comparison` | 严格一致回退 | 仅报告 |");
    expect(markdown).toContain("| `b.ts` | 字段 | `message` | equal → different | `comparison` | 文案变化 | 仅报告 |");
    expect(markdown).toContain("仅报告（不参与门禁）");
    expect(markdown).toContain("本次没有阻断项");
    expect(html).toContain("非阻断回归");
    expect(html).toContain("严格一致回退");
  });

  test("旧 ratchet 结构标旧归档，不推断 profile；门槛不把比较失败当阻断", () => {
    const metrics = metricsOf({
      meta: { ratchet: { path: "config/ratchet-ts71-official.tsv", regressions: 1, improvements: 0, wrote: false, initialized: false } },
      comparison: { compatibility: { pass: 0, fail: 1, unknown: 0 }, strict: { pass: 0, fail: 1, unknown: 0 }, fields: {} },
    });
    const { markdown } = generateReport({ metrics, details: [newDetails()] });
    expect(markdown).toContain("回归记录（旧 T0–T3 归档）");
    expect(markdown).toContain("没有 profile / regressionDetails / blocking 信息");
    expect(markdown).toContain("旧记录未提供阻断信息");
    expect(markdown).toContain("本次没有阻断项");
  });
});

describe("报告数据逃逸", () => {
  test("diagnostic/related/options/ratchet/gate 中的 HTML 与 Markdown 特殊字符全部惰性", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const details = newDetails({
      id: `evil"><script>alert("id")</script>`,
      expected: [{ file: "a.ts", line: 0, col: 0, code: 2322, severity: "error", message: evil }],
      actualOutput: `line\n${evil}\n| pipe`,
      expectedArgs: [`--x=${evil}`, "a|b"],
      options: [{ name: `<option>`, value: evil }],
      comparison: comparisonOf({ fields: { ...NEW_FIELDS, message: "different" } }),
    });
    const detail = newDetails({
      id: "escape.ts",
      expectedArgs: [`--x=${evil}`, "a|b"],
      actualArgs: [`--y=${evil}`],
      options: [{ name: `<option>`, value: evil }],
      expectedOutput: `line\n${evil}\n| pipe`,
    });
    const metrics = metricsOf({
      meta: {
        gate: { passed: true, thresholds: {}, checks: [{ name: evil, ok: true, detail: evil }], reported: [{ name: evil, detail: evil }] },
        ratchet: {
          path: evil,
          impl: evil,
          initialized: false,
          wrote: false,
          profile: "compatibility",
          regressions: 1,
          blockingRegressions: 1,
          improvements: 0,
          regressionDetails: [{ id: evil, kind: "field", field: evil, was: evil, now: evil, reasonKind: "comparison", reason: evil, blocking: true }],
        },
        manifest: { path: evil, sha256: evil },
        options: { strategy: "aligned", referenceBaseArgs: [evil], sharedArgs: [evil], candidateArgs: [evil], candidateEnvArgs: [evil], onlyClasses: [evil], excludeClasses: [] },
        tools: { runner: evil, platform: evil, reference: { path: evil, version: evil, sha256: evil }, candidate: { path: evil, version: evil, sha256: evil } },
      },
      comparison: { compatibility: { pass: 0, fail: 1, unknown: 0 }, strict: { pass: 0, fail: 1, unknown: 0 }, fields: {} },
      skips: [[evil, 1]],
      samples: { fp: [evil], miss: [], textDiff: [], messageDiff: [], t3: [] },
    });
    const { markdown, html } = generateReport({ metrics, details: [details, detail] }, { title: evil, notes: [evil], implName: evil });
    expect(html).not.toContain(evil);
    expect(html).not.toContain("<script>alert(\"id\")</script>");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/<img\b/);
    expect(markdown).not.toContain('\n<script>alert("id")</script>');
    // 表格/正文路径会转义 `<`；行内代码路径不求转义，但反引号会被围栏包住，不会激活 HTML。
    expect(markdown).not.toContain('<img src=x onerror="alert(1)">\n');
    expect(markdown).toContain("`<img src=x onerror=\"alert(1)\">`");
    expect(markdown).toContain("&lt;img src=x");
    expect(markdown).toContain("`--x=<img src=x onerror=\"alert(1)\"> a\\|b`");
  });
});

describe("报告 delta 与逐例回归", () => {
  test("用例头部同时展示选中（配置）与实际（展开后）数量", () => {
    const metrics = metricsOf({ meta: { selectedCases: 1 }, totals: { cases: 2, ran: 2 } });
    const { markdown, html } = generateReport({ metrics, details: [newDetails(), newDetails({ id: "compiler/b.ts" })] });
    expect(markdown).toContain("选中 1（源用例）/ 实际 2（展开后）");
    expect(html).toContain("选中 1（源用例） / 实际 2（展开后）");
  });

  test("v2 delta：manifest 文件字节变化但选中用例集合相同时仍可比较", () => {
    const previous = {
      metrics: v2Metrics({
        manifest: { ...SAME_V2_SCOPE, sha256: "manifest-before" },
        optionStrategy: "defaults",
      }),
      details: [newDetails()],
    };
    const current = {
      metrics: v2Metrics({
        manifest: { ...SAME_V2_SCOPE, sha256: "manifest-after" },
        optionStrategy: "defaults",
      }),
      details: [newDetails()],
    };
    const { markdown } = generateReport(current, { previous });
    expect(markdown).not.toContain("范围提示");
    expect(markdown).toContain("兼容档 · 通过 | 1 | 1 | 0");
  });

  test("v2 delta：manifest 列表变化且没有选择哈希时提示不可比，不报严格一致回归", () => {
    const previous = {
      metrics: v2Metrics({ strict: "fail", manifest: { path: "cases.json", sha256: "manifest-before" } }),
      details: [newDetails({ comparison: comparisonOf({ strict: "fail", fields: { ...NEW_FIELDS, message: "different" } }) })],
    };
    const current = {
      metrics: v2Metrics({ manifest: { path: "cases.json", sha256: "manifest-after" } }),
      details: [newDetails()],
    };
    const { markdown, html } = generateReport(current, { previous });
    expect(markdown).toContain("用例列表不同");
    expect(html).toContain("用例列表不同");
    expect(markdown).not.toContain("严格一致档：通过 → 失败");
    expect(markdown).not.toContain("**逐例变化（1 例回归");
  });

  test("v2 delta：未知字段与移除/跳过只对既有 pass/equal 证据报回归", () => {
    const previous = {
      metrics: v2Metrics({ manifest: SAME_V2_SCOPE }),
      details: [
        newDetails({ id: "compiler/a.ts" }),
        newDetails({ id: "compiler/b.ts" }),
        newDetails({
          id: "compiler/unverified.ts",
          comparison: comparisonOf({ compatibility: "unknown", strict: "unknown", fields: Object.fromEntries(Object.keys(NEW_FIELDS).map((field) => [field, "unavailable"])) }),
        }),
      ],
    };
    const current = {
      metrics: v2Metrics({ manifest: SAME_V2_SCOPE }),
      details: [newDetails({ id: "compiler/b.ts", status: "skip", skipReason: "实现返回 timeout" })],
    };
    const { markdown } = generateReport(current, { previous });
    expect(markdown).toContain("已从本次范围移除");
    expect(markdown).toContain("不再运行：实现返回 timeout");
    expect(markdown).toContain("2 例回归");
    expect(markdown).not.toContain("compiler/unverified.ts");
  });

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

  test("v2 delta：严格一致 pass → 仅兼容是字段/逐例回归，不按 legacy T3 推断", () => {
    const previous = {
      metrics: v2Metrics({ strict: "pass", generatedAt: "2026-11-15T00:00:00.000Z", manifest: SAME_V2_SCOPE }),
      details: [newDetails({ comparison: comparisonOf({ strict: "pass" }) })],
    };
    const current = {
      metrics: v2Metrics({ strict: "fail", manifest: SAME_V2_SCOPE }),
      details: [newDetails({ comparison: comparisonOf({ strict: "fail", fields: { ...NEW_FIELDS, message: "different" } }) })],
    };
    const { markdown, html } = generateReport(current, { previous });
    expect(markdown).toContain("严格一致档：通过 → 失败");
    expect(markdown).toContain("字段 首行文字：相同 → 不同");
    expect(markdown).toContain("严格一致档 · 通过");
    expect(html).toContain("严格一致档：通过 → 失败");
  });

  test("v2 delta：字段从 equal 变为 unknown 赋值给 unavailable；未验证项不补造回归", () => {
    const previous = {
      metrics: v2Metrics({ manifest: SAME_V2_SCOPE }),
      details: [
        newDetails({ comparison: comparisonOf({ fields: { ...NEW_FIELDS, related: "equal" } }) }),
        newDetails({ id: "compiler/b.ts", comparison: comparisonOf({ fields: { ...NEW_FIELDS, related: "unavailable" } }) }),
      ],
    };
    const current = {
      metrics: v2Metrics({ manifest: SAME_V2_SCOPE }),
      details: [
        newDetails({ comparison: comparisonOf({ fields: { ...NEW_FIELDS, related: "unavailable" } }) }),
        newDetails({ id: "compiler/b.ts", comparison: comparisonOf({ fields: { ...NEW_FIELDS, related: "different" } }) }),
      ],
    };
    const { markdown } = generateReport(current, { previous });
    expect(markdown).toContain("字段 related：相同 → 未提供");
    // 字段汇总来自 metrics.comparison；fixture 的汇总仍是全部 equal，因此这里只
    // 查逐例明细。b.ts 之前没有 related=equal 的验证证据，unavailable → different
    // 是新差异，不算历史回归。
    expect(markdown).toContain("- 字段差异：\n  - related 信息：不同");
    expect(markdown).not.toContain("字段 related：未提供 → 不同");
    // 只有 a.ts 从 equal 退步，故仅 1 例回归。
    expect(markdown).toContain("1 例回归");
  });

  test("v2 delta：manifest/解析输入/期望源/选项策略不一致时，两档和字段只展示，不报回归", () => {
    const previous = {
      metrics: v2Metrics({
        strict: "fail",
        manifest: { ...SAME_V2_SCOPE, parsedInputsSha256: "parsed-old", officialInputsSha256: "official-old" },
        expectationSource: "tsc",
        optionStrategy: "defaults",
      }),
      details: [newDetails({ comparison: comparisonOf({ strict: "fail", fields: { ...NEW_FIELDS, message: "different" } }) })],
    };
    const current = {
      metrics: v2Metrics({
        strict: "pass",
        manifest: SAME_V2_SCOPE,
        expectationSource: "official-baseline",
        optionStrategy: "aligned",
      }),
      details: [newDetails({ comparison: comparisonOf({ strict: "pass" }) })],
    };
    const { markdown, html } = generateReport(current, { previous });
    expect(markdown).toContain("范围提示");
    expect(markdown).toContain("解析后的用例输入不同");
    expect(markdown).toContain("期望源不同");
    expect(markdown).toContain("选项策略不同");
    expect(markdown).toContain("n/a（范围不可比）");
    expect(html).toContain("范围提示");
    expect(html).toContain("n/a（范围不可比）");
    expect(markdown).not.toContain("**逐例变化（1 例回归");
  });

  test.each([
    ["同源不同目标", "es2015", "es2020", "目标配置选择不同"],
    ["只有旧报告有摘要", "es2015", null, "目标配置选择缺少一侧记录，无法对照"],
    ["只有新报告有摘要", null, "es2020", "目标配置选择缺少一侧记录，无法对照"],
  ])("v2 delta：%s 不可比，不把未选中的配置报成回归", (_name, before, after, reason) => {
    const manifestFor = (target: string | null) => ({
      ...SAME_V2_SCOPE,
      ...(target === null ? {} : { selectedTargetsSha256: `selected-${target}` }),
    });
    const previous = {
      metrics: v2Metrics({ manifest: manifestFor(before) }),
      details: [newDetails({ id: "compiler/a(target=es2015).ts" })],
    };
    const current = {
      metrics: v2Metrics({ manifest: manifestFor(after), strict: "fail" }),
      details: [newDetails({ id: "compiler/a(target=es2020).ts", comparison: comparisonOf({ strict: "fail" }) })],
    };
    const { markdown, html } = generateReport(current, { previous });
    for (const report of [markdown, html]) {
      expect(report).toContain(reason);
      expect(report).toContain("n/a（范围不可比）");
      expect(report).not.toContain("已从本次范围移除");
    }
  });

  test("精确配置报告与没有配置摘要的旧版 T0–T3 报告不可比", () => {
    const id = "compiler/a(target=es2015).ts";
    const previous = { metrics: metricsOf(), details: detailsWithTier([[id, "full"]]) };
    const current = {
      metrics: v2Metrics({ manifest: { ...SAME_V2_SCOPE, selectedTargetsSha256: "selected-es2015" } }),
      details: [newDetails({ id, tier: "text" })],
    };
    const { markdown, html } = generateReport(current, { previous });
    for (const report of [markdown, html]) {
      expect(report).toContain("目标配置选择缺少一侧记录，无法对照");
      expect(report).toContain("n/a（范围不可比）");
      expect(report).not.toContain("T3 全文 → T2 文案");
    }
  });

  test("v2 delta：目标配置摘要相同仍报告真实回归", () => {
    const manifest = { ...SAME_V2_SCOPE, selectedTargetsSha256: "selected-es2015" };
    const id = "compiler/a(target=es2015).ts";
    const previous = { metrics: v2Metrics({ manifest }), details: [newDetails({ id })] };
    const current = {
      metrics: v2Metrics({ manifest, strict: "fail" }),
      details: [newDetails({ id, comparison: comparisonOf({ strict: "fail" }) })],
    };
    const { markdown, html } = generateReport(current, { previous });
    for (const report of [markdown, html]) {
      expect(report).not.toContain("范围提示");
      expect(report).toContain("严格一致档：通过 → 失败");
    }
  });

  test("v2 delta：officialInputsSha256 不同也提示范围不可比", () => {
    const previous = {
      metrics: v2Metrics({ manifest: SAME_V2_SCOPE }),
      details: [newDetails()],
    };
    const current = {
      metrics: v2Metrics({ manifest: { ...SAME_V2_SCOPE, officialInputsSha256: "official-changed" } }),
      details: [newDetails()],
    };
    const { markdown, html } = generateReport(current, { previous });
    expect(markdown).toContain("官方基线输入不同");
    expect(html).toContain("官方基线输入不同");
  });

  test("v2 delta：缺少可对照 input hash 时也警告，不推断字段/两档回归", () => {
    const previous = {
      metrics: v2Metrics({ manifest: { path: "cases.json", sha256: "manifest-same" } }),
      details: [newDetails()],
    };
    const current = {
      metrics: v2Metrics({ manifest: { path: "cases.json", sha256: "manifest-same", parsedInputsSha256: "parsed-only-current" } }),
      details: [newDetails()],
    };
    const { markdown, html } = generateReport(current, { previous });
    expect(markdown).toContain("解析后的用例输入缺少一侧记录，无法对照");
    expect(html).toContain("解析后的用例输入缺少一侧记录，无法对照");
    expect(markdown).toContain("n/a（范围不可比）");
  });

  test("旧版 T0–T3 产物仍保留原来的逐例 tier delta", () => {
    const previous = { metrics: metricsOf(), details: detailsWithTier([["compiler/a.ts", "full"]]) };
    const current = {
      metrics: metricsOf(),
      details: [{ id: "compiler/a.ts", status: "ran", expected: 1, actual: 1, hits: 1, fp: [], missed: [], misanchor: 0, tier: "text" }],
    };
    const { markdown } = generateReport(current, { previous });
    expect(markdown).toContain("T3 全文 → T2 文案");
    expect(markdown).toContain("逐例变化（1 例回归");
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
    expect(readFileSync(md, "utf8")).not.toContain("&lt;");
    expect(readFileSync(md, "utf8")).toContain("重跑 bun src/report.ts");
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

  test("CLI 缺省读 <dir>/prev/metrics.json 作 delta；显式 --prev-report 缺失则报错", () => {
    const dir = tempDir("tsc-compa-report-prev-");
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metricsOf()));
    writeFileSync(join(dir, "details.json"), JSON.stringify(BASE_DETAILS));
    mkdirSync(join(dir, "prev"), { recursive: true });
    writeFileSync(
      join(dir, "prev", "metrics.json"),
      JSON.stringify(
        metricsOf({
          meta: { generatedAt: "2026-11-15T00:00:00.000Z" },
          totals: { coverage: 1, hitTotal: 4, fpCases: 0, fpTotal: 0, passCases: 3 },
        }),
      ),
    );
    const md = join(dir, "report.md");
    const r = spawnReport(["--from", dir, "--md", md]);
    expect(r.status).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("对比基准：2026-11-15T00:00:00.000Z");
    const bad = spawnReport(["--from", dir, "--md", join(dir, "bad.md"), "--prev-report", join(dir, "missing.json")]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("--prev-report");
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

  test("有 prev 时：run.ts 报告与 report CLI 重生成逐字节一致（两者默认同一份 prev）", () => {
    const fixture = gateFixture();
    mkdirSync(join(fixture.out, "prev"), { recursive: true });
    writeFileSync(
      join(fixture.out, "prev", "metrics.json"),
      JSON.stringify(
        metricsOf({
          meta: { generatedAt: "2026-11-15T00:00:00.000Z" },
          totals: { coverage: 1, hitTotal: 1, fpCases: 0, fpTotal: 0, passCases: 1 },
        }),
      ),
    );
    const md = join(fixture.out, "report.md");
    const html = join(fixture.out, "report.html");
    const r = spawnRun(fixture, [...baseArgs(fixture), "--report-md", md, "--report-html", html]);
    expect(r.status).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("对比基准：2026-11-15T00:00:00.000Z");
    const md2 = join(fixture.dir, "regen.md");
    const html2 = join(fixture.dir, "regen.html");
    const cli = spawnSync(
      process.execPath,
      ["src/report.ts", "--from", fixture.out, "--md", md2, "--html", html2],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(cli.status).toBe(0);
    expect(readFileSync(md2, "utf8")).toBe(readFileSync(md, "utf8"));
    expect(readFileSync(html2, "utf8")).toBe(readFileSync(html, "utf8"));
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
    const largeBody = "完整诊断正文\n".repeat(80_000);
    writeEntry(root, "report-7.1.0-beta-official", failedMetrics, `# 7.1 official\n\n假阳性 1\n${largeBody}`, "<html>bad</html>");
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
    const stepSummary = join(root, "step-summary.md");
    const run = (...extra: string[]): { status: number | null; stdout: string } => {
      const r = spawnSync(
        process.execPath,
        ["scripts/merge-reports.ts", "--root", root, "--md", md, "--html", html, "--run-url", "https://ci.example/run/1", ...extra],
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
    expect(summary).toContain("| 7.1.0-beta-self | 7.1.0-beta / official | 3/3 | 未提供 | 未提供 | 75.0% | 1 例 / 1 条 | 1 | 0 | 0 | n/a | 未启用 |");
    expect(summary).toContain("全部通过");
    expect(summary).toContain("假阳性 1");
    const index = readFileSync(html, "utf8");
    expect(index).toContain("tsc-compa 兼容性报告汇总");
    expect(index).toContain('href="report-6.0.3-self/report.html"');
    expect(index).toContain('class="status-bad"');
    expect(Buffer.byteLength(summary, "utf8")).toBeGreaterThan(1024 * 1024);
    expect(summary).toContain(largeBody.trimEnd());
    expect(run("--step-summary", stepSummary).status).toBe(0);
    // 请求预览不会改变完整产物；预览逐字节保留聚合表，但不嵌入逐档正文。
    expect(readFileSync(md, "utf8")).toBe(summary);
    expect(readFileSync(html, "utf8")).toBe(index);
    const compact = readFileSync(stepSummary, "utf8");
    expect(Buffer.byteLength(compact, "utf8")).toBeLessThan(1024 * 1024);
    const table = (markdown: string): string[] => markdown.split("\n").filter((line) => line.startsWith("|"));
    expect(table(compact)).toEqual(table(summary));
    expect(compact).toContain("**门禁失败档位（1）**：7.1.0-beta-official");
    expect(compact).toContain("无 metrics（运行失败）");
    expect(compact).toContain("`report-summary`");
    expect(compact).toContain("`summary.md` 或 `index.html`");
    expect(compact).not.toContain("<details>");
    expect(compact).not.toContain("完整诊断正文");
    expect(run("--step-summary", stepSummary).status).toBe(0);
    expect(readFileSync(stepSummary, "utf8")).toBe(compact);
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
