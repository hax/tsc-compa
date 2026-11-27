// 用例分类：给每个用例打正交标签，供过滤与「按类」指标使用。
//
// 标签是正交的——一个用例可以同时是 conformance、multi-file、parser。
// 因此 `byClass` 里的数字不能相加；suite:* 两类除外（互斥且覆盖全部）。
// 标签来源分两层：
//   - 静态：从用例路径与指令推导（classifyCase）；
//   - 运行期：拿到 tsc 期望之后才知道的（expect:syntax / expect:no-errors）。
//
// 分类的目的不是给用例「打分」，而是让指标可以按类解释：
// 语法错误、JS/JSX、emit/环境类指令这些用例，对类型检查兼容性的含义与
// 普通语义用例不同，混在一起报一个数字会误导。

import type { ParsedCase } from "./case.ts";

/** 静态标签（不依赖 tsc 期望）。 */
export type StaticTag =
  | "suite:compiler"
  | "suite:conformance"
  | "suite:other"
  | "files:single"
  | "files:multi"
  | "lang:js"
  | "lang:jsx"
  | "shape:parser"
  | "options:module"
  | "options:lib"
  | "options:emit"
  | "env:skip";

/** 运行期标签（需要 tsc 期望）。 */
export type RuntimeTag = "expect:syntax" | "expect:no-errors";

export type CaseTag = StaticTag | RuntimeTag;

/** 全部已知标签（文档、过滤参数校验与按类输出的白名单）。 */
export const CASE_TAGS: readonly CaseTag[] = [
  "suite:compiler",
  "suite:conformance",
  "suite:other",
  "files:single",
  "files:multi",
  "lang:js",
  "lang:jsx",
  "shape:parser",
  "options:module",
  "options:lib",
  "options:emit",
  "env:skip",
  "expect:syntax",
  "expect:no-errors",
];

/** emit/declaration 类选项；有些会改变诊断，单独分类。 */
const EMIT_DIRECTIVES = new Set([
  "declaration",
  "declarationmap",
  "emitdeclarationonly",
  "outdir",
  "outfile",
  "out",
  "sourcemap",
  "inlinesourcemap",
  "maproot",
  "sourceroot",
  "removecomments",
  "noemit",
  "noemitonerror",
  "noemithelpers",
  "emitdecoratormetadata",
  "importhelpers",
  "downleveliteration",
  "preserveconstenums",
  "incremental",
  "composite",
  "tsbuildinfofile",
]);

/** 环境类跳过指令（用例依赖 @types 包 / 工程布局等，skeleton 环境不具备）。 */
const ENV_SKIP_DIRECTIVES = ["@types", "@typeRoots", "@paths", "@baseUrl", "@rootDirs", "@symlink", "@currentDirectory"];

const MODULE_OPTIONS = new Set(["module", "moduleResolution", "moduleDetection"]);

const NON_TS_EXT = /\.(js|jsx|mjs|cjs|json)$/;

/** 用例所在目录就是 parser 用例（语法错误高发），或文件名带 parser。 */
function isParserShape(id: string): boolean {
  return id.startsWith("conformance/parser/") || /(^|\/)parser[^/]*\.ts$/.test(id);
}

/**
 * 静态分类：只看用例路径与解析结果，不跑 tsc。
 *
 * 注意：这里对 skip 用例也照常打标签——分类用于解释「为什么被排除」，
 * 而不是只服务已跑用例。
 */
export function classifyCase(id: string, parsed: ParsedCase): StaticTag[] {
  const tags: StaticTag[] = [];
  const suite = id.split("/")[0] ?? "";
  if (suite === "compiler" || suite === "conformance") tags.push(`suite:${suite}`);
  else tags.push("suite:other");

  tags.push(parsed.files.length > 1 ? "files:multi" : "files:single");

  const hasJs = parsed.files.some((f) => NON_TS_EXT.test(f.path));
  if (hasJs) tags.push("lang:js");
  const jsxByFile = parsed.files.some((f) => /\.(tsx|jsx)$/.test(f.path));
  const jsxBySkip = (parsed.skip ?? "").includes("@jsx");
  if (jsxByFile || jsxBySkip) tags.push("lang:jsx");

  if (isParserShape(id)) tags.push("shape:parser");

  if (parsed.options.some((o) => MODULE_OPTIONS.has(o.name))) tags.push("options:module");
  if (parsed.options.some((o) => o.name === "lib")) tags.push("options:lib");
  if (parsed.ignored.some((key) => EMIT_DIRECTIVES.has(key)) || parsed.options.some((o) => EMIT_DIRECTIVES.has(o.name.toLowerCase()))) tags.push("options:emit");
  if (ENV_SKIP_DIRECTIVES.some((d) => (parsed.skip ?? "").startsWith(d))) tags.push("env:skip");

  return tags;
}

/** 运行期标签：由 tsc 期望结果决定。 */
export function runtimeTags(expectation: { status: string; diagnostics: unknown[] }): RuntimeTag[] {
  const tags: RuntimeTag[] = [];
  if (expectation.status === "syntax") tags.push("expect:syntax");
  if (expectation.status === "ok" && expectation.diagnostics.length === 0) tags.push("expect:no-errors");
  return tags;
}

/**
 * 过滤：exclude 命中任意标签即排除；only 要求包含全部标签。
 * 返回命中的标签（写进 skip 原因，便于对账），未命中返回 null。
 */
export function exclusionOf(tags: readonly string[], exclude: readonly string[], only: readonly string[]): string | null {
  const hit = exclude.find((t) => tags.includes(t));
  if (hit !== undefined) return hit;
  const missing = only.find((t) => !tags.includes(t));
  if (missing !== undefined) return `缺少:${missing}`;
  return null;
}

/** 解析逗号分隔的标签列表并校验在白名单内。 */
export function parseTagList(raw: string | undefined, flag: string): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const tag of tags) {
    if (!(CASE_TAGS as readonly string[]).includes(tag)) {
      throw new Error(`${flag} 含有未知标签 ${tag}；可用标签：${CASE_TAGS.join(", ")}`);
    }
  }
  return tags;
}
