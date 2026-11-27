// Public reports distinguish actual diagnostic comparisons from verified
// candidate process failures. Local gate/ratchet artifacts keep their shape.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metrics } from "../src/compare.ts";
import { isCrashSignal } from "../src/adapters/process-failure.ts";
import type { CandidateProcessFailure } from "../src/types.ts";
import { isValidCaseId } from "../src/discover.ts";

export const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const exactKeys = (value: unknown, keys: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const expected = keys.split(" ");
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const profiles = ["compatibility", "strict"] as const;
const verdicts = ["pass", "fail", "unknown"] as const;
const statuses = ["crash", "timeout"] as const;
type Status = typeof statuses[number];
export type FailureCounts = Record<Status, number>;
export type PublicExecutionFailure = { id: string; status: Status; process: CandidateProcessFailure };

export function validFailureCounts(value: unknown): value is FailureCounts {
  return object(value) && exactKeys(value, "crash timeout") && count(value.crash) && count(value.timeout) && count(value.crash + value.timeout);
}

export function validPublicExecutionFailure(value: unknown, adapter: string): value is PublicExecutionFailure {
  if (!object(value) || !exactKeys(value, "id status process") || !nonempty(value.id) || !isValidCaseId(value.id) ||
      !object(value.process)) return false;
  const p = value.process;
  if (value.status === "timeout") return p.kind === "deadline" && p.errorCode === "ETIMEDOUT" && (
    exactKeys(p, "kind errorCode signal") && (p.signal === "SIGTERM" || p.signal === "SIGKILL") ||
    exactKeys(p, "kind errorCode signal exitCode") && p.signal === null && count(p.exitCode) && p.exitCode <= 255
  );
  if (value.status !== "crash") return false;
  if (p.kind === "signal") return exactKeys(p, "kind signal") && isCrashSignal(p.signal);
  const lastNormalExit = adapter.startsWith("bun-check") ? 1 : 2;
  return p.kind === "exit" && exactKeys(p, "kind exitCode") && count(p.exitCode) && p.exitCode > lastNormalExit && p.exitCode < 126;
}

export interface PublicCaseResult {
  failures: PublicExecutionFailure[];
  differences: { id: string; extra: number; missed: number; misanchor: number }[];
}

export function verifyPublicShardCases(metrics: Metrics, dir: string): PublicCaseResult {
  const invalidFailure = (): never => { throw new Error(`Unverified execution failures: ${dir}`); };
  const invalidCounts = (): never => { throw new Error(`Invalid per-case counts: ${dir}`); };
  const details: unknown = JSON.parse(readFileSync(join(dir, "details.json"), "utf8"));
  const failuresById = new Map<string, { id: string; side: "candidate"; status: Status; reason: string }>();
  for (const f of metrics.meta.executionFailures ?? invalidFailure()) {
    if (!exactKeys(f, "id side status reason") || !nonempty(f.id) || f.side !== "candidate" ||
        !statuses.includes(f.status) || !nonempty(f.reason) || failuresById.has(f.id)) invalidFailure();
    failuresById.set(f.id, { id: f.id, side: "candidate", status: f.status, reason: f.reason });
  }
  if (!Array.isArray(details)) return invalidCounts();
  const failures: PublicExecutionFailure[] = [];
  const differences: PublicCaseResult["differences"] = [];
  const summaries = { compatibility: { pass: 0, fail: 0, unknown: 0 }, strict: { pass: 0, fail: 0, unknown: 0 } };
  const diagnostic = { expectTotal: 0, hitTotal: 0, fpTotal: 0, missTotal: 0, misanchorTotal: 0 };
  const skips = new Map<string, number>();
  for (const r of details) {
    if (!object(r) || !nonempty(r.id) || !isValidCaseId(r.id)) return invalidCounts();
    const f = failuresById.get(r.id);
    if (f !== undefined || Object.hasOwn(r, "executionFailure")) {
      const e = r.executionFailure;
      if (f === undefined || !object(e)) return invalidFailure();
      const caseFailure = { id: r.id, status: f.status, process: e.process };
      if (!exactKeys(e, "id side status reason process") || e.id !== f.id || e.side !== f.side ||
          e.status !== f.status || e.reason !== f.reason || r.skipReason !== f.reason ||
          r.status !== "skip" || r.comparison !== null || r.actualOutput !== null ||
          !Array.isArray(r.actual) || r.actual.length !== 0 ||
          !object(r.actualRawOutput) || typeof r.actualRawOutput.stdout !== "string" || typeof r.actualRawOutput.stderr !== "string" ||
          !validPublicExecutionFailure(caseFailure, metrics.meta.adapter) ||
          r.actualExitCode !== ("exitCode" in caseFailure.process ? caseFailure.process.exitCode : null)) return invalidFailure();
      failures.push(caseFailure);
      failuresById.delete(r.id);
    }
    if (!Array.isArray(r.fp) || !r.fp.every(nonempty) || !Array.isArray(r.missed) || !r.missed.every(nonempty) ||
        !count(r.misanchor) || !count(r.hits) || !Array.isArray(r.expected) || !Array.isArray(r.actual)) return invalidCounts();
    if (r.status === "skip") {
      if (r.comparison !== null || !nonempty(r.skipReason) || r.hits || r.fp.length || r.missed.length || r.misanchor) return invalidCounts();
      skips.set(r.skipReason, (skips.get(r.skipReason) ?? 0) + 1);
      continue;
    }
    if (r.status !== "ran" || Object.hasOwn(r, "skipReason") || !object(r.comparison) ||
        r.hits + r.missed.length + r.misanchor > r.expected.length || r.hits + r.fp.length + r.misanchor > r.actual.length) return invalidCounts();
    for (const profile of profiles) {
      const verdict = r.comparison[profile];
      if (verdict !== "pass" && verdict !== "fail" && verdict !== "unknown") return invalidCounts();
      summaries[profile][verdict]++;
    }
    diagnostic.expectTotal += r.expected.length;
    diagnostic.hitTotal += r.hits;
    diagnostic.fpTotal += r.fp.length;
    diagnostic.missTotal += r.missed.length;
    diagnostic.misanchorTotal += r.misanchor;
    if (differences.length < 8 && (r.fp.length || r.missed.length || r.misanchor)) {
      differences.push({ id: r.id, extra: r.fp.length, missed: r.missed.length, misanchor: r.misanchor });
    }
  }
  if (failuresById.size) invalidFailure();
  if (!Object.entries(diagnostic).every(([key, n]) => count(n) && metrics.totals[key as keyof Metrics["totals"]] === n) ||
      profiles.some((p) => !exactKeys(metrics.comparison[p], "pass fail unknown") ||
        verdicts.some((v) => metrics.comparison[p][v] !== summaries[p][v])) ||
      skips.size !== metrics.skips.length || new Set(metrics.skips.map(([reason]) => reason)).size !== skips.size ||
      metrics.skips.some((entry) => entry.length !== 2 || skips.get(entry[0]) !== entry[1])) invalidCounts();
  return { failures, differences };
}
