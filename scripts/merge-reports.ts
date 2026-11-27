// 合并各档兼容性报告：把 smoke matrix 每个档位产出的 metrics.json / report.md /
// report.html 汇总成一份 Markdown 摘要（写进 $GITHUB_STEP_SUMMARY）与一份可下载的
// 静态 HTML 索引（report/index.html，逐档链接到各自的 report.html）。
//
// 输入目录约定（CI 里由 actions/download-artifact 组装）：
//   <root>/<档位目录>/{metrics.json, details.json, report.md, report.html}
// 缺 metrics.json 的档位（运行在写出结果前就失败）仍会列进摘要并标注「无 metrics」，
// 不静默消失。目录与行序都按名字排序，保证同样的输入产出同样的字节。
//
// 用法：
//   bun scripts/merge-reports.ts --root report \
//     [--md report/summary.md] [--html report/index.html] [--run-url <CI run URL>]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { escapeHtml, neutralImplName, readRunData, REPORT_CSS } from "../src/report.ts";

interface Entry {
  /** 档位目录名（CI artifact 名，形如 report-<matrix.slug>）。 */
  slug: string;
  /** 展示用档位名：去掉 artifact 的 report- 前缀。 */
  label: string;
  dir: string;
  /** metrics.json 是否存在且可读。 */
  metricsOk: boolean;
  suite: string | null;
  baseline: string | null;
  mode: string | null;
  expectationSource: string | null;
  impl: string | null;
  cases: number;
  ran: number;
  coverage: number | null;
  fpCases: number;
  fpTotal: number;
  missTotal: number;
  misanchorTotal: number;
  skipped: number;
  t3Full: number | null;
  /** metrics.comparison 的两档分布；旧报告缺字段时为 null。 */
  compatibility: { pass: number; fail: number; unknown: number } | null;
  strict: { pass: number; fail: number; unknown: number } | null;
  /** undefined = 没启用门禁；true/false = 门禁结论。 */
  gatePassed: boolean | undefined;
  reportMd: string | null;
  hasHtml: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => num(v) ?? 0;
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const pct = (ratio: number | null): string => (ratio === null ? "n/a" : `${(ratio * 100).toFixed(1)}%`);

const displayLabel = (slug: string): string => (slug.startsWith("report-") ? slug.slice("report-".length) : slug);

function readEntry(root: string, slug: string): Entry {
  const dir = join(root, slug);
  const reportMdPath = join(dir, "report.md");
  const reportMd = existsSync(reportMdPath) ? readFileSync(reportMdPath, "utf8") : null;
  const hasHtml = existsSync(join(dir, "report.html"));
  const data = readRunData(dir);
  if (data === null) {
    return {
      slug,
      label: displayLabel(slug),
      dir,
      metricsOk: false,
      suite: null,
      baseline: null,
      mode: null,
      expectationSource: null,
      impl: null,
      cases: 0,
      ran: 0,
      coverage: null,
      fpCases: 0,
      fpTotal: 0,
      missTotal: 0,
      misanchorTotal: 0,
      skipped: 0,
      t3Full: null,
      compatibility: null,
      strict: null,
      gatePassed: undefined,
      reportMd,
      hasHtml,
    };
  }
  const metrics = obj(data.metrics);
  const meta = obj(metrics.meta);
  const totals = obj(metrics.totals);
  const byTier = obj(totals.byTier);
  const gate = obj(meta.gate);
  const adapter = text(meta.adapter);
  const comparison = obj(metrics.comparison);
  const verdicts = (value: unknown): { pass: number; fail: number; unknown: number } | null => {
    const counts = obj(value);
    const pass = num(counts.pass);
    const fail = num(counts.fail);
    const unknown = num(counts.unknown);
    return pass === null || fail === null || unknown === null ? null : { pass, fail, unknown };
  };
  return {
    slug,
    label: displayLabel(slug),
    dir,
    metricsOk: true,
    suite: text(meta.suite),
    baseline: text(meta.baseline),
    mode: text(meta.mode),
    expectationSource: text(meta.expectationSource),
    impl: neutralImplName(adapter),
    cases: int(totals.cases),
    ran: int(totals.ran),
    coverage: num(totals.coverage),
    fpCases: int(totals.fpCases),
    fpTotal: int(totals.fpTotal),
    missTotal: int(totals.missTotal),
    misanchorTotal: int(totals.misanchorTotal),
    skipped: int(totals.skipped),
    // T3 全文档只在期望源是官方 .errors.txt 基线时可比；其它口径显示 n/a。
    t3Full: text(meta.expectationSource) === "official-baseline" ? (num(byTier.full) ?? 0) : null,
    compatibility: verdicts(comparison.compatibility),
    strict: verdicts(comparison.strict),
    gatePassed: meta.gate === undefined || meta.gate === null ? undefined : gate.passed === true,
    reportMd,
    hasHtml,
  };
}

const verdictText = (counts: { pass: number; fail: number; unknown: number } | null): string =>
  counts === null ? "未提供" : `${counts.pass}/${counts.fail}/${counts.unknown}`;

function gateLabel(entry: Entry): string {
  if (!entry.metricsOk) return "—";
  if (entry.gatePassed === undefined) return "未启用";
  return entry.gatePassed ? "通过" : "**失败**";
}

function summaryTable(entries: Entry[]): string[] {
  const lines = [
    "| 档位 | 基线 / 模式 | 用例（跑/总） | 兼容（通/败/未知） | 严格（通/败/未知） | 覆盖率 | 假阳性 | 漏报 | 错锚 | 跳过 | 旧 T3（仅参考） | 门禁 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    const title = entry.metricsOk ? `${entry.baseline ?? entry.suite ?? "n/a"} / ${entry.mode ?? "n/a"}` : "无 metrics（运行失败）";
    const t3 = entry.t3Full === null ? "n/a" : String(entry.t3Full);
    lines.push(
      `| ${escapePipe(entry.label)} | ${escapePipe(title)} | ${entry.ran}/${entry.cases} | ` +
        `${verdictText(entry.compatibility)} | ${verdictText(entry.strict)} | ${pct(entry.coverage)} | ` +
        `${entry.fpCases} 例 / ${entry.fpTotal} 条 | ${entry.missTotal} | ${entry.misanchorTotal} | ${entry.skipped} | ${t3} | ${gateLabel(entry)} |`,
    );
  }
  return lines;
}

const escapePipe = (value: string): string => escapeHtml(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function renderMarkdown(entries: Entry[], runUrl: string | null, generatedFrom: string): string {
  const lines: string[] = ["# tsc-compa 兼容性报告汇总", ""];
  if (runUrl !== null) {
    lines.push(`CI run：${runUrl}（完整 HTML 报告在本次 run 的 Artifacts 里，下载 \`report-summary\` 打开 \`index.html\`）`);
    lines.push("");
  }
  const failed = entries.filter((entry) => entry.gatePassed === false);
  if (failed.length > 0) {
    lines.push(`> **门禁失败档位（${failed.length}）**：${failed.map((entry) => entry.label).join("、")}`);
    lines.push("");
  }
  lines.push(`共 ${entries.length} 档报告（数据目录：\`${generatedFrom}\`）。`);
  lines.push("");
  lines.push(...summaryTable(entries));
  for (const entry of entries) {
    lines.push("");
    lines.push("<details>");
    lines.push(`<summary>${escapeHtml(entry.label)}：完整报告</summary>`);
    lines.push("");
    if (entry.reportMd !== null) {
      lines.push(entry.reportMd.trimEnd());
    } else {
      lines.push(`本档位没有 report.md（没有 metrics.json，运行应该在写出结果前就失败了）。`);
    }
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  lines.push(
    "说明：兼容 ↔ 严格列是 `metrics.comparison` 的（通过/失败/无法确认）用例数；旧报告缺这两列时记「未提供」。T3 全文只是旧 T0–T3 阶梯的最高档，不能当作严格一致；是否阻断以门禁列为准。",
  );
  return `${lines.join("\n")}\n`;
}

function renderHtml(entries: Entry[], runUrl: string | null): string {
  const rows = entries
    .map((entry) => {
      const title = entry.metricsOk ? `${entry.baseline ?? entry.suite ?? "n/a"} / ${entry.mode ?? "n/a"}` : "无 metrics（运行失败）";
      const reportLink =
        entry.hasHtml && entry.reportMd !== null
          ? `<a href="${encodeURIComponent(entry.slug)}/report.html">HTML 报告</a>`
          : "（无 HTML 报告）";
      const gateClass = entry.gatePassed === undefined ? "" : entry.gatePassed ? "status-ok" : "status-bad";
      const gateCell =
        entry.gatePassed === undefined
          ? "未启用"
          : `<span class="${gateClass}">${entry.gatePassed ? "通过" : "失败"}</span>`;
      const pairCell = (counts: { pass: number; fail: number; unknown: number } | null): string => {
        if (counts === null) return "未提供";
        const tone = counts.fail > 0 ? "status-bad" : counts.unknown > 0 ? "" : "status-ok";
        return `<span class="${tone}">${escapeHtml(verdictText(counts))}</span>`;
      };
      return (
        `<tr><td><code>${escapeHtml(entry.label)}</code></td><td>${escapeHtml(title)}</td>` +
        `<td>${entry.ran}/${entry.cases}</td><td>${pairCell(entry.compatibility)}</td><td>${pairCell(entry.strict)}</td>` +
        `<td>${escapeHtml(pct(entry.coverage))}</td>` +
        `<td>${entry.fpCases} 例 / ${entry.fpTotal} 条</td><td>${entry.missTotal}</td>` +
        `<td>${entry.misanchorTotal}</td><td>${entry.skipped}</td>` +
        `<td>${gateCell}</td><td>${reportLink}</td></tr>`
      );
    })
    .join("\n");
  const runNote =
    runUrl === null ? "" : `<p class="note">CI run：<a href="${escapeHtml(runUrl)}">${escapeHtml(runUrl)}</a></p>`;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>tsc-compa 兼容性报告汇总</title>",
    `<style>\n${REPORT_CSS}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>tsc-compa 兼容性报告汇总</h1>",
    runNote,
    `<p class="note">共 ${entries.length} 档。点每行的「HTML 报告」查看该档完整报告；兼容/严格两列是两档比较的用例数，旧 T3 只作过渡参考。</p>`,
    "<table>",
    "<thead><tr><th>档位</th><th>基线 / 模式</th><th>用例（跑/总）</th><th>兼容（通/败/未知）</th><th>严格（通/败/未知）</th><th>覆盖率</th><th>假阳性</th><th>漏报</th><th>错锚</th><th>跳过</th><th>门禁</th><th>报告</th></tr></thead>",
    `<tbody>\n${rows}\n</tbody>`,
    "</table>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

interface Args {
  root: string;
  md?: string;
  html?: string;
  runUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: "report" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    switch (arg) {
      case "--root":
        args.root = next();
        break;
      case "--md":
        args.md = next();
        break;
      case "--html":
        args.html = next();
        break;
      case "--run-url":
        args.runUrl = next();
        break;
      case "--help":
      case "-h":
        console.log(
          "用法：bun scripts/merge-reports.ts [--root <目录>] [--md <path>] [--html <path>] [--run-url <URL>]；" +
            "root 下每个子目录是一档报告的 {metrics.json, report.md, report.html}。",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  args.md ??= join(args.root, "summary.md");
  args.html ??= join(args.root, "index.html");
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`报告目录不存在：${root}`);
  }
  const slugs = readdirSync(root)
    .filter((name) => {
      const full = join(root, name);
      return statSync(full).isDirectory();
    })
    .sort((a, b) => a.localeCompare(b));
  if (slugs.length === 0) {
    throw new Error(`报告目录里没有任何档位子目录：${root}（各档 artifact 是否都没上传？）`);
  }
  const entries = slugs.map((slug) => readEntry(root, slug));
  const markdown = renderMarkdown(entries, args.runUrl ?? null, args.root);
  const html = renderHtml(entries, args.runUrl ?? null);
  for (const target of [args.md!, args.html!]) mkdirSync(dirname(resolve(target)), { recursive: true });
  writeFileSync(args.md!, markdown);
  writeFileSync(args.html!, html);
  const failed = entries.filter((entry) => entry.gatePassed === false).length;
  const missing = entries.filter((entry) => !entry.metricsOk).length;
  console.log(
    `已合并 ${entries.length} 档报告：门禁失败 ${failed} 档、无 metrics ${missing} 档 → ${args.md}、${args.html}`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
