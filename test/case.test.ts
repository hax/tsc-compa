// case 解析与选项推导的单测。

import { expect, test } from "bun:test";
import { expandCaseVariants, parseCase, toTscArgs } from "../src/case.ts";
import { isValidCaseId, loadManifest, readCase } from "../src/discover.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("无冒号指令行按 TS7 Go 规则保留为源码，不剥离也不生成选项", () => {
  const parsed = parseCase(
    "// @target: es2015\n// @strict\n\nclass C { p: string; }\nlet x: string = 1;\n",
    "compiler/no-colon.ts",
  );
  expect(parsed.options).toEqual([{ name: "target", value: "es2015" }]);
  expect(parsed.files[0]!.text.split("\n").slice(0, 5)).toEqual([
    "// @strict",
    "",
    "class C { p: string; }",
    "let x: string = 1;",
    "",
  ]);
});

test("缩进的指令形状注释属于源码，不被当成元数据剥离", () => {
  const parsed = parseCase("class C {\n  // @internal\n  x = 1;\n}\n", "compiler/indented.ts");
  expect(parsed.unknown).toEqual([]);
  expect(parsed.files[0]!.text).toContain("  // @internal");
});

test("行首、冒号前后允许空白的官方指令写法仍可解析", () => {
  const parsed = parseCase("//@module: commonjs\n// @target : ES6\nlet x = 1;\n", "compiler/spacing.ts");
  expect(parsed.options).toEqual([
    { name: "module", value: "commonjs" },
    { name: "target", value: "ES6" },
  ]);
  expect(parsed.files[0]!.text).toBe("let x = 1;\n");
});

test("manifest ID 必须唯一且是 corpus 内的 POSIX 相对路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-manifest-"));
  try {
    const manifest = join(dir, "cases.json");
    writeFileSync(manifest, JSON.stringify(["compiler/a.ts", "compiler/b.ts"]));
    expect(loadManifest(manifest)).toEqual(["compiler/a.ts", "compiler/b.ts"]);

    writeFileSync(manifest, JSON.stringify(["compiler/a.ts", "compiler/a.ts"]));
    expect(() => loadManifest(manifest)).toThrow("重复用例 ID");

    writeFileSync(manifest, JSON.stringify(["../outside.ts"]));
    expect(() => loadManifest(manifest)).toThrow("合法的 corpus 相对路径");

    expect(isValidCaseId("compiler/a.ts")).toBe(true);
    expect(isValidCaseId("/abs/a.ts")).toBe(false);
    expect(isValidCaseId("compiler\\a.ts")).toBe(false);
    expect(isValidCaseId("compiler//a.ts")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCase 按 BOM 解码 UTF-16LE / UTF-16BE，并剥离 UTF-8 BOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-decode-"));
  try {
    const le = Buffer.from("// @target: es2015\r\nlet x = 1;\r\n", "utf16le");
    writeFileSync(join(dir, "le.ts"), Buffer.concat([Buffer.from([0xff, 0xfe]), le]));
    expect(readCase(dir, "le.ts").files[0]!.text).toBe("let x = 1;\n");
    expect(readCase(dir, "le.ts").options).toEqual([{ name: "target", value: "es2015" }]);

    const be = Buffer.from("// @strict: true\nlet y = 2;\n", "utf16le").swap16();
    writeFileSync(join(dir, "be.ts"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    expect(readCase(dir, "be.ts").files[0]!.text).toBe("let y = 2;\n");
    expect(readCase(dir, "be.ts").options).toEqual([{ name: "strict", value: true }]);

    writeFileSync(join(dir, "bom8.ts"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("let z = 3;\n")]));
    expect(readCase(dir, "bom8.ts").files[0]!.text).toBe("let z = 3;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺失用例文件明确报错，而不是变成零诊断输入", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-missing-"));
  try {
    expect(() => readCase(dir, "compiler/missing.ts")).toThrow("无法读取用例文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("具名配置按选项名排序，lib 保持列表，声明开关传给编译器", () => {
  const parsed = parseCase("// @target: ES2015, ES2020\n// @lib: es2020,dom\n// @declaration: false,true\n// @emitDeclarationOnly: false\nlet x = 1;", "compiler/x.ts");
  const expanded = expandCaseVariants(parsed);
  expect(expanded.status).toBe("ok");
  if (expanded.status !== "ok") return;
  expect(expanded.variants.map((variant) => variant.variantId)).toEqual([
    "compiler/x(declaration=false,target=es2015).ts", "compiler/x(declaration=false,target=es2020).ts",
    "compiler/x(declaration=true,target=es2015).ts", "compiler/x(declaration=true,target=es2020).ts",
  ]);
  expect(expanded.variants[3]!.options).toEqual([
    { name: "target", value: "es2020" }, { name: "lib", value: ["es2020", "dom"] },
    { name: "declaration", value: true }, { name: "emitDeclarationOnly", value: false },
  ]);
});

test("无效的变体值不会成为文件名的一部分", () => {
  const expanded = expandCaseVariants(parseCase("// @target: es2015, ../../oops\nlet x = 1;", "compiler/x.ts"));
  expect(expanded.status).toBe("unsupported");
});
