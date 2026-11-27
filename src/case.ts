// 官方用例文件的解析：case 指令、虚拟文件切分与编译选项推导。
//
// 官方 corpus（microsoft/TypeScript 的 tests/cases）用行内指令描述用例：
//
//   // @target: es2015
//   // @strict: true
//   // @filename: a.ts
//   ...a.ts 的内容...
//
// 只有 TS7 Go runner 的 optionRegex 能识别的行才算指令；指令行本身不进入
// 源文本。单文件用例没有 @filename，虚拟文件名取用例文件名。
// 这里只做「把官方声明翻译成 tsc 可接受的选项」；哪些指令在 v0 被支持/跳过/
// 忽略见下方三张表，完整口径与后续对齐计划见 docs/DESIGN.md。

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CaseFile, CompilerOption, CompilerOptions, OptionValue } from "./types.ts";

// 官方 TS7 Go runner 的 optionRegex 固定在行首并强制 `@name:`：
//   `(?m)^\/{2}\s*@(\w+)\s*:\s*([^\r\n]*)`
// 因此 `// @strict` 这类无冒号行不是元数据，必须作为源文本保留，
// 否则诊断行号会整体偏移。缩进的 `// @internal` 同理是源码注释。
const META = /^\/{2}\s*@(\w+)\s*:\s*([^\r\n]*)/;

interface OptionSpec {
  /** tsc canonical 选项名（命令行参数拼作 --name）。 */
  name: string;
  kind: "bool" | "string" | "list";
}

// v0 支持的选项指令。名字按官方写法的小写匹配，flag 用 canonical 拼写。
const OPTION_DIRECTIVES: Record<string, OptionSpec> = {
  strict: { name: "strict", kind: "bool" },
  strictnullchecks: { name: "strictNullChecks", kind: "bool" },
  strictfunctiontypes: { name: "strictFunctionTypes", kind: "bool" },
  strictbindcallapply: { name: "strictBindCallApply", kind: "bool" },
  strictpropertyinitialization: { name: "strictPropertyInitialization", kind: "bool" },
  strictbuiltiniteratorreturn: { name: "strictBuiltinIteratorReturn", kind: "bool" },
  noimplicitany: { name: "noImplicitAny", kind: "bool" },
  noimplicitthis: { name: "noImplicitThis", kind: "bool" },
  alwaysstrict: { name: "alwaysStrict", kind: "bool" },
  useunknownincatchvariables: { name: "useUnknownInCatchVariables", kind: "bool" },
  exactoptionalpropertytypes: { name: "exactOptionalPropertyTypes", kind: "bool" },
  nouncheckedindexedaccess: { name: "noUncheckedIndexedAccess", kind: "bool" },
  nopropertyaccessfromindexsignature: { name: "noPropertyAccessFromIndexSignature", kind: "bool" },
  noimplicitoverride: { name: "noImplicitOverride", kind: "bool" },
  nounusedlocals: { name: "noUnusedLocals", kind: "bool" },
  nounusedparameters: { name: "noUnusedParameters", kind: "bool" },
  nofallthroughcasesinswitch: { name: "noFallthroughCasesInSwitch", kind: "bool" },
  noimplicitreturns: { name: "noImplicitReturns", kind: "bool" },
  esmoduleinterop: { name: "esModuleInterop", kind: "bool" },
  allowsyntheticdefaultimports: { name: "allowSyntheticDefaultImports", kind: "bool" },
  skiplibcheck: { name: "skipLibCheck", kind: "bool" },
  skipdefaultlibcheck: { name: "skipDefaultLibCheck", kind: "bool" },
  usedefineforclassfields: { name: "useDefineForClassFields", kind: "bool" },
  experimentaldecorators: { name: "experimentalDecorators", kind: "bool" },
  isolatedmodules: { name: "isolatedModules", kind: "bool" },
  verbatimmodulesyntax: { name: "verbatimModuleSyntax", kind: "bool" },
  erasablesyntaxonly: { name: "erasableSyntaxOnly", kind: "bool" },
  allowunreachablecode: { name: "allowUnreachableCode", kind: "bool" },
  allowunusedlabels: { name: "allowUnusedLabels", kind: "bool" },
  noresolve: { name: "noResolve", kind: "bool" },
  resolvejsonmodule: { name: "resolveJsonModule", kind: "bool" },
  allowimportingtsextensions: { name: "allowImportingTsExtensions", kind: "bool" },
  allowarbitraryextensions: { name: "allowArbitraryExtensions", kind: "bool" },
  nouncheckedsideeffectimports: { name: "noUncheckedSideEffectImports", kind: "bool" },
  preservesymlinks: { name: "preserveSymlinks", kind: "bool" },
  declaration: { name: "declaration", kind: "bool" },
  emitdeclarationonly: { name: "emitDeclarationOnly", kind: "bool" },
  target: { name: "target", kind: "string" },
  module: { name: "module", kind: "string" },
  moduleresolution: { name: "moduleResolution", kind: "string" },
  moduledetection: { name: "moduleDetection", kind: "string" },
  lib: { name: "lib", kind: "list" },
};

