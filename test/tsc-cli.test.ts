// tsc-cli 参考适配器：输出解析与端到端（用假 tsc 脚本）测试。

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTscOutput, TscCliAdapter } from "../src/adapters/tsc-cli.ts";

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
      expect(outcome.diagnostics).toEqual([
        { file: "x.ts", line: 0, col: 1, code: 9999, severity: "error", message: "fake" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
