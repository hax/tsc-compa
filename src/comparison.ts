import { isDeepStrictEqual } from "node:util";
import type { Diagnostic, DiagnosticPosition, MessageChain, RelatedDiagnostic } from "./types.ts";

export type Verdict = "pass" | "fail" | "unknown";
export type FieldStatus = "equal" | "different" | "unavailable";

export const diagnosticFields = [
  "code", "severity", "location", "width", "message", "messageChain", "related", "attributes",
] as const;
export const comparisonFields = [...diagnosticFields, "count", "order", "output"] as const;
type DiagnosticField = typeof diagnosticFields[number];
export type ComparisonField = typeof comparisonFields[number];

export interface DiagnosticMatch {
  expected: number;
  actual: number;
  fields: Record<DiagnosticField, FieldStatus>;
}

export interface DiagnosticComparison {
  compatibility: Verdict;
  strict: Verdict;
  fields: Record<ComparisonField, FieldStatus>;
  matches: DiagnosticMatch[];
  /** Same file and problem, unambiguous pair at different positions; not a hit. */
  positionDifferences: DiagnosticMatch[];
  missing: number[];
  extraErrors: number[];
  extraWarnings: number[];
  unclassified: number[];
  /** Unmatched on known evidence, but incomplete keys still permit a correspondence. */
  unresolved: { expected: number[]; actual: number[] };
}

export interface ComparisonOptions {
  equivalentCodes?: readonly (readonly number[])[];
  expectedOutput?: string;
  actualOutput?: string;
}

const coordinate = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const fileOf = (d: Diagnostic): string | undefined => d.file || undefined;
const codeOf = (code: unknown): number | undefined => {
  const value = coordinate(code);
  return value === 0 ? undefined : value;
};
const severityOf = (d: Diagnostic): "error" | "warning" | undefined =>
  d.severity === "error" || d.severity === "warning" ? d.severity : undefined;

function fieldStatus(expected: unknown, actual: unknown): FieldStatus {
  if (expected === undefined || actual === undefined) return "unavailable";
  return isDeepStrictEqual(expected, actual) ? "equal" : "different";
}

function combine(statuses: FieldStatus[]): FieldStatus {
  if (statuses.includes("different")) return "different";
  return statuses.includes("unavailable") ? "unavailable" : "equal";
}

function arrayStatus<T>(a: T[] | undefined, b: T[] | undefined, pair: (a: T, b: T) => FieldStatus): FieldStatus {
  if (a === undefined || b === undefined) return "unavailable";
  if (a.length !== b.length) return "different";
  return combine(a.map((item, i) => pair(item, b[i]!)));
}

function chainStatus(a: MessageChain | null | undefined, b: MessageChain | null | undefined): FieldStatus {
  if (a == null || b == null) return fieldStatus(a, b);
  return combine([
    fieldStatus(a.text, b.text), fieldStatus(a.code, b.code), fieldStatus(a.category, b.category),
    fieldStatus(a.attributes, b.attributes), arrayStatus(a.children, b.children, chainStatus),
  ]);
}

type Spanned = { line?: number; col?: number; end?: DiagnosticPosition; width?: number };
function spanStatus(a: Spanned, b: Spanned): FieldStatus {
  if (a.end !== undefined && b.end !== undefined) {
    return combine([
      fieldStatus(coordinate(a.end.line), coordinate(b.end.line)),
      fieldStatus(coordinate(a.end.col), coordinate(b.end.col)),
    ]);
  }
  const singleLineWidth = (d: Spanned): number | undefined => {
    if (d.end === undefined) return coordinate(d.width);
    return d.end.line === d.line && d.col !== undefined ? coordinate(d.end.col - d.col) : undefined;
  };
  return fieldStatus(singleLineWidth(a), singleLineWidth(b));
}

