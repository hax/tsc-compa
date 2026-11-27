import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publicCatalog } from "../scripts/public-evaluation.ts";
import { stagePublicReports } from "../scripts/stage-public-reports.ts";

const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const reportId = "a".repeat(64);

function withData(check: (data: string, output: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "tsc-compa-pages-"));
  try {
    const data = join(root, "data");
    const reports = join(data, "reports");
    mkdirSync(reports, { recursive: true });
    write(join(reports, "catalog.json"), publicCatalog());
    write(join(reports, "index.json"), { schemaVersion: 1, reports: [] });
    check(reports, join(root, "staged"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("stages only the validated catalog and an empty index before the first evaluation", () => withData((data, output) => {
  writeFileSync(join(data, "index.json"), '{"reports":[{"secret":"shadowed"}],"schemaVersion":1,"reports":[]}');
  stagePublicReports(dirname(data), output);
  expect(readdirSync(output).sort()).toEqual(["catalog.json", "index.json"]);
  expect(JSON.parse(readFileSync(join(output, "catalog.json"), "utf8"))).toEqual(publicCatalog());
  const index = readFileSync(join(output, "index.json"), "utf8");
  expect(JSON.parse(index)).toEqual({ schemaVersion: 1, reports: [] });
  expect(index).not.toContain("shadowed");
}));

test("rejects extra HTML, hidden files, nested trees and orphaned reports before staging anything", () => {
  for (const name of ["payload.html", ".hidden", `${reportId}.html`, "nested"]) {
    withData((data, output) => {
      const path = join(data, name);
      if (name === "nested") mkdirSync(path);
      else writeFileSync(path, "<script>alert(1)</script>");
      expect(() => stagePublicReports(dirname(data), output)).toThrow("Unexpected file in public report data");
      expect(existsSync(output)).toBe(false);
    });
  }
});

test("rejects escaped IDs, duplicate IDs and missing files referenced by the index", () => {
  for (const id of ["../outside", `${reportId}\n`, "A".repeat(64)]) {
    withData((data, output) => {
      write(join(data, "index.json"), { schemaVersion: 1, reports: [{ id }] });
      expect(() => stagePublicReports(dirname(data), output)).toThrow(/Invalid public (?:report entry|index)/);
    });
  }
  withData((data, output) => {
    write(join(data, "index.json"), { schemaVersion: 1, reports: [{ id: reportId }, { id: reportId }] });
    expect(() => stagePublicReports(dirname(data), output)).toThrow(/Invalid public (?:report entry|index)/);
    write(join(data, "index.json"), { schemaVersion: 1, reports: [{ id: reportId }] });
    expect(() => stagePublicReports(dirname(data), output)).toThrow("Invalid public report entry");
  });
});

test("rejects misplaced fields and non-regular catalog or report inputs", () => withData((data, output) => {
  const catalog = join(data, "catalog.json");
  write(catalog, { ...publicCatalog(), secret: "example" });
  expect(() => stagePublicReports(dirname(data), output)).toThrow("Missing or invalid public catalog or index");
  write(catalog, publicCatalog());
  write(join(data, "index.json"), { schemaVersion: 1, reports: [], secret: "example" });
  expect(() => stagePublicReports(dirname(data), output)).toThrow("Invalid public index");
  rmSync(catalog);
  symlinkSync("index.json", catalog);
  expect(() => stagePublicReports(dirname(data), output)).toThrow("Missing or invalid public catalog or index");
  rmSync(catalog);
  write(catalog, publicCatalog());
  write(join(data, "index.json"), { schemaVersion: 1, reports: [{ id: reportId }] });
  symlinkSync("index.json", join(data, `${reportId}.json`));
  writeFileSync(join(data, `${reportId}.html`), "<script>alert(1)</script>");
  expect(() => stagePublicReports(dirname(data), output)).toThrow("Invalid public report entry");
  expect(existsSync(output)).toBe(false);
}));