// v0 直接跳过的指令：它们改变「被测环境」而不是检查规则本身，skeleton 阶段
// 不对这类用例下结论。每条都给出可读的 skip 原因。
const SKIP_DIRECTIVES: Record<string, string> = {
  allowjs: "@allowJs",
  checkjs: "@checkJs",
  jsx: "@jsx",
  jsximportsource: "@jsxImportSource",
  jsxfactory: "@jsxFactory",
  jsxfragmentfactory: "@jsxFragmentFactory",
  notypesandsymbols: "@noTypesAndSymbols",
  libfiles: "@libFiles",
  symlink: "@symlink",
  link: "@link",
  currentdirectory: "@currentDirectory",
  baselinefile: "@baselineFile",
  includebuiltfile: "@includeBuiltFile",
  fullemitpaths: "@fullEmitPaths",
  noimplicitreferences: "@noImplicitReferences",
  typescriptversion: "@typescriptVersion",
  // 环境相关：依赖 @types 包或工程布局，skeleton 的临时目录环境不具备
  types: "@types",
  typeroots: "@typeRoots",
  paths: "@paths",
  basedir: "@baseUrl",
  baseroot: "@baseUrl",
  rootdirs: "@rootDirs",
};

// 忽略的指令：只影响 emit/诊断文案/速度，不影响 v0 比较的「错误码 + 位置」。
const IGNORED_DIRECTIVES = new Set([
  "declarationmap", "outdir", "outfile",
  "out", "sourcemap", "inlinesourcemap", "maproot", "sourceroot", "removecomments",
  "noemit", "noemitonerror", "noemithelpers", "emitdecoratormetadata",
  "importhelpers", "downleveliteration", "preserveconstenums", "newline",
  "noerrortruncation", "pretty", "traceresolution", "diagnostics",
  "extendeddiagnostics", "generatecpuprofile", "listfiles", "listemittedfiles",
  "explainfiles", "incremental", "composite", "tsbuildinfofile", "watch",
  "preservewatchoutput", "disablesizelimit", "maxnodemoduledepth",
  "disablesourceofprojectreferenceredirect", "assumechangesonlyaffectdirectdependencies",
  "usejsxelementtypes", "comments", "importsnotusedasvalues",
  "preservevalueimports", "noimplicitusestrict",
]);

/** 用例虚拟文件允许的扩展名；其它（.js/.jsx/.json 等）在 v0 直接跳过。 */
const TS_EXT = /\.(ts|mts|cts)$/;

export interface ParsedCase {
  id: string;
  files: CaseFile[];
  /** 由指令推导的选项（不含默认值）。 */
  options: CompilerOptions;
  /** 非 null 时整个用例跳过，值为分类原因。 */
  skip: string | null;
  ignored: string[];
  unknown: string[];
  multiValueDirectives: string[];
  optionSettings?: Record<string, string>;
  absoluteFiles: string[];
}