function relatedStatus(a: RelatedDiagnostic, b: RelatedDiagnostic): FieldStatus {
  return combine([
    fieldStatus(a.file, b.file), fieldStatus(a.line, b.line), fieldStatus(a.col, b.col),
    spanStatus(a, b), fieldStatus(a.code, b.code), fieldStatus(a.category, b.category),
    fieldStatus(a.message, b.message), chainStatus(a.messageChain, b.messageChain), fieldStatus(a.attributes, b.attributes),
  ]);
}

function pairFields(expected: Diagnostic, actual: Diagnostic): DiagnosticMatch["fields"] {
  return {
    code: fieldStatus(codeOf(expected.code), codeOf(actual.code)),
    severity: fieldStatus(severityOf(expected), severityOf(actual)),
    location: combine([
      fieldStatus(fileOf(expected), fileOf(actual)),
      fieldStatus(coordinate(expected.line), coordinate(actual.line)),
      fieldStatus(coordinate(expected.col), coordinate(actual.col)),
    ]),
    width: spanStatus(expected, actual),
    message: fieldStatus(expected.message, actual.message),
    messageChain: chainStatus(expected.messageChain, actual.messageChain),
    related: arrayStatus(expected.related, actual.related, relatedStatus),
    attributes: fieldStatus(expected.attributes, actual.attributes),
  };
}

/** Can every required vertex participate in a one-to-one match? First cover the
 * mandatory candidates, then augment from any uncovered reference. Augmenting
 * paths never unmatch a previously covered vertex on the opposite side. */
function canCover(edges: number[][], actual: Diagnostic[]): boolean {
  const inverse: number[][] = actual.map(() => []);
  for (const [e, candidates] of edges.entries()) for (const a of candidates) inverse[a]!.push(e);
  const forward = new Map<number, number>();
  const backward = new Map<number, number>();
  const augment = (
    from: number, adjacency: number[][], direct: Map<number, number>, reverse: Map<number, number>, seen: Set<number>,
  ): boolean => {
    for (const to of adjacency[from]!) {
      if (seen.has(to)) continue;
      seen.add(to);
      const other = reverse.get(to);
      if (other !== undefined && !augment(other, adjacency, direct, reverse, seen)) continue;
      direct.set(from, to);
      reverse.set(to, from);
      return true;
    }
    return false;
  };
  for (const [a, d] of actual.entries()) {
    // An unclassified extra may turn out to be a warning, so this is only an optimistic proof of possibility.
    if (severityOf(d) === "error" && !augment(a, inverse, backward, forward, new Set())) return false;
  }
  for (const [e] of edges.entries()) {
    if (!forward.has(e) && !augment(e, edges, forward, backward, new Set())) return false;
  }
  return true;
}

