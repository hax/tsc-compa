import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BunCheckAdapter } from "../src/adapters/bun-check.ts";
import { looksLikePrettyDiagnostics, PLAIN_DIAGNOSTIC, UNPOSITIONED_DIAGNOSTIC } from "../src/adapters/plain-diagnostics.ts";
import { TscCliAdapter } from "../src/adapters/tsc-cli.ts";
import { REPO_ROOT } from "../src/baselines.ts";
import { toTscArgs } from "../src/case.ts";
import { identifyTool, sha256 } from "../src/provenance.ts";
import type { Adapter, CaseInput, CaseOutcome, CompilerOptions, Diagnostic, Severity } from "../src/types.ts";

export const ANCHORS = { ts6: "6.0.3", ts7: "7.1.0-beta" } as const;
type Anchor = keyof typeof ANCHORS;
type ProbeAdapter = "bun-check" | "tsc-cli";
// 1-based UTF-16 coordinates, like the CLI. Do not normalize diagnostic codes.
export type Point = [file: string, line: number, column: number, severity: Severity, code: number];
type Probe = {
  id: string;
  upstreamCase: string;
  description: string;
  options?: CompilerOptions;
  ts6: OmitFile[];
  ts7: OmitFile[];
};
type OmitFile = [line: number, column: number, severity: Severity, code: number];
const root = join(REPO_ROOT, "config/version-probes");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const manifest = readJson<{ upstreamCommit: string; probes: Probe[] }>(join(root, "manifest.json"));
const sharedOptions: CompilerOptions = [
  { name: "target", value: "es2022" },
  { name: "lib", value: ["es2022"] },
  { name: "typeRoots", value: ["./empty-types"] },
  { name: "module", value: "esnext" },
  { name: "moduleResolution", value: "bundler" },
  { name: "moduleDetection", value: "legacy" },
  { name: "strict", value: true },
  { name: "noImplicitAny", value: true },
  { name: "skipLibCheck", value: true },
  { name: "useDefineForClassFields", value: true },
  { name: "exactOptionalPropertyTypes", value: false },
  { name: "noUncheckedIndexedAccess", value: false },
  { name: "noUnusedLocals", value: false },
  { name: "noUnusedParameters", value: false },
  { name: "esModuleInterop", value: true },
  { name: "alwaysStrict", value: true },
];

// Sort a copy so diagnostic order and wording do not matter, but repetitions do.
const canonical = (points: Point[]): string => JSON.stringify(points.map((p) => JSON.stringify(p)).sort());
export function fingerprint(diagnostics: Diagnostic[]): Point[] {
  return diagnostics.map((d): Point => [d.file, d.line + 1, d.col + 1, d.severity, d.code]);
}

type Unavailable = { status: "unsupported" | "execution-error"; reason: string };
export type Evidence = ({ status: "checked"; fingerprint: Point[] } | Unavailable) & {
  exitCode?: CaseOutcome["exitCode"];
  rawOutput?: CaseOutcome["rawOutput"];
};

export function probeEvidence(outcome: CaseOutcome, files: string[], adapter: ProbeAdapter): Evidence {
  const { rawOutput, exitCode } = outcome;
  const base = { exitCode, rawOutput };
  const reason = [outcome.skipReason, outcome.message].filter(Boolean).join("：") || outcome.status;
  if (outcome.status === "skip") return { ...base, status: "unsupported", reason };
  if (outcome.status !== "ok") return { ...base, status: "execution-error", reason };

  const output = `${rawOutput?.stdout ?? ""}\n${rawOutput?.stderr ?? ""}`;
  if (looksLikePrettyDiagnostics(output) || /^.+?\(\d+,\d+\):\s+(?:message|suggestion)\s+TS\d+:/m.test(output)) {
    return { ...base, status: "unsupported", reason: "输出含探针无法比较的诊断格式或严重度" };
  }
  const lines = output.split(/\r?\n/);
  if (lines.some((line) => UNPOSITIONED_DIAGNOSTIC.test(line))) {
    return { ...base, status: "execution-error", reason: "适配器未处理无文件位置的诊断" };
  }
  if (outcome.diagnostics.some((d) => !files.includes(d.file)) || lines.some((line) => {
    const file = PLAIN_DIAGNOSTIC.exec(line)?.[1]?.replaceAll("\\", "/");
    return file !== undefined && !files.some((path) => file === path || file.endsWith(`/${path}`));
  })) {
    return { ...base, status: "unsupported", reason: "诊断不在探针文件内" };
  }
  // The adapters request file statistics. A successful but silent process is
  // not evidence that it actually checked the fixture.
  const ran = adapter === "bun-check" ? /^\s*✓\s+No type errors in [1-9]\d* files?\b/m.test(output)
    : /^\s*Files:\s*[1-9]\d*\s*$/m.test(output);
  if (outcome.diagnostics.length === 0 && (exitCode !== 0 || outcome.fullText !== "" || !ran)) {
    return { ...base, status: "execution-error", reason: "没有证据表明检查成功且诊断为空" };
  }
  return { ...base, status: "checked", fingerprint: fingerprint(outcome.diagnostics) };
}

export function observe(evidence: Evidence, ts6: Point[], ts7: Point[], calibrated: boolean) {
  if (evidence.status !== "checked") return evidence.status;
  if (!calibrated) return "uncalibrated";
  const before = canonical(evidence.fingerprint) === canonical(ts6);
  const after = canonical(evidence.fingerprint) === canonical(ts7);
  return before && after ? "both" : before ? "ts6" : after ? "ts7" : "neither";
}

function officialMatches(evidence: Evidence, expected: Point[]): boolean {
  return evidence.status === "checked" && canonical(evidence.fingerprint) === canonical(expected);
}