function parseValue(kind: OptionSpec["kind"], raw: string): OptionValue | null {
  if (kind === "bool") {
    const v = raw.trim().toLowerCase();
    if (v === "" || v === "true") return true;
    if (v === "false") return false;
    return null;
  }
  if (kind === "list") {
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const v = raw.trim();
  return v.length === 0 ? null : v;
}

/** 规范化虚拟文件路径：去掉前导 `/` 与 `./`；含 `..` 视为越界（跳过）。 */
function normalizeVirtualPath(path: string): { path: string; escapes: boolean } {
  const p = path.trim().replace(/^\.\/+/, "").replace(/^\/+/, "");
  const escapes = p.split("/").some((seg) => seg === "..");
  return { path: p, escapes };
}

export function parseCase(raw: string, id: string): ParsedCase {
  const result: ParsedCase = {
    id,
    files: [],
    options: [],
    skip: null,
    ignored: [],
    unknown: [],
    multiValueDirectives: [],
    absoluteFiles: [],
  };
  const directives = new Map<string, string>();
  const lines = raw.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  let currentPath: string | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    const m = META.exec(line);
    if (m === null) {
      // 与官方 harness 的 makeUnitsFromTest 对齐：每个单元的首个非空行之前
      // 的空行不进入内容（harness 里 content 在首行之前保持空串，空行被吞），
      // 否则基线行号会整体 +1。
      if (buffer.length === 0 && line.length === 0) continue;
      buffer.push(line);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "filename") {
      if (currentPath !== null) result.files.push({ path: currentPath, text: buffer.join("\n") });
      const normalized = normalizeVirtualPath(value);
      if (normalized.escapes) result.skip ??= "虚拟文件路径越出用例根";
      if (value.startsWith("/")) result.absoluteFiles.push(value);
      currentPath = normalized.path.length > 0 ? normalized.path : null;
      buffer = [];
      continue;
    }
    if (currentPath !== null) {
      // @filename 之后的指令只作用于后面的文件；v0 视为未知形态，跳过用例。
      result.unknown.push(`@${key}（位于文件内容之间）`);
      continue;
    }
    if (SKIP_DIRECTIVES[key] !== undefined) {
      result.skip ??= SKIP_DIRECTIVES[key]!;
    } else if (OPTION_DIRECTIVES[key] !== undefined) {
      directives.set(key, value);
    } else if (IGNORED_DIRECTIVES.has(key)) {
      result.ignored.push(key);
    } else {
      result.unknown.push(`@${m[1]!}`);
    }
  }

  if (currentPath !== null) {
    result.files.push({ path: currentPath, text: buffer.join("\n") });
  } else {
    result.files.push({ path: basename(id), text: buffer.join("\n") });
  }

  result.optionSettings = Object.fromEntries(directives);
  for (const [key, value] of directives) {
    const spec = OPTION_DIRECTIVES[key]!;
    if (spec.kind !== "list" && value.includes(",")) {
      result.multiValueDirectives.push(`@${key}`);
      continue;
    }
    const parsed = parseValue(spec.kind, value);
    if (parsed === null) {
      result.unknown.push(`@${key} 的值无法解析：${value}`);
      continue;
    }
    result.options.push({ name: spec.name, value: parsed });
  }

  for (const file of result.files) {
    if (!TS_EXT.test(file.path)) result.skip ??= `含非 TS 虚拟文件 ${basename(file.path)}`;
  }
  return result;
}

export interface CaseVariant {
  caseId: string;
  variantId: string;
  configName: string;
  fileName: string;
  baselineStem: string;
  settings: Readonly<Record<string, string>>;
  options: CompilerOptions;
}

export type CaseVariantExpansion = { status: "ok"; variants: CaseVariant[] } | { status: "unsupported"; reason: string };

