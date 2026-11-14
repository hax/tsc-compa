// 用例分类与过滤的单测。

import { expect, test } from "bun:test";
import { parseCase } from "../src/case.ts";
import { classifyCase, exclusionOf, parseTagList, runtimeTags } from "../src/classify.ts";

test("suite / 文件数：compiler 单文件", () => {
  const parsed = parseCase("let x = 1;\n", "compiler/foo.ts");
  const tags = classifyCase("compiler/foo.ts", parsed);
  expect(tags).toContain("suite:compiler");
  expect(tags).toContain("files:single");
  expect(tags).not.toContain("files:multi");
});

test("多文件用例打 files:multi，conformance 归 suite:conformance", () => {
  const raw = "// @filename: a.ts\nexport const a = 1;\n// @filename: b.ts\nimport { a } from './a';\nexport const b = a;\n";
  const parsed = parseCase(raw, "conformance/modules/two.ts");
  const tags = classifyCase("conformance/modules/two.ts", parsed);
  expect(tags).toContain("suite:conformance");
  expect(tags).toContain("files:multi");
});

test("parser 目录与 parser 文件名打 shape:parser", () => {
  const raw = "let x = ;\n";
  const inDir = classifyCase("conformance/parser/ecmascript5/a.ts", parseCase(raw, "conformance/parser/ecmascript5/a.ts"));
  expect(inDir).toContain("shape:parser");
  const byName = classifyCase("compiler/parserRecovery.ts", parseCase(raw, "compiler/parserRecovery.ts"));
  expect(byName).toContain("shape:parser");
});

test("选项类标签：module / lib / emit", () => {
  const raw = "// @module: es2015\n// @lib: es2015\n// @declaration: true\nlet x = 1;\n";
  const tags = classifyCase("compiler/opts.ts", parseCase(raw, "compiler/opts.ts"));
  expect(tags).toContain("options:module");
  expect(tags).toContain("options:lib");
  expect(tags).toContain("options:emit");
});

test("语言与跳过类：lang:js / lang:jsx / env:skip", () => {
  const js = parseCase("// @filename: a.js\nlet x = 1;\n", "conformance/js/a.ts");
  expect(classifyCase("conformance/js/a.ts", js)).toContain("lang:js");

  const jsx = parseCase("// @jsx: preserve\nlet x = 1;\n", "conformance/jsx/a.ts");
  expect(classifyCase("conformance/jsx/a.ts", jsx)).toContain("lang:jsx");

  const env = parseCase("// @types: node\nlet x = 1;\n", "compiler/env.ts");
  expect(classifyCase("compiler/env.ts", env)).toContain("env:skip");
});

test("运行期标签：语法错误与零期望", () => {
  expect(runtimeTags({ status: "syntax", diagnostics: [] })).toEqual(["expect:syntax"]);
  expect(runtimeTags({ status: "ok", diagnostics: [] })).toEqual(["expect:no-errors"]);
  expect(runtimeTags({ status: "ok", diagnostics: [{ code: 2322 }] })).toEqual([]);
});

test("过滤：exclude 命中任意标签，only 要求全部标签", () => {
  const tags = ["suite:compiler", "files:single", "expect:no-errors"];
  expect(exclusionOf(tags, ["files:single"], [])).toBe("files:single");
  expect(exclusionOf(tags, [], ["suite:compiler", "files:single"])).toBeNull();
  expect(exclusionOf(tags, [], ["suite:conformance"])).toBe("缺少:suite:conformance");
  expect(exclusionOf(tags, ["shape:parser"], [])).toBeNull();
});

test("标签列表校验：未知标签报错", () => {
  expect(parseTagList("suite:compiler,files:single", "--x")).toEqual(["suite:compiler", "files:single"]);
  expect(() => parseTagList("suite:compiler,nope", "--x")).toThrow("未知标签");
});
