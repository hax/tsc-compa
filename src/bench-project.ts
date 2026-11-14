// 真实项目目录的相位计时（--bench --project）：与兼容性验证彻底分开。
//
// 口径（与 conformance 套件无关）：
// - 对一个真实项目目录跑各实现的 CLI，取 tsc 系实现的 `--extendedDiagnostics`
//   相位（Parse / Bind / Check / Total）；公平头条指标 = **Check 相位**；
// - Parse/Bind 属于「用户文件处理」，留在计时里；lib 构建由实现自己的相位
//   口径体现（tsc 的 Parse 含 lib；maat 不加载 lib），结果里注明相位来源；
// - 没有相位报告的实现退回 wall（含诊断渲染），meta 标 `wall-fallback` 且
//   `includesRendering=true`，不与 Check 相位横比；
// - 每档跑 N 轮：第 1 轮记 cold（冷页缓存/冷 JIT），后续轮取中位记 warm；
//   两者不混成一个数。
//
// 输出 <out>/bench-project.json。

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PhaseTimings {
  parseMs?: number;
  bindMs?: number;
  checkMs?: number;
  totalMs?: number;
  startMs?: number;
}

export interface ProjectRun {
  wallMs: number;
  phases: PhaseTimings | null;
  diagnostics: number;
  exitStatus: number | null;
  error?: string;
}

export interface ProjectImplResult {
  spec: string;
  kind: "tsc" | "maat" | "generic";
  bin: string;
  phaseSource: "extendedDiagnostics" | "wall-fallback";
  includesRendering: boolean;
  args: string[];
  diagnostics: number;
  runs: ProjectRun[];
  cold: ProjectRun;
  warm: PhaseTimings & { wallMs: number };
  /** Check 相位（tsc 系）中位；wall 回退实现为 null。 */
  checkMs: number | null;
  /** 每轮 phase 合计；wall 回退实现为 null。 */
  totalMs: number | null;
  startupMs: number | null;
}

export interface ProjectBenchReport {
  meta: {
    suite: "bench-project";
    schema: 1;
    project: string;
    reps: number;
    generatedAt: string;
    headlineMetric: "check phase (auto-reported) / wall fallback";
    cacheTiers: "cold = run #1; warm = median of runs #2..N";
    note: "相位来源与是否含渲染逐实现记录；不同相位来源的数字不可横比";
  };
  implementations: ProjectImplResult[];
}

const PHASE_PATTERNS: Record<keyof PhaseTimings, RegExp> = {
  parseMs: /^Parse time:\s*([\d.]+)s/m,
  bindMs: /^Bind time:\s*([\d.]+)s/m,
  checkMs: /^Check time:\s*([\d.]+)s/m,
  totalMs: /^Total time:\s*([\d.]+)s/m,
  startMs: /^Program time:\s*([\d.]+)s/m,
};

const DIAG_LINE = /(?:^|\n)[^\n]*?\berror TS\d+/g;

export function parsePhases(output: string): PhaseTimings | null {
  const phases: PhaseTimings = {};
  let found = false;
  for (const [key, re] of Object.entries(PHASE_PATTERNS) as [keyof PhaseTimings, RegExp][]) {
    const m = re.exec(output);
    if (m === null) continue;
    phases[key] = Math.round(Number(m[1]) * 1000 * 100) / 100;
    found = true;
  }
  return found ? phases : null;
}

export function countDiagnostics(output: string): number {
  return (output.match(DIAG_LINE) ?? []).length;
}

export interface ParsedImplSpec {
  kind: "tsc" | "maat" | "generic";
  bin: string;
  /** spec 里的 `::arg1;arg2` 附加参数（例如 maat 的 --noMessages 渲染档）。 */
  extraArgs: string[];
}

export function parseImplSpec(raw: string): ParsedImplSpec {
  const sep = raw.indexOf("::");
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  const extraArgs = sep >= 0 ? raw.slice(sep + 2).split(";").map((a) => a.trim()).filter((a) => a.length > 0) : [];
  const idx = head.indexOf(":");
  if (idx <= 0) throw new Error(`实现 spec 需要 kind:bin（tsc:<bin> / maat:<bin>），收到 ${raw}`);
  const kind = head.slice(0, idx);
  const bin = head.slice(idx + 1);
  if (kind !== "tsc" && kind !== "maat" && kind !== "generic") {
    throw new Error(`未知实现类型 ${kind}；可用 tsc / maat / generic`);
  }
  if (bin.length === 0) throw new Error(`实现 spec 缺少 bin：${raw}`);
  return { kind, bin, extraArgs };
}