/** Expand supported scalar directives; list options (e.g. lib) are one value. */
export function expandCaseVariants(parsed: ParsedCase): CaseVariantExpansion {
  const name = basename(parsed.id);
  const index = name.lastIndexOf(".");
  const stem = index < 0 ? name : name.slice(0, index);
  const extension = index < 0 ? "" : name.slice(index);
  const settings = parsed.optionSettings ?? {};
  const keys = Object.keys(settings).sort();
  const dimensions: [string, string[]][] = [];
  let size = 1;
  for (const key of keys) {
    const spec = OPTION_DIRECTIVES[key];
    const value = settings[key]!;
    if (spec === undefined || spec.kind === "list" || !value.includes(",")) continue;
    const choices = [...new Set(value.split(",").map((item) => item.trim().toLowerCase()))];
    // Do not use raw input as a path component. Official scalar values are identifiers.
    if (choices.some((choice) => !/^[a-z0-9_-]+$/.test(choice) || parseValue(spec.kind, choice) === null)) {
      return { status: "unsupported", reason: `不支持的多值指令 @${key}: ${value}` };
    }
    if (choices.length < 2) return { status: "unsupported", reason: `多值指令 @${key} 缺少不同的配置值` };
    size *= choices.length;
    if (size > 256) return { status: "unsupported", reason: "多值指令的组合数超过 256" };
    dimensions.push([key, choices]);
  }
  if (dimensions.length === 0 && parsed.multiValueDirectives.length > 0) {
    return { status: "unsupported", reason: "多值指令缺少配置值" };
  }
  let combinations: Record<string, string>[] = [{}];
  for (const [key, choices] of dimensions) combinations = combinations.flatMap((values) => choices.map((choice) => ({ ...values, [key]: choice })));
  return {
    status: "ok",
    variants: combinations.map((overrides) => {
      const configName = Object.entries(overrides).map(([key, value]) => `${key}=${value}`).join(",");
      const final = { ...settings, ...overrides };
      const baselineStem = configName === "" ? stem : `${stem}(${configName})`;
      const fileName = baselineStem + extension;
      const options = configName === "" ? parsed.options : Object.entries(final).flatMap(([key, value]) => {
        const spec = OPTION_DIRECTIVES[key]!;
        const option = parseValue(spec.kind, value);
        return option === null ? [] : [{ name: spec.name, value: option }];
      });
      return { caseId: parsed.id, variantId: parsed.id.slice(0, -name.length) + fileName, configName, fileName, baselineStem,
        settings: final, options };
    }),
  };
}

/** 把选项转成 tsc 风格命令行参数（不含文件路径）。 */
export function toTscArgs(options: CompilerOptions, base: string[] = []): string[] {
  const args = [...base];
  for (const option of options) {
    const flag = `--${option.name}`;
    if (typeof option.value === "boolean") {
      // 显式 false 也必须传：用例可能覆盖默认值（例如 @strict: false）。
      args.push(flag, option.value ? "true" : "false");
    } else if (Array.isArray(option.value)) {
      args.push(flag, option.value.join(","));
    } else {
      args.push(flag, option.value);
    }
  }
  return args;
}

/** v0 的「官方默认」：不额外加选项，让 tsc 的默认值说话。 */
export const OFFICIAL_DEFAULTS: CompilerOptions = [];

/**
 * 固定口径选项：给「实现还不接受外部选项」的适配器做冒烟管线验证用。
 * 固定项为 strict + esnext + Bundler + 空 types；这种模式下的指标不是
 * 兼容性结论，运行器会明确标注。
 */
export const FIXED_STRICT_ESNEXT: CompilerOptions = [
  { name: "strict", value: true },
  { name: "target", value: "esnext" },
  { name: "module", value: "esnext" },
  { name: "moduleResolution", value: "bundler" },
  { name: "skipLibCheck", value: true },
  { name: "types", value: [] },
];

/** 把虚拟文件写到磁盘（适配器与 tsc 都按目录喂），返回绝对路径列表。 */
export function materializeCase(dir: string, files: CaseFile[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.text);
    paths.push(full);
  }
  return paths;
}
