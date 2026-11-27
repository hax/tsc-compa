import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, buildPlan } from "../scripts/full-compatibility.ts";
import { sha256 } from "../src/provenance.ts";

const corpusRef = "microsoft/TypeScript@fixed";
function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tsc-full-test-"));
  try {
    for (const suite of ["compiler", "conformance", "transpile"]) mkdirSync(join(root, suite));
    writeFileSync(join(root, "compiler/a.ts"), "// @target: es2015, es2020\nconst x: number = 1;\n");
    writeFileSync(join(root, "compiler/fixture.js"), "");
    writeFileSync(join(root, "conformance/b.mts"), "export {};");
    writeFileSync(join(root, "conformance/c.tsx"), "<div />;");
    writeFileSync(join(root, "conformance/d.cts"), "export {};");
    writeFileSync(join(root, "transpile/not-typecheck.ts"), "");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeShard(root: string, plan: ReturnType<typeof buildPlan>, index: number, tweak?: "duplicate" | "crash" | "mixed") {
  const shard = plan.shards[index]!;
  const dir = join(root, `full-typescript-${shard.id}`);
  mkdirSync(dir, { recursive: true });
  const ids = shard.units.map(({ id }) => id);
  const records = shard.units.flatMap(({ records }) => records.map((id) => ({ id, status: id.endsWith(".tsx") ? "skip" : "ran" })));
  if (tweak === "duplicate") records[0]!.id = "compiler/a.ts";
  const ran = records.filter(({ status }) => status === "ran").length;
  const skipped = records.length - ran;
  const expectTotal = index === 0 ? 10 : 1;
  const hitTotal = index === 0 ? 5 : 1;
  const tool = { path: "/tool", version: "7.1.0-beta", sha256: "unchanged" };
  const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
  write("cases.json", ids);
  write("details.json", records);
  write("metrics.json", {
    meta: { manifest: { selectedIdsSha256: sha256(JSON.stringify(ids)) }, selectedCases: ids.length,
      baseline: "7.1.0-beta-official", corpusRef, expectationSource: "official-baseline", options: { strategy: "aligned" },
      adapter: "tsc-cli:/tool", verdictEligible: true, executionFailures: tweak === "crash" ? [{ id: "sample" }] : [],
      tools: { runner: "Bun", platform: "linux/x64", reference: tool, candidate: tweak === "mixed" ? { ...tool, sha256: "different" } : tool },
    },
    totals: { cases: records.length, ran, skipped, hitTotal, expectTotal, fpTotal: 0, missTotal: expectTotal - hitTotal, misanchorTotal: 0 },
    skips: skipped > 0 ? [["unsupported", skipped]] : [],
    comparison: { compatibility: { pass: 0, fail: ran, unknown: 0 }, strict: { pass: 0, fail: 0, unknown: ran } },
  });
}

test("planner inventories four TS extensions, keeps configurations together and balances deterministically", () => {
  fixture((root) => {
    const plan = buildPlan(root, corpusRef, 2, "official-baseline", ["typescript"]);
    expect(buildPlan(root, corpusRef, 2, "official-baseline", ["typescript"])).toEqual(plan);
    const units = plan.shards.flatMap((s) => s.units);
    expect(units.map((u) => u.id).sort()).toEqual(["compiler/a.ts", "conformance/b.mts", "conformance/c.tsx", "conformance/d.cts"]);
    expect(units.find((unit) => unit.id === "compiler/a.ts")?.records).toEqual(["compiler/a(target=es2015).ts", "compiler/a(target=es2020).ts"]);
    expect(units.find((unit) => unit.id === "conformance/c.tsx")?.records).toEqual(["conformance/c.tsx"]);
    expect(() => buildPlan(root, corpusRef, 33, "tsc")).toThrow("Shard count");
  });
});

test("merge uses diagnostic counts (not shard-average percentages); known incompatibility and explicit skips do not invalidate coverage", () => {
  fixture((root) => {
    const plan = buildPlan(root, corpusRef, 2, "official-baseline", ["typescript"]);
    writeShard(root, plan, 0);
    writeShard(root, plan, 1);
    const report = aggregate(plan, root);
    expect(report.complete).toBe(true);
    expect(report.candidates[0]).toMatchObject({ sourceFiles: 4, records: 5, ran: 4, skipped: 1, coverage: 6 / 11,
      compatibility: { pass: 0, fail: 4, unknown: 0 }, skipReasons: { unsupported: 1 } });
  });
});

test("merge rejects missing or duplicate records, crashed executions and mixed checker binaries", () => {
  fixture((root) => {
    const plan = buildPlan(root, corpusRef, 2, "official-baseline", ["typescript"]);
    writeShard(root, plan, 0);
    expect(aggregate(plan, root)).toMatchObject({ complete: false });
    writeShard(root, plan, 1, "duplicate");
    expect(aggregate(plan, root).issues.join()).toContain("does not match its case plan");
    writeShard(root, plan, 1, "crash");
    expect(aggregate(plan, root).issues.join()).toContain("execution failures");
    writeShard(root, plan, 1, "mixed");
    expect(aggregate(plan, root).issues.join()).toContain("Inconsistent executable identity");
  });
});
