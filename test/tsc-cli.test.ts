// tsc-cli 参考适配器：输出解析与端到端（用假 tsc 脚本）测试。

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTscOutput, parseTscOutputDetailed, TscCliAdapter } from "../src/adapters/tsc-cli.ts";
import { containsOnlyKnownAuxiliaryLines, parsePlainDiagnostics } from "../src/adapters/plain-diagnostics.ts";

describe("parseTscOutput", () => {
  test("parses error/warning lines, strips temp dir, ignores outside files", () => {
    const tmp = join(tmpdir(), "tsc-compa-tsc-parse-test");
    const text = [
      `${tmp}/a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `${tmp}/sub/b.ts(10,2): warning TS6133: 'x' is declared but its value is never read.`,
      // 真实 tsc 的 lib 路径是绝对路径且位于用例目录之外；这类诊断不计入。
      `/opt/typescript/lib/lib.es5.d.ts(1430,5): error TS2314: Generic type 'Array<T>' requires 1 type argument(s).`,
      ``,
    ].join("\n");
    const diags = parseTscOutput(tmp, text);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({ file: "a.ts", line: 0, col: 4, code: 2322, severity: "error" });
    expect(diags[1]).toMatchObject({ file: "sub/b.ts", line: 9, col: 1, code: 6133, severity: "warning" });
  });
});

describe("TscCliAdapter", () => {
  test("drives a fake tsc binary and maps its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-fake-tsc-"));
    const bin = join(dir, "fake-tsc");
    // 假 tsc：以最后一个参数（虚文件绝对路径）为锚点回声一条错误，退出码 2（真实 tsc 有诊断时的码）。
    writeFileSync(
      bin,
      '#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\necho "$last(1,2): error TS9999: fake" >&2\nexit 2\n',
    );
    chmodSync(bin, 0o755);
    try {
      const adapter = new TscCliAdapter({ bin });
      const outcome = await adapter.check({
        id: "case.ts",
        files: [{ path: "x.ts", text: "const x = 1;" }],
        options: [],
        args: ["--noEmit", "--pretty", "false"],
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toMatchObject([
        {
          file: "x.ts",
          line: 0,
          col: 1,
          code: 9999,
          severity: "error",
          message: "fake",
          fullText: "x.ts(1,2): error TS9999: fake",
        },
      ]);
      expect(outcome.fullText).toBe("x.ts(1,2): error TS9999: fake");
      expect(outcome.exitCode).toBe(2);
      expect(outcome.rawOutput?.stderr).toContain("TS9999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("plain diagnostics fail/clean 判定", () => {
  const timing = [
    "Files:              91",
    "Lines:           59701",
    "Identifiers:     50421",
    "Symbols:         59784",
    "Types:           34863",
    "Instantiations:  33973",
    "Memory used:    52742K",
    "Memory allocs:  274927",
    "Parse time:     0.015s",
    "Bind time:      0.007s",
    "Check time:     0.113s",
    "Emit time:      0.000s",
    "Total time:     0.136s",
  ].join("\n");

  test("已知 extendedDiagnostics 输出可以解释 clean 结果", () => {
    expect(containsOnlyKnownAuxiliaryLines(timing)).toBe(true);
  });

  test("真实 TS6/TS5.9 的混合大小写 time 与 Lines of Library 统计可解释", () => {
    const text = [
      "Files:                         22",
      "Lines of Library:           52740",
      "Lines of Definitions:           0",
      "Lines of TypeScript:           13",
      "Lines of JavaScript:            0",
      "Lines of JSON:                  0",
      "Lines of Other:                 0",
      "Identifier\u0073:                45863",
      "Assignability cache size:       0",
      "Strict subtype cache size:      0",
      "I/O Read time:              0.00s",
      "ResolveLibrary time:         0.00s",
      "ResolveModule time:         0.00s",
      "printTime time:             0.00s",
    ].join("\n");
    expect(containsOnlyKnownAuxiliaryLines(text)).toBe(true);
  });

  test("tsrs 的 Program/Diagnostics/Checkers 明细行也属于已知辅助输出", () => {
    const tsrs = [
      timing,
      "Program: root file lookups:            0.001s",
      "Program:   loader rounds:                  13",
      "Diagnostics: syntactic:                0.000s",
      "Checkers: create:                      0.001s",
      "Emit:                                  0.000s",
      "Statistics:                            0.000s",
    ].join("\n");
    expect(containsOnlyKnownAuxiliaryLines(tsrs)).toBe(true);
  });

  test("无位置诊断被识别为 unpositioned，不当成零诊断", () => {
    const parsed = parsePlainDiagnostics("/tmp/none", "error TS6046: Argument for '--module' option must be: 'commonjs'.\n");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.unpositioned).toMatchObject([{ severity: "error", code: 6046 }]);
  });

  test("未知残留文本不被 white list 吞掉", () => {
    expect(containsOnlyKnownAuxiliaryLines("error: something unexpected\n")).toBe(false);
  });
});


describe("TscCliAdapter 输出分类", () => {
  const withFake = async (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-fake-classify-"));
    const bin = join(dir, "fake-tsc");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    try {
      const adapter = new TscCliAdapter({ bin });
      return await adapter.check({
        id: "case.ts",
        files: [{ path: "x.ts", text: "export {};" }],
        options: [],
        args: ["--noEmit", "--pretty", "false", "--extendedDiagnostics"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("clean 且只有 extendedDiagnostics 统计 → ok / fullText 空串 / exitCode 0", async () => {
    const outcome = await withFake(
      '#!/bin/sh\necho "Files: 1"\necho "Parse time: 0.001s"\necho "Bind time: 0.001s"\necho "Check time: 0.002s"\necho "Total time: 0.004s"\nexit 0\n',
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.fullText).toBe("");
    expect(outcome.checkMs).toBe(2);
    expect(outcome.rawOutput?.stdout).toContain("Check time");
  });

  test("非零退出且无诊断 → crash，不当作零诊断", async () => {
    const outcome = await withFake('#!/bin/sh\necho "internal failure" >&2\nexit 1\n');
    expect(outcome.status).toBe("crash");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.rawOutput?.stderr).toContain("internal failure");
  });

  test("未知输出文本且退出 0 → crash，不当作零诊断", async () => {
    const outcome = await withFake('#!/bin/sh\necho "something unexpected"\nexit 0\n');
    expect(outcome.status).toBe("crash");
    expect(outcome.rawOutput?.stdout).toContain("something unexpected");
  });

  test("非空 pretty 诊断 → skip（unsupported），不当作零诊断", async () => {
    const outcome = await withFake(
      '#!/bin/sh\necho "\u001b[96ma.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m TS2322: bad"\nexit 2\n',
    );
    expect(outcome.status).toBe("skip");
    expect(outcome.skipReason).toContain("pretty");
    expect(outcome.rawOutput?.stdout).toContain("TS2322");
  });

  test("无位置配置诊断 → skip，保留原文", async () => {
    const outcome = await withFake('#!/bin/sh\necho "error TS6046: Argument for module must be valid." >&2\nexit 1\n');
    expect(outcome.status).toBe("skip");
    expect(outcome.skipReason).toContain("无文件位置");
    expect(outcome.rawOutput?.stderr).toContain("TS6046");
  });

  test("无位置的文件缺失是执行异常，不是选项不支持", async () => {
    const outcome = await withFake('#!/bin/sh\necho "error TS6053: File not found." >&2\nexit 1\n');
    expect(outcome.status).toBe("crash");
    expect(outcome.rawOutput?.stderr).toContain("TS6053");
  });

  test("诊断顺序按输出原样保留", () => {
    const tmp = "/tmp/compa-order";
    const parsed = parseTscOutputDetailed(tmp, [
      `${tmp}/b.ts(2,1): error TS2322: second`,
      "  detail second",
      `${tmp}/a.ts(1,1): error TS2339: first`,
      "  detail first",
    ].join("\n"));
    expect(parsed.diagnostics.map((d) => d.file)).toEqual(["b.ts", "a.ts"]);
    expect(parsed.rendered).toBe([
      "b.ts(2,1): error TS2322: second",
      "  detail second",
      "a.ts(1,1): error TS2339: first",
      "  detail first",
    ].join("\n"));
  });
});
