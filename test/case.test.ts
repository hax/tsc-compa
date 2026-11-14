// case 解析与选项推导的单测。

import { expect, test } from "bun:test";
import { parseCase, toTscArgs } from "../src/case.ts";

test("单文件：指令行被剥离、选项按指令顺序收集", () => {
  const parsed = parseCase(
    "// @strict: true\n// @target: es2015\nlet x: number = 1;\n",
    "compiler/single.ts",
  );
  expect(parsed.skip).toBeNull();
  expect(parsed.unknown).toEqual([]);
  expect(parsed.files.length).toBe(1);
  expect(parsed.files[0]!.path).toBe("single.ts");
  expect(parsed.files[0]!.text).toContain("let x: number = 1;");
  expect(parsed.files[0]!.text).not.toContain("@strict");
  expect(parsed.options).toEqual([
    { name: "strict", value: true },
    { name: "target", value: "es2015" },
  ]);
});

test("@filename 切分多文件并按官方写法去除指令", () => {
  const raw = [
    "// @filename: a.ts",
    "export const a = 1;",
    "// @filename: b.ts",
    "import { a } from \"./a\";",
    "export const b = a;",
    "",
  ].join("\n");
  const parsed = parseCase(raw, "compiler/multi.ts");
  expect(parsed.skip).toBeNull();
  expect(parsed.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  expect(parsed.files[0]!.text).not.toContain("@filename");
  expect(parsed.files[1]!.text).toContain("./a");
});

test("skip 指令被识别为分类原因", () => {
  const parsed = parseCase("// @allowJs: true\nlet x = 1;\n", "compiler/x.ts");
  expect(parsed.skip).toBe("@allowJs");
});

test("未知指令进入 unknown，不会被静默忽略", () => {
  const parsed = parseCase("// @frobnicate: yes\nlet x = 1;\n", "compiler/x.ts");
  expect(parsed.unknown).toEqual(["@frobnicate"]);
});

test("含非 TS 虚拟文件的用例被跳过", () => {
  const raw = "// @filename: a.ts\nexport {};\n// @filename: b.js\nmodule.exports = {};\n";
  const parsed = parseCase(raw, "compiler/js.ts");
  expect(parsed.skip).toContain("非 TS");
});

test("流程参数：lib 列表与显式 false 都按 tsc 命令行拼", () => {
  const parsed = parseCase("// @lib: es2015,dom\n// @strict: false\n", "compiler/x.ts");
  expect(toTscArgs(parsed.options, ["--noEmit"])).toEqual([
    "--noEmit",
    "--lib",
    "es2015,dom",
    "--strict",
    "false",
  ]);
});
