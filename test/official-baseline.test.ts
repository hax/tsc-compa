import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseOfficialBaselineText, expectationFromOfficialBaseline } from "../src/officialBaseline.ts";
import type { ParsedCase } from "../src/case.ts";

function parsed(overrides: Partial<ParsedCase> = {}): ParsedCase {
  return {
    id: "compiler/Foo.ts",
    files: [{ path: "Foo.ts", text: "let a: number = 'x';" }],
    options: [],
    skip: null,
    ignored: [],
    unknown: [],
    multiValueDirectives: [],
    absoluteFiles: [],
    ...overrides,
  };
}

describe("parseOfficialBaselineText", () => {
  test("解析摘要块的诊断，忽略 elaboration 续行与正文段", () => {
    const text = [
      "Foo.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Type 'string' is not assignable to type 'number'.",
      "Foo.ts(2,3): error TS2554: Expected 1 arguments, but got 0.",
      "",
      "==== Foo.ts (2 errors) ====",
      "    let a: number = 'x';",
      "!!! error TS2322: ...",
    ].join("\n");
    const result = parseOfficialBaselineText(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.diagnostics.map((d) => `${d.line}:${d.col}:${d.code}`)).toEqual(["0:4:2322", "1:2:2554"]);
  });

  test("语法错误基线整体标为 unsupported（与期望源的语法即 SKIP 口径一致）", () => {
    const result = parseOfficialBaselineText("Foo.ts(1,1): error TS1005: '(' expected.\n");
    expect(result.status).toBe("unsupported");
  });

  test("无位置的配置错误标为 unsupported", () => {
    const result = parseOfficialBaselineText("error TS5107: Option 'module=AMD' is deprecated.\n");
    expect(result.status).toBe("unsupported");
  });

  test("0 错误基线返回空诊断（并保留原文供 T3）", () => {
    const text = "==== Foo.ts (0 errors) ====\n";
    const result = parseOfficialBaselineText(text);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.diagnostics).toEqual([]);
      expect(result.text).toBe(text);
    }
  });
});

describe("expectationFromOfficialBaseline", () => {
  test("按 plain 文件名读取基线；多值指令 / 绝对路径 / 缺失基线一律 skip", () => {
    const repo = mkdtempSync(join(tmpdir(), "tsc-compa-offbase-"));
    try {
      const corpus = join(repo, "tests", "cases");
      const dir = join(repo, "tests", "baselines", "reference");
      mkdirSync(corpus, { recursive: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Foo.errors.txt"), "Foo.ts(1,5): error TS2322: boom\n");
      const ok = expectationFromOfficialBaseline(corpus, "compiler/Foo.ts", parsed());
      expect(ok.status).toBe("ok");
      if (ok.status === "ok") expect(ok.diagnostics.length).toBe(1);

      const multi = expectationFromOfficialBaseline(corpus, "compiler/Foo.ts", parsed({ multiValueDirectives: ["@target"] }));
      expect(multi.status).toBe("skip");
      const abs = expectationFromOfficialBaseline(corpus, "compiler/Foo.ts", parsed({ absoluteFiles: ["/node_modules/x/index.d.ts"] }));
      expect(abs.status).toBe("skip");
      const missing = expectationFromOfficialBaseline(corpus, "compiler/Bar.ts", parsed({ id: "compiler/Bar.ts" }));
      // 官方只在有诊断时写 .errors.txt：缺基线 = 无期望错误（ok + 空诊断）。
      expect(missing.status).toBe("ok");
      if (missing.status === "ok") {
        expect(missing.diagnostics).toEqual([]);
        expect(missing.text).toBeNull();
      }
      const dts = expectationFromOfficialBaseline(corpus, "compiler/Foo.d.ts", parsed());
      expect(dts.status).toBe("skip");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("TS7 Go 布局：基线在 testdata/baselines/reference 下按相对目录分层", () => {
    const repo = mkdtempSync(join(tmpdir(), "tsc-compa-offbase-ts7-"));
    try {
      const corpus = join(repo, "tsc", "testdata", "tests", "cases");
      const dir = join(repo, "tsc", "testdata", "baselines", "reference", "compiler");
      mkdirSync(corpus, { recursive: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Foo.errors.txt"), "Foo.ts(2,7): error TS2322: boom\n");
      const outcome = expectationFromOfficialBaseline(corpus, "compiler/Foo.ts", parsed());
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") {
        expect(outcome.diagnostics.length).toBe(1);
        expect(outcome.text).toContain("TS2322");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("TS7 Go 布局：conformance 子目录拍平到 baselines/reference/conformance/<name>", () => {
    const repo = mkdtempSync(join(tmpdir(), "tsc-compa-offbase-ts7flat-"));
    try {
      const corpus = join(repo, "tsc", "testdata", "tests", "cases");
      const dir = join(repo, "tsc", "testdata", "baselines", "reference", "conformance");
      mkdirSync(corpus, { recursive: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Foo.errors.txt"), "Foo.ts(1,1): error TS2454: boom\n");
      const outcome = expectationFromOfficialBaseline(
        corpus,
        "conformance/es6/Symbols/Foo.ts",
        parsed({ id: "conformance/es6/Symbols/Foo.ts" }),
      );
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.diagnostics.length).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