async function check(adapter: Adapter, input: CaseInput, kind: ProbeAdapter): Promise<Evidence> {
  try {
    return probeEvidence(await adapter.check(input), input.files.map((f) => f.path), kind);
  } catch (error) {
    return { status: "execution-error", reason: String(error) };
  }
}

function configuredAnchor(key: Anchor, alias: string) {
  const tool = identifyTool(join(REPO_ROOT, "node_modules", alias, "bin/tsc"));
  const version = ANCHORS[key];
  if (!tool?.sha256 || tool.version !== `Version ${version}`) {
    throw new Error(`官方锚点 ${alias} 需要 ${version}；实际 ${tool?.version ?? "未安装"}`);
  }
  return { tool, adapter: new TscCliAdapter({ bin: tool.native?.path ?? tool.path, extraArgs: ["--ignoreConfig"] }) };
}

type Implementation = { adapter: string; cliArgs: string[] };
function configuredCandidate(name: string, bin: string): { name: string; tool: ReturnType<typeof identifyTool>; kind: ProbeAdapter; adapter: Adapter } {
  const registry = readJson<{ implementations: Record<string, Implementation> }>(join(REPO_ROOT, "config/implementations.json"));
  if (!Object.hasOwn(registry.implementations, name)) throw new Error(`未登记的候选：${name}`);
  const implementation = registry.implementations[name]!;
  const path = resolve(bin);
  const kind = implementation.adapter;
  if (kind !== "bun-check" && kind !== "tsc-cli") throw new Error(`探针不支持适配器 ${kind}`);
  // BunCheckAdapter itself supplies the registered check flags; passing them as
  // compiler defaults would duplicate them or put CLI flags into tsconfig.
  const adapter = kind === "bun-check" ? new BunCheckAdapter({ bin: path })
    : new TscCliAdapter({ bin: path, extraArgs: implementation.cliArgs });
  return { name, tool: identifyTool(path), kind, adapter };
}

const display = (points: Point[]): string => points.length === 0 ? "无诊断" : points
  .map(([file, line, col, severity, code]) => `\`${file}:${line}:${col} ${severity} TS${code}\``).join("；");
const evidenceText = (evidence: Evidence): string => evidence.status === "checked" ? display(evidence.fingerprint) : evidence.status;

async function main() {
  const { values } = parseArgs({ options: { candidate: { type: "string" }, bin: { type: "string" }, out: { type: "string" } } });
  if (Boolean(values.candidate) !== Boolean(values.bin)) throw new Error("--candidate <登记名> 和 --bin <可执行文件> 必须一起提供");
  const ts6 = configuredAnchor("ts6", "typescript-6-0");
  const ts7 = configuredAnchor("ts7", "typescript-7-1");
  const candidate = values.candidate && values.bin ? configuredCandidate(values.candidate, values.bin) : null;
  const out = resolve(values.out ?? join(REPO_ROOT, ".cache/version-probes", candidate?.name ?? "official"));
  const rows = [];
  for (const probe of manifest.probes) {
    const path = `${probe.id}.ts`;
    const text = readFileSync(join(root, path), "utf8");
    const options = [...new Map([...sharedOptions, ...(probe.options ?? [])].map((o) => [o.name, o])).values()];
    const input: CaseInput = { id: probe.id, files: [{ path, text }], options, args: toTscArgs(options) };
    const expected = { ts6: probe.ts6.map((p): Point => [path, ...p]), ts7: probe.ts7.map((p): Point => [path, ...p]) };
    const official = { ts6: await check(ts6.adapter, input, "tsc-cli"), ts7: await check(ts7.adapter, input, "tsc-cli") };
    const calibrated = canonical(expected.ts6) !== canonical(expected.ts7) &&
      officialMatches(official.ts6, expected.ts6) && officialMatches(official.ts7, expected.ts7);
    const actual = candidate ? await check(candidate.adapter, input, candidate.kind) : null;
    const observed = actual && { ...actual, observation: observe(actual, expected.ts6, expected.ts7, calibrated) };
    rows.push({ id: probe.id, description: probe.description, upstreamCase: probe.upstreamCase, sourceSha256: sha256(text),
      options, expected, official, calibrated, candidate: observed });
  }
  const calibrated = rows.length > 0 && rows.every((row) => row.calibrated);
  mkdirSync(out, { recursive: true });
  const json = { schemaVersion: 1, upstreamCommit: manifest.upstreamCommit, calibrated,
    anchors: { ts6: ts6.tool, ts7: ts7.tool }, candidate: candidate && { name: candidate.name, adapter: candidate.kind, tool: candidate.tool }, probes: rows };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(json, null, 2)}\n`);
  const md = ["## TS6 / TS7 版本差异探针", "",
    `官方锚点：TS ${ANCHORS.ts6} / ${ANCHORS.ts7}；校准${calibrated ? "通过" : "失败"}。`,
    ...(candidate ? [`候选：\`${candidate.name}\`。相符状态只描述单例；不可用于判断整体兼容性。`] : []), "",
    "| 探针 | TS6 | TS7 | 校准 |" + (candidate ? " 候选观察 |" : ""),
    "| --- | --- | --- | --- |" + (candidate ? " --- |" : ""),
    ...rows.map((row) => `| ${row.id} | ${evidenceText(row.official.ts6)} | ${evidenceText(row.official.ts7)} | ${row.calibrated ? "通过" : "失败"} |` +
      (row.candidate ? ` ${row.candidate.observation}${row.candidate.status === "checked" ? `：${evidenceText(row.candidate)}` : "（原因见 JSON）"} |` : "")), ""].join("\n");
  writeFileSync(join(out, "report.md"), md);
  console.log(md);
  if (!calibrated) process.exitCode = 1;
}

if (import.meta.main) await main();
