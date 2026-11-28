// v1 options remain an array. Interpret only explicitly understood compiler
// flag shapes; never use a peer's whitelist as a parser for arbitrary args.
import type { AdapterCapabilities, CaseInput, CompilerOption, OptionRejection, OptionValue } from "../types.ts";

const flags = new Map<string, { name: string; shape: "bool" | "string" | "list" }>();
for (const [shape, names] of [
  ["bool", `strict strictNullChecks strictFunctionTypes strictBindCallApply strictPropertyInitialization strictBuiltinIteratorReturn
    noImplicitAny noImplicitThis alwaysStrict useUnknownInCatchVariables exactOptionalPropertyTypes noUncheckedIndexedAccess
    noPropertyAccessFromIndexSignature noImplicitOverride noUnusedLocals noUnusedParameters noFallthroughCasesInSwitch noImplicitReturns
    esModuleInterop allowSyntheticDefaultImports skipLibCheck skipDefaultLibCheck useDefineForClassFields experimentalDecorators
    isolatedModules verbatimModuleSyntax erasableSyntaxOnly allowUnreachableCode allowUnusedLabels noResolve resolveJsonModule
    allowImportingTsExtensions allowArbitraryExtensions noUncheckedSideEffectImports preserveSymlinks declaration emitDeclarationOnly
    noEmit ignoreConfig pretty noErrorTruncation noLib allowJs checkJs composite downlevelIteration rewriteRelativeImportExtensions`],
  ["string", "target module moduleResolution moduleDetection jsx jsxImportSource jsxFactory jsxFragmentFactory"],
  ["list", "lib types"],
] as const) {
  for (const name of names.split(/\s+/)) flags.set(name.toLowerCase(), { name, shape });
}

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const isOptionValue = (value: unknown): value is OptionValue => typeof value === "boolean" || typeof value === "string" ||
  (Array.isArray(value) && value.every(v => typeof v === "string"));
const normalizedName = (name: string) => name.toLowerCase();
const validName = (name: unknown): name is string => typeof name === "string" && /^[a-z][a-z0-9]*$/i.test(name);
const canonicalName = (name: string) => (flags.get(normalizedName(name))?.name ?? name) === name;
export const rejectionKind = (code: unknown) => {
  if (code === "unsupportedOption" || code === "unsupported-option") return "unsupported-option";
  if (code === "unsupportedValue" || code === "unsupported-value") return "unsupported-value";
  return undefined;
};

function listOfNames(value: unknown, canonical = false) {
  if (!Array.isArray(value) || !value.every(validName) || (canonical && !value.every(canonicalName))) return undefined;
  const names = [...value].sort();
  return new Set(names).size === names.length ? Object.freeze(names) : undefined;
}

/** null denotes absent; undefined denotes malformed or contradictory. */
export function readCapabilities(row: Record<string, unknown>): AdapterCapabilities | null | undefined {
  const keys = ["supportsOptions", "supportedOptions", "responseFields"];
  const parse = (value: unknown): AdapterCapabilities | undefined => {
    if (!object(value) || typeof value.supportsOptions !== "boolean") return undefined;
    const supportedOptions = listOfNames(value.supportedOptions, true);
    const responseFields = listOfNames(value.responseFields);
    const version = value.version;
    if (!supportedOptions || !responseFields || typeof version !== "string" || !version.trim() || version.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(version) || (!value.supportsOptions && supportedOptions.length !== 0)) return undefined;
    return Object.freeze({ supportsOptions: value.supportsOptions, supportedOptions, responseFields, version });
  };
  const top = keys.some(key => Object.hasOwn(row, key));
  const nested = Object.hasOwn(row, "capabilities");
  if (!top && !nested) return null;
  const a = top ? parse(row) : null;
  const b = nested ? parse(row.capabilities) : null;
  if (a === undefined || b === undefined || (a && b && !sameCapabilities(a, b))) return undefined;
  return a ?? b;
}

export function sameCapabilities(a: AdapterCapabilities, b: AdapterCapabilities): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const sameValue = (a: OptionValue, b: OptionValue) => JSON.stringify(a) === JSON.stringify(b);
function issue(input: CaseInput, kind: OptionRejection["kind"], source: OptionRejection["source"], reason: string, option?: CompilerOption, errorCode?: string): OptionRejection {
  return { kind, source, reason, ...(option && { option: structuredClone(option) }), args: [...input.args], options: structuredClone(input.options), ...(errorCode && { errorCode }) };
}

