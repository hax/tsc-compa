import { expect, test } from "bun:test";
import { caseKey, classify, joinEvidence, selectCases, tszOptionEvidence, type CaseKey, type Joined, type Observation, type Origin } from "../scripts/curate-compatibility.ts";

const origins: Origin[] = [
  { candidate: "typescript", family: "typescript", role: "reference-control" },
  { candidate: "bun-1.4.4", family: "bun", role: "public-full" },
  { candidate: "bun-1.4.5", family: "bun", role: "public-full" },
  { candidate: "tsz", family: "tsz", role: "release-preview" },
];
const pos = (code: number): [string, number, number, string, number] => ["case.ts", 1, 1, "error", code];
const pass: Observation = { status: "pass", reference: [pos(2322)], actual: [pos(2322)], hits: 1, extra: [], missing: [], moved: [] };
const clean: Observation = { ...pass, reference: [], actual: [], hits: 0 };
const mismatch = (code = 1000): Observation => ({ ...pass, status: "mismatch", extra: [code], actual: [pos(2322), pos(code)] });
const skip: Observation = { status: "skip", kind: "unsupported-option", reason: "Bun 1.4.x 不支持 module=system" };
const row = (id: string, typescript: Observation = pass, bun: Observation = pass, bun2: Observation = pass,
  tsz: Observation = pass): Joined => ({ source: `compiler/${id}.ts`, configuration: null,
    observations: { typescript, "bun-1.4.4": bun, "bun-1.4.5": bun2, tsz } });
const quotas = { "multiple-families": 2, "single-family-per-family": 1, "reference-disagreement": 1,
  "intentional-skip": 1, "control-with-diagnostics": 1, "control-without-diagnostics": 1 };

test("configuration is part of the key, and missing or duplicate configured evidence fails closed", () => {
  const source = "compiler/test.ts";
  const named = (configuration: string) => caseKey({ id: `compiler/test(${configuration}).ts`, caseId: source, configuration }, source);
  const rows = (pairs: [CaseKey, Observation][]) => pairs.map(([key, observation]) => ({ ...key, observation }));
  const a = named("target=es2015");
  const b = named("target=es5");
  const runner = [{ origin: origins[0]!, rows: rows([[a, pass], [b, pass]]) },
    { origin: origins[1]!, rows: rows([[b, skip], [a, mismatch()]]) }];
  const joined = joinEvidence(runner);
  expect(joined.map((r) => [r.configuration, r.observations["bun-1.4.4"]!.status])).toEqual([
    ["target=es2015", "mismatch"], ["target=es5", "skip"],
  ]);
  expect(joinEvidence([...runner].reverse())).toEqual(joined);
  expect(() => joinEvidence([runner[0]!, { ...runner[1]!, rows: rows([[b, skip]]) }])).toThrow("Incomplete evidence");
  expect(() => joinEvidence([runner[0]!, { ...runner[1]!, rows: rows([[a, pass], [a, pass]]) }])).toThrow("Duplicate");
  expect(() => joinEvidence([runner[0]!, { ...runner[1]!, rows: rows([[a, clean], [b, pass]]) }])).toThrow("Different official diagnostic points");
  expect(() => caseKey({ id: "compiler/test(target=es5).ts", caseId: source, configuration: "target=es2015" }, source)).toThrow();
});

test("same-family versions do not double-vote; a TS7 control difference or skip is not candidate defect evidence", () => {
  const categorize = (...args: Parameters<typeof row>) => classify(row(...args), origins);
  expect(categorize("bothBuns", pass, mismatch(), mismatch()).bucket).toBe("single-family");
  expect(categorize("multiFamily", pass, mismatch(), mismatch(), mismatch()).mismatchFamilies).toEqual(["bun", "tsz"]);
  expect(categorize("onlyComparableFamily", pass, mismatch(), mismatch(), skip).bucket).toBeNull();
  const reference = categorize("controlDrift", mismatch(), mismatch(), mismatch(), mismatch());
  expect([reference.bucket, reference.mismatchFamilies]).toEqual(["reference-disagreement", []]);
  expect(categorize("knownSkip", pass, skip, skip, pass).bucket).toBe("intentional-skip");
  expect(categorize("otherSkip", pass, { ...skip, kind: "other" }, pass, pass).bucket).toBeNull();
  expect(categorize("skipAndMismatch", pass, skip, pass, mismatch()).bucket).toBe("single-family");
  expect(categorize("withDiag").bucket).toBe("control-with-diagnostics");
  expect(categorize("clean", clean, clean, clean, clean).bucket).toBe("control-without-diagnostics");
});

test("stable priority, quotas, fixed-sample exclusion and cluster/numbered-sibling deduplication", () => {
  const data = [row("skip", pass, skip, skip), row("zSingle", pass, mismatch(101)),
    row("bMulti", pass, mismatch(102), mismatch(102), mismatch(103)), row("aMulti2", pass, mismatch(104), pass, mismatch(105)),
    row("aMulti1", pass, mismatch(102), pass, mismatch(103)), row("nonSibling", pass, mismatch(102), pass, mismatch(103)),
    row("fixed", pass, mismatch(1), mismatch(1), mismatch(2)), row("diagnostic"), row("clean", clean, clean, clean, clean)];
  const ledger = data.map((r) => classify(r, origins));
  const excluded = new Set(["compiler/fixed.ts", "compiler/diagnostic.ts"]);
  const selected = selectCases(ledger, quotas, excluded);
  const again = selectCases([...ledger].reverse(), quotas, excluded);
  expect(JSON.stringify(again)).toBe(JSON.stringify(selected));
  expect(selected.map((r) => r.source)).toEqual([
    "compiler/aMulti1.ts", "compiler/fixed.ts", "compiler/zSingle.ts", "compiler/skip.ts", "compiler/clean.ts",
  ]);
});


test("embedded tsz only promotes evidenced TS6046/TS5108 option failures, not generic positionless output", () => {
  const target = "error TS6046: Argument for '--target' option must be: 'es5', 'esnext'.";
  const detail = { actual: [], actualExitCode: 1, actualArgs: ["--target", "es5", "--target", "es2026"],
    actualRawOutput: { stdout: target, stderr: "" } };
  expect(tszOptionEvidence(detail)).toEqual({ args: ["--target=es2026"], diagnostics: [target] });
  expect(tszOptionEvidence({ ...detail, actualArgs: ["--target", "es2026", "--target", "esnext"] })).toBeUndefined();
  expect(tszOptionEvidence({ ...detail, actualExitCode: null })).toBeUndefined();
  expect(tszOptionEvidence({ ...detail, actualRawOutput: { stdout: target, stderr: "error TS6053: File not found." } })).toBeUndefined();
  expect(tszOptionEvidence({ ...detail, actualRawOutput: { stdout: "", stderr: "panic: stack overflow" } })).toBeUndefined();
  const system = "error TS5108: Option 'module=System' has been removed. Please remove it from your configuration.";
  const bundler = "error TS5095: Option 'bundler' can only be used when 'module' is set to 'preserve', 'commonjs', or 'es2015' or later.";
  expect(tszOptionEvidence({ ...detail, actualArgs: ["--module", "system", "--moduleResolution", "bundler"],
    actualRawOutput: { stdout: `Files: 0\nErrors: 2\n${system}\n${bundler}`, stderr: "" } })).toEqual({
    args: ["--module=system", "--moduleresolution=bundler"], diagnostics: [bundler, system],
  });
});
