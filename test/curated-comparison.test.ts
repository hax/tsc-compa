import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { curatedComparisonHtml, loadCuratedComparison, stageCuratedComparison, suiteId } from "../scripts/curated-comparison.ts";
import { REPO_ROOT } from "../src/baselines.ts";

const data = loadCuratedComparison();

test("public-format snapshot keeps the 33 selected configurations, skips, and calibration separate", () => {
  expect(data.suite).toMatchObject({ id: "curated-difference-v1", status: "draft" });
  expect(data.scope).toMatchObject({ targetConfigurations: 33, sourceFiles: 33, siblingConfigurations: "not-included",
    supplementalProbes: 5, extrapolateCompatibility: false });
  expect(data.cases.filter((r) => r.configuration !== null)).toHaveLength(3);
  expect(data.cases.filter((r) => r.bucket === "reference-disagreement")).toHaveLength(6);
  expect(data.candidates.map((r) => r.run.id)).toEqual([45969353606, 45969572330, 45969577715, 45969582556, 46000898108, 46000904225]);
  expect(data.candidates.filter((r) => r.role === "release-preview").map((r) => r.id)).toEqual(["ts-rust", "tsz"]);
  expect(data.candidates.filter((r) => r.family === "bun")).toHaveLength(2);
  for (const candidate of data.candidates) expect(Object.values(candidate.outcomes).reduce((a, b) => a + b)).toBe(33);
  const library = data.cases.find((r) => r.source === "conformance/es2026/jsonRawJSON3.ts")!;
  expect(library.observations.tsz).toEqual({ status: "skip", kind: "unsupported-option", reason: "候选内置声明库不支持 es2026.json",
    optionArgs: ["--lib=es2026.json"] });
  expect(data.supplemental.probes).toHaveLength(5);
  expect(data.supplemental.anchors).toEqual({ ts6: "Version 6.0.3", ts7: "Version 7.1.0-beta" });
  const html = curatedComparisonHtml(data);
  expect(html).toContain("不能据此估算整体兼容率");
  expect(html).toContain("跳过：选项不支持");
  expect(html).toContain("只读全量预演");
  expect(html).not.toMatch(/\d+(?:\.\d+)?%|<script\b/);
  expect(JSON.stringify(data)).not.toMatch(/"(?:coverage|diagnosticCoverage|recordCoverage)":|\/home\/runner\/|actualRawOutput/);
});

test("stages deterministic sidecar files without touching the catalog or existing reports", () => {
  const root = mkdtempSync(join(tmpdir(), "curated-sidecar-"));
  try {
    const reports = join(root, "reports");
    mkdirSync(reports);
    const existing = { "catalog.json": "legacy catalog", "index.json": "legacy index", "old.html": "old report" };
    for (const [file, body] of Object.entries(existing)) writeFileSync(join(reports, file), body);
    const path = stageCuratedComparison(root);
    expect(path).toBe(join(reports, suiteId));
    const homepage = readFileSync(join(REPO_ROOT, "site", "index.html"), "utf8");
    const href = homepage.match(/href="(\.\/reports\/curated-difference-v1\/index\.html)"/)?.[1];
    expect(href).toBe(`./reports/${suiteId}/index.html`);
    expect(readFileSync(join(root, href!), "utf8")).toBe(curatedComparisonHtml(data));
    expect(readdirSync(path).sort()).toEqual(["comparison.json", "index.html"]);
    expect(readFileSync(join(path, "comparison.json"), "utf8")).toBe(`${JSON.stringify(data, null, 2)}\n`);
    expect(() => stageCuratedComparison(root)).toThrow();
    for (const [file, body] of Object.entries(existing)) expect(readFileSync(join(reports, file), "utf8")).toBe(body);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a reports symlink to a sibling is rejected without writing outside the staging root", () => {
  const root = mkdtempSync(join(tmpdir(), "curated-sidecar-links-"));
  try {
    const web = join(root, "web");
    const sibling = join(root, "sibling");
    mkdirSync(web);
    mkdirSync(sibling);
    writeFileSync(join(sibling, "sentinel"), "untouched");
    symlinkSync(sibling, join(web, "reports"), "dir");
    expect(() => stageCuratedComparison(web)).toThrow("Expected a real directory");
    expect(readdirSync(sibling)).toEqual(["sentinel"]);
    expect(readFileSync(join(sibling, "sentinel"), "utf8")).toBe("untouched");

    const alias = join(root, "web-link");
    symlinkSync(sibling, alias, "dir");
    expect(() => stageCuratedComparison(alias)).toThrow("Expected a real directory");
    expect(readdirSync(sibling)).toEqual(["sentinel"]);

    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    expect(() => stageCuratedComparison(file)).toThrow("Expected a real directory");
    const otherWeb = join(root, "other");
    mkdirSync(otherWeb);
    writeFileSync(join(otherWeb, "reports"), "not a directory");
    expect(() => stageCuratedComparison(otherWeb)).toThrow("Expected a real directory");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a fresh staging root under an ancestor alias can be used without following a sidecar symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "curated-sidecar-alias-"));
  try {
    const real = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");
    const web = join(alias, "web");
    const path = stageCuratedComparison(web);
    expect(path).toBe(join(web, "reports", suiteId));
    expect(readdirSync(join(real, "web", "reports", suiteId)).sort()).toEqual(["comparison.json", "index.html"]);

    const blocked = join(alias, "blocked", "reports");
    mkdirSync(blocked, { recursive: true });
    symlinkSync(real, join(blocked, suiteId), "dir");
    expect(() => stageCuratedComparison(join(alias, "blocked"))).toThrow();
    expect(readdirSync(real).sort()).toEqual(["blocked", "web"]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("v1 refuses silently edited evidence even when the 33 target count is unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "curated-sidecar-pin-"));
  try {
    cpSync(join(REPO_ROOT, "config", suiteId), root, { recursive: true });
    const path = join(root, "evidence.json");
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    const target = evidence.cases.find((r: { configuration: string | null }) => r.configuration !== null);
    target.configuration = "target=es2026";
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(() => loadCuratedComparison(root)).toThrow("Curated v1 input SHA-256 mismatch: evidence.json");
  } finally {
    rmSync(root, { recursive: true });
  }
});