// These affect formatting of the tsc CLI stream, not the input type checking
// rules. NDJSON cannot use pretty terminal output. All semantic flags (including
// both library skip flags) require a declaration; no flags are stripped on wire.
const transportFlags = new Set(["pretty", "noErrorTruncation"]);
function effectiveOptions(input: CaseInput): { values: Map<string, CompilerOption>; error?: OptionRejection } {
  const values = new Map<string, CompilerOption>();
  const ambiguous = (reason: string, option?: CompilerOption) => ({ values, error: issue(input, "unrecognized-argument", "preflight", reason, option) });
  for (let i = 0; i < input.args.length; i++) {
    const token = input.args[i]!;
    const match = /^--([a-z][a-z0-9]*)$/i.exec(token);
    if (!match) return ambiguous(`无法按编译选项解释参数 ${JSON.stringify(token)}`);
    const rawName = match[1]!;
    const spec = flags.get(normalizedName(rawName));
    if (!spec || rawName !== spec.name) return ambiguous(`未知编译选项 ${token}`);
    const next = input.args[i + 1];
    let value: OptionValue;
    if (spec.shape === "bool") {
      value = next === "true" || next === "false" ? input.args[++i] === "true" : true;
    } else {
      if (next === undefined || next.startsWith("-") || (spec.shape === "string" && !next.length)) return ambiguous(`编译选项 ${token} 缺少可识别的值`);
      i++;
      value = spec.shape === "list" ? (next === "" ? [] : next.split(",").map(part => part.trim())) : next;
      if (Array.isArray(value) && value.some(part => !part)) return ambiguous(`编译选项 ${token} 的列表含空项`, { name: spec.name, value });
    }
    values.set(spec.name, { name: spec.name, value });
  }
  const structured = new Map<string, CompilerOption>();
  for (const option of input.options) {
    const spec = flags.get(normalizedName(option.name));
    if (!spec || option.name !== spec.name || (spec.shape === "bool" ? typeof option.value !== "boolean" : spec.shape === "string" ? typeof option.value !== "string" || !option.value : !Array.isArray(option.value) || option.value.some(part => !part))) {
      return ambiguous(`无法按编译选项解释结构化参数 ${option.name}`, option);
    }
    const previous = structured.get(spec.name);
    if (previous && !sameValue(previous.value, option.value)) return ambiguous(`编译选项 ${spec.name} 的结构化值重复且冲突`, option);
    structured.set(spec.name, { name: spec.name, value: option.value });
  }
  for (const [name, option] of structured) {
    const cli = values.get(name);
    if (cli && !sameValue(cli.value, option.value)) return ambiguous(`编译选项 ${name} 的结构化值与命令行值冲突`, option);
    values.set(name, option);
  }
  return { values };
}

function unsupportedOptions(values: Map<string, CompilerOption>, caps: AdapterCapabilities) {
  const supported = new Set(caps.supportedOptions);
  return [...values.values()].filter(o => !transportFlags.has(o.name) && !supported.has(o.name));
}

export function preflight(input: CaseInput, caps: AdapterCapabilities, source: "preflight" | "unchecked-result"): OptionRejection | undefined {
  if (!caps.supportsOptions) return undefined;
  const { values, error } = effectiveOptions(input);
  if (error) return { ...error, source };
  const missing = unsupportedOptions(values, caps)[0];
  return missing && issue(input, "unsupported-option", source,
    `${source === "unchecked-result" ? "实现返回正常诊断结果，但" : ""}未声明支持编译选项 ${missing.name}`, missing);
}

/** Do not infer an option from an arbitrary message. Match structured evidence
 * to the request, or infer a single missing option from a proven capability set. */
export function workerRejection(input: CaseInput, caps: AdapterCapabilities | undefined, code: string, reason: string,
  supplied?: { name: string; value?: OptionValue }): OptionRejection | undefined {
  const kind = rejectionKind(code);
  if (!kind) return undefined;
  const { values, error } = effectiveOptions(input);
  let option: CompilerOption | undefined;
  if (supplied) {
    option = values.get(supplied.name);
    if (error || !option || (supplied.value !== undefined && !sameValue(supplied.value, option.value))) return undefined;
  } else if (!error && caps?.supportsOptions && kind === "unsupported-option") {
    const missing = unsupportedOptions(values, caps);
    if (missing.length === 1) option = missing[0];
  }
  return issue(input, kind, "worker", reason, option, code);
}