/** 各实现的 CLI 调用；只允许「跑项目检查」，不附加兼容性套件的选项。 */
export function invocationFor(
  kind: "tsc" | "maat" | "generic",
  project: string,
): string[] {
  if (kind === "tsc") {
    return ["--noEmit", "--extendedDiagnostics", "--pretty", "false", "-p", project];
  }
  if (kind === "maat") {
    return [`--project=${project}`];
  }
  return [project];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function phaseMedian(runs: ProjectRun[], key: keyof PhaseTimings): number | null {
  const values = runs.map((r) => r.phases?.[key]).filter((v): v is number => typeof v === "number");
  return values.length === 0 ? null : round2(median(values));
}

export interface ProjectBenchOptions {
  project: string;
  implementations: string[];
  reps: number;
  outDir: string;
  timeoutMs?: number;
}

export function runProjectBench(opts: ProjectBenchOptions): ProjectBenchReport {
  if (opts.reps < 1) throw new Error("--reps 需要 >=1");
  if (opts.implementations.length === 0) throw new Error("需要至少一个实现（--bench-impls tsc:<bin>,maat:<bin>）");
  const results: ProjectImplResult[] = [];
  for (const spec of opts.implementations) {
    const { kind, bin, extraArgs } = parseImplSpec(spec);
    const args = [...invocationFor(kind, opts.project), ...extraArgs];
    const runs: ProjectRun[] = [];
    for (let rep = 0; rep < opts.reps; rep++) {
      const start = performance.now();
      const r = spawnSync(bin, args, {
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: opts.timeoutMs ?? 300_000,
      });
      const wallMs = round2(performance.now() - start);
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.error !== undefined) {
        runs.push({ wallMs, phases: null, diagnostics: 0, exitStatus: null, error: String(r.error) });
        continue;
      }
      runs.push({
        wallMs,
        phases: parsePhases(output),
        diagnostics: countDiagnostics(output),
        exitStatus: r.status,
      });
    }
    const cold = runs[0]!;
    const warmRuns = runs.length > 1 ? runs.slice(1) : runs;
    const phaseSource = runs.some((r) => r.phases !== null)
      ? "extendedDiagnostics"
      : "wall-fallback";
    const checkMs = phaseMedian(warmRuns, "checkMs");
    const totalMs = phaseMedian(warmRuns, "totalMs");
    const parseBind = phaseMedian(warmRuns, "parseMs");
    const bind = phaseMedian(warmRuns, "bindMs");
    const startupMs =
      totalMs !== null && checkMs !== null
        ? round2(Math.max(0, totalMs - (parseBind ?? 0) - (bind ?? 0) - checkMs))
        : null;
    results.push({
      spec,
      kind,
      bin,
      phaseSource,
      includesRendering: phaseSource === "wall-fallback" && !args.includes("--noMessages"),
      args,
      diagnostics: Math.round(median(runs.map((r) => r.diagnostics))),
      runs,
      cold,
      warm: {
        wallMs: round2(median(warmRuns.map((r) => r.wallMs))),
        parseMs: parseBind ?? undefined,
        bindMs: bind ?? undefined,
        checkMs: checkMs ?? undefined,
        totalMs: totalMs ?? undefined,
        startMs: startupMs ?? undefined,
      },
      checkMs,
      totalMs,
      startupMs,
    });
  }
  const report: ProjectBenchReport = {
    meta: {
      suite: "bench-project",
      schema: 1,
      project: opts.project,
      reps: opts.reps,
      generatedAt: new Date().toISOString(),
      headlineMetric: "check phase (auto-reported) / wall fallback",
      cacheTiers: "cold = run #1; warm = median of runs #2..N",
      note: "相位来源与是否含渲染逐实现记录；不同相位来源的数字不可横比",
    },
    implementations: results,
  };
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "bench-project.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function formatProjectBenchSummary(report: ProjectBenchReport): string {
  const lines: string[] = [];
  lines.push(
    `bench-project: ${report.meta.project}，reps=${report.meta.reps}（cold=第 1 轮，warm=其余轮中位）`,
  );
  const header = ["实现", "相位来源", "Check ms", "Parse ms", "Bind ms", "Total ms", "启动/其它 ms", "诊断", "warm wall ms"];
  const rows = report.implementations.map((r) => [
    r.spec,
    r.phaseSource,
    r.checkMs === null ? "-" : r.checkMs.toFixed(1),
    r.warm.parseMs === undefined ? "-" : r.warm.parseMs.toFixed(1),
    r.warm.bindMs === undefined ? "-" : r.warm.bindMs.toFixed(1),
    r.totalMs === null ? "-" : r.totalMs.toFixed(1),
    r.startupMs === null ? "-" : r.startupMs.toFixed(1),
    String(r.diagnostics),
    r.warm.wallMs.toFixed(1),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  lines.push(fmt(header));
  for (const row of rows) lines.push(fmt(row));
  lines.push("头条 = Check 相位（tsc 系自报）；wall-fallback 实现含进程启动与诊断渲染，不可与 Check 横比。");
  return lines.join("\n");
}