export function compareDiagnostics(
  expected: Diagnostic[],
  actual: Diagnostic[],
  options: ComparisonOptions = {},
): DiagnosticComparison {
  const groups = new Map<number, number>();
  for (const [identity, group] of (options.equivalentCodes ?? []).entries()) {
    for (const code of group) {
      if (codeOf(code) === undefined || groups.has(code)) throw new Error(`无效或重复的等价诊断码：TS${code}`);
      groups.set(code, identity);
    }
  }
  const groupOf = (d: Diagnostic): string | undefined => {
    const code = codeOf(d.code);
    if (code === undefined) return undefined;
    return groups.has(code) ? `group:${groups.get(code)}` : `code:${code}`;
  };
  const partsOf = (d: Diagnostic) => [fileOf(d), coordinate(d.line), coordinate(d.col), groupOf(d)];
  const expectedParts = expected.map(partsOf);
  const actualParts = actual.map(partsOf);
  const complete = (parts: (string | number | undefined)[]) => parts.every((part) => part !== undefined);
  const lookup = new Map<string, number[]>();
  for (const [a, parts] of actualParts.entries()) {
    if (!complete(parts)) continue;
    const key = JSON.stringify(parts);
    const entries = lookup.get(key) ?? [];
    entries.push(a);
    lookup.set(key, entries);
  }
  const matches: DiagnosticMatch[] = [];
  const used = new Set<number>();
  const matchedExpected = new Set<number>();
  const referenceGroupSize = new Map<string, number>();
  for (const parts of expectedParts) {
    if (!complete(parts)) continue;
    const key = JSON.stringify(parts);
    referenceGroupSize.set(key, (referenceGroupSize.get(key) ?? 0) + 1);
  }
  const voluntaryBudget = new Map<string, number>();
  for (const [key, indices] of lookup) {
    const required = indices.filter((a) => severityOf(actual[a]!) !== "warning").length;
    voluntaryBudget.set(key, Math.max(0, (referenceGroupSize.get(key) ?? 0) - required));
  }
  const add = (match: DiagnosticMatch): void => {
    matches.push(match);
    used.add(match.actual);
    matchedExpected.add(match.expected);
  };
  // Preserve exact structured matches before attributing change, including duplicate
  // warning/error diagnostics. An exact warning cannot displace a required error.
  for (const [certainty, exact] of [["complete", true], ["partial", true], ["remaining", false]] as const) {
    for (const [e, parts] of expectedParts.entries()) {
      if (!complete(parts) || matchedExpected.has(e)) continue;
      const key = JSON.stringify(parts);
      let best: DiagnosticMatch | undefined;
      let bestScore = -Infinity;
      for (const a of lookup.get(key) ?? []) {
        if (used.has(a)) continue;
        const candidateSeverity = severityOf(actual[a]!);
        const fields = pairFields(expected[e]!, actual[a]!);
        const statuses = Object.values(fields);
        if (exact && (fields.code !== "equal" || fields.severity !== "equal" || statuses.includes("different") ||
            (certainty === "complete" && statuses.includes("unavailable")) ||
            (candidateSeverity === "warning" && voluntaryBudget.get(key) === 0))) continue;
        const score = (!exact && candidateSeverity === "error" ? 1_000 : !exact && candidateSeverity === undefined ? 500 : 0) +
          (fields.code === "equal" ? 100 : 0) +
          (fields.severity === "equal" ? 30 : 0) +
          (statuses.includes("different") ? 0 : 20) +
          statuses.filter((status) => status === "equal").length;
        if (score <= bestScore) continue;
        bestScore = score;
        best = { expected: e, actual: a, fields };
      }
      if (best !== undefined) {
        add(best);
        if (severityOf(actual[best.actual]!) === "warning") {
          voluntaryBudget.set(key, Math.max(0, (voluntaryBudget.get(key) ?? 0) - 1));
        }
      }
    }
  }
  matches.sort((a, b) => a.expected - b.expected);
  const unmatchedExpected = expected.flatMap((_, e) => matchedExpected.has(e) ? [] : [e]);
  const unmatchedActual = actual.flatMap((_, a) => used.has(a) ? [] : [a]);
  const provenCompatible = unmatchedExpected.length === 0 && unmatchedActual.every((a) => severityOf(actual[a]!) === "warning");
  const havePartialKeys = [...expectedParts, ...actualParts].some((parts) => !complete(parts));
  const possible = (e: number, a: number): boolean =>
    expectedParts[e]!.every((part, i) => part === undefined || actualParts[a]![i] === undefined || part === actualParts[a]![i]);
  const partialMatch = (e: number, a: number): boolean =>
    (!complete(expectedParts[e]!) || !complete(actualParts[a]!)) && possible(e, a);
  const unresolved = {
    expected: !provenCompatible && havePartialKeys ? unmatchedExpected.filter((e) => actual.some((_, a) => partialMatch(e, a))) : [],
    actual: !provenCompatible && havePartialKeys ? unmatchedActual.filter((a) => expected.some((_, e) => partialMatch(e, a))) : [],
  };
  const compatibility: Verdict = provenCompatible ? "pass"
    : !havePartialKeys
      ? unmatchedExpected.length > 0 || unmatchedActual.some((a) => severityOf(actual[a]!) === "error") ? "fail" : "unknown"
      : canCover(expectedParts.map((_, e) => actualParts.flatMap((_, a) => possible(e, a) ? [a] : [])), actual) ? "unknown" : "fail";

  const missing = unmatchedExpected.filter((e) => !unresolved.expected.includes(e));
  const extraErrors = unmatchedActual.filter((a) => !unresolved.actual.includes(a) && severityOf(actual[a]!) === "error");
  const extraWarnings = unmatchedActual.filter((a) => !unresolved.actual.includes(a) && severityOf(actual[a]!) === "warning");
  const unclassified = unmatchedActual.filter((a) => severityOf(actual[a]!) === undefined);
  const positionDifferences: DiagnosticMatch[] = [];
  const anchors = new Map<string, { expected: number[]; actual: number[] }>();
  for (const [side, indices, diagnostics] of [["expected", missing, expected], ["actual", [...extraErrors, ...extraWarnings, ...unclassified.filter((a) => !unresolved.actual.includes(a))], actual]] as const) {
    for (const i of indices) {
      const d = diagnostics[i]!;
      if (!complete(partsOf(d))) continue;
      const key = JSON.stringify([fileOf(d), groupOf(d)]);
      const group = anchors.get(key) ?? { expected: [], actual: [] };
      group[side].push(i);
      anchors.set(key, group);
    }
  }
  // Only attribute positional changes when the remaining correspondence is unique.
  for (const group of anchors.values()) {
    if (group.expected.length !== 1 || group.actual.length !== 1) continue;
    const e = group.expected[0]!, a = group.actual[0]!;
    positionDifferences.push({ expected: e, actual: a, fields: pairFields(expected[e]!, actual[a]!) });
  }

  const sameLength = expected.length === actual.length;
  const originalPairs = sameLength ? expected.map((d, i) => pairFields(d, actual[i]!)) : [];
  const lineUp = sameLength && originalPairs.every((fields) => !Object.values(fields).includes("different"));
  const comparable = lineUp ? originalPairs : [...matches, ...positionDifferences].map((p) => p.fields);
  const completeFields = lineUp || (matches.length + positionDifferences.length === expected.length && expected.length > 0);
  const fields = Object.fromEntries(diagnosticFields.map((field) => [
    field, combine([...comparable.map((pair) => pair[field]), completeFields ? "equal" : "unavailable"]),
  ])) as DiagnosticMatch["fields"];
  // A reversal between distinct known identities is observable even if another diagnostic is extra.
  // For repeated identities, only infer reversal if both original pairs have a known difference
  // and neither crossed pair has one. This avoids deriving order from unknown width/message data.
  const outOfOrder = !lineUp && matches.some((p, i) => matches.slice(i + 1).some((q) => {
    if (p.actual < q.actual) return false;
    if (JSON.stringify(expectedParts[p.expected]) !== JSON.stringify(expectedParts[q.expected])) return true;
    const differs = (fields: DiagnosticMatch["fields"]) => Object.values(fields).includes("different");
    return !differs(p.fields) && !differs(q.fields) &&
      differs(pairFields(expected[p.expected]!, actual[q.actual]!)) && differs(pairFields(expected[q.expected]!, actual[p.actual]!));
  }));
  const allFields = {
    ...fields,
    count: fieldStatus(expected.length, actual.length),
    order: (outOfOrder ? "different"
      : sameLength && matches.length === actual.length && (matches.every((p) => p.expected === p.actual) || originalPairs.every((fields) => Object.values(fields).every((field) => field === "equal")))
        ? "equal" : "unavailable") as FieldStatus,
    output: fieldStatus(options.expectedOutput, options.actualOutput),
  };
  // Strict equality of an ordered sequence is independent of the compatibility assignment.
  const originalStatus = combine(originalPairs.flatMap((pair) => Object.values(pair)));
  const strict: Verdict = compatibility === "fail" || !sameLength || originalStatus === "different" || allFields.output === "different"
    ? "fail"
    : compatibility === "unknown" || originalStatus === "unavailable" || allFields.output === "unavailable"
      ? "unknown" : "pass";
  return { compatibility, strict, fields: allFields, matches, positionDifferences, missing, extraErrors, extraWarnings, unclassified, unresolved };
}
