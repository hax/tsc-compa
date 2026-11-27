// 进程内 TS7 API 适配器：用 TypeScript 7.1 的 async API 一次建 program，
// 直接取结构化诊断，不经过 CLI 文本。
//
// 设计要点：
// - async API 走子进程 + JSON-RPC，Bun 下可用；sync 客户端依赖 Node 私有 fd，
//   Bun 不兼容，因此这里只依赖 async API。
// - API 实例按需创建并复用（默认 cwd=process.cwd()）；每个用例仍物化到独立
//   临时目录，rootFiles 用绝对路径，避免用例间共享 program。
// - 诊断完整性优先：保留 width、messageChain、related、attributes 与
//   formatDiagnostics 渲染出的 fullText。fullText 只含诊断摘要，不含源码标注。
// - 方法选择对齐 tsc CLI：先 syntactic；一旦有语法诊断就不再取 semantic，
//   因为 CLI 在语法错误后不会继续报告语义诊断。不取 bind 诊断：这些与
//   semantic 重复。
// - 不跨 API 方法去重：API 没有逐案进程退出码，也没有证据表明 CLI 会合并
//   不同方法的同形诊断；保留每一组返回里的全部条数与顺序，重复项交给比较层。
// - 无文件位置的诊断无法映射到套件的 file/line/col，返回 skip，不伪装成
//   “零诊断”；这与逐案 CLI 适配器的保守口径一致。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { materializeCase } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome, Diagnostic, DiagnosticPosition, MessageChain, RelatedDiagnostic } from "../types.ts";

export interface ApiDiagnosticPosition {
  line: number;
  character: number;
}

/** TS7 async API 的诊断响应（只声明本适配器用到的字段）。 */
export interface ApiDiagnosticResponse {
  fileName?: string;
  /** 原始响应字段，仅留存；适配器映射时保留。 */
  [key: string]: unknown;
  pos: number;
  end: number;
  startPosition?: ApiDiagnosticPosition;
  endPosition?: ApiDiagnosticPosition;
  code: number;
  category: number;
  source?: string;
  text: string;
  reportsUnnecessary?: boolean;
  reportsDeprecated?: boolean;
  messageChain?: readonly ApiDiagnosticResponse[];
  relatedInformation?: readonly ApiDiagnosticResponse[];
}

export interface ApiParsedCommandLine {
  fileNames: readonly string[];
  raw: Record<string, unknown>;
  errors: readonly ApiDiagnosticResponse[];
}

export interface ApiProgramLike {
  getProgramDiagnostics(): Promise<readonly ApiDiagnosticResponse[]>;
  getGlobalDiagnostics(): Promise<readonly ApiDiagnosticResponse[]>;
  getSyntacticDiagnostics(): Promise<readonly ApiDiagnosticResponse[]>;
  getSemanticDiagnostics(): Promise<readonly ApiDiagnosticResponse[]>;
  /** Pinned TS7 async API: declaration-emit diagnostics for the current program. */
  getDeclarationDiagnostics(): Promise<readonly ApiDiagnosticResponse[]>;
  getConfigFileParsingDiagnostics?(): Promise<readonly ApiDiagnosticResponse[]>;
  dispose(): Promise<void> | void;
}

export interface ApiClientLike {
  parseCommandLine(commandLine: readonly string[]): Promise<ApiParsedCommandLine>;
  createProgram(rootFiles: readonly string[], compilerOptions: Record<string, unknown>): Promise<ApiProgramLike>;
  close(): Promise<void> | void;
  getCanonicalFileName?(fileName: string): string;
}

export interface ApiFormatHost {
  getCurrentDirectory(): string;
  getCanonicalFileName(fileName: string): string;
  getNewLine(): string;
}

export type ApiDiagnosticFormatter = (
  diagnostics: readonly ApiDiagnosticResponse[],
  host: ApiFormatHost,
) => string;

export interface Ts7ApiAdapterOptions {
  name?: string;
  /** async API 的模块入口；默认 TS7 的 `typescript-7-1/async`。 */
  moduleName?: string;
  /** API 会话 cwd；默认当前进程 cwd。用例文件仍以绝对路径传给 program。 */
  cwd?: string;
  /** 传给 TS7 API 的 `tsserverPath`（通常是 TS7 原生二进制）。 */
  tsserverPath?: string;
  /** 放在用例参数之前的默认参数；默认 --noEmit --pretty false。 */
  extraArgs?: string[];
  /** 单案超时；超时只影响调用方，在途 API 请求仍会阻塞后续用例。 */
  timeoutMs?: number;
  /** close 等待在途请求的上限；超时后保留后台 API，不在请求在途时强行关闭。 */
  closeGraceMs?: number;
  /** 注入已构造的 API（测试/宿主集成用）。 */
  api?: ApiClientLike;
  /** 延迟创建 API（测试/宿主集成用）；优先于 `api`。 */
  apiFactory?: () => Promise<ApiClientLike>;
  /** 诊断渲染器；默认取模块里的 `formatDiagnostics`，不可用时用内置等价实现。 */
  formatter?: ApiDiagnosticFormatter;
}

interface NormalizedDiagnostic extends ApiDiagnosticResponse {
  fileName: string;
}

interface ApiProcessLike {
  stdin?: { end(): void; destroyed?: boolean } | null;
  kill?(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}

interface ApiClientInternals extends ApiClientLike {
  client?: { process?: ApiProcessLike | null };
}

const DEFAULT_EXTRA_ARGS = ["--noEmit", "--pretty", "false"];

/** 命令行解析会把文件/目录选项按 API 会话 cwd 绝对化；这些选项再按用例临时目录重定基。 */
const PATH_OPTIONS = new Set([
  "generateCpuProfile",
  "generateTrace",
  "outFile",
  "outDir",
  "rootDir",
  "tsBuildInfoFile",
  "baseUrl",
  "declarationDir",
]);
const PATH_LIST_OPTIONS = new Set(["rootDirs", "typeRoots"]);

/** API 适配器无法在一次无交互 program 检查中复现的 CLI 模式。 */
const UNSUPPORTED_MODE_FLAGS = new Map<string, string>([
  ["--project", "--project"],
  ["-p", "--project"],
  ["--watch", "--watch"],
  ["-w", "--watch"],
  ["--build", "--build"],
  ["-b", "--build"],
  ["--init", "--init"],
  ["--showconfig", "--showConfig"],
  ["--listfilesonly", "--listFilesOnly"],
  ["--help", "--help"],
  ["-h", "--help"],
  ["--version", "--version"],
  ["-v", "--version"],
]);

function unsupportedModeFlag(commandLine: readonly string[]): string | undefined {
  for (const arg of commandLine) {
    const flag = UNSUPPORTED_MODE_FLAGS.get(arg.split("=", 1)[0]!.toLowerCase());
    if (flag !== undefined) return flag;
  }
  return undefined;
}

function rebasedPath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

/** 不修改 parsed.raw，避免共享 API/调用方看到上一用例的临时路径。 */
function rebasePathOptions(raw: Record<string, unknown>, root: string): Record<string, unknown> {
  const options = { ...raw };
  for (const name of PATH_OPTIONS) {
    const value = options[name];
    if (typeof value === "string") options[name] = rebasedPath(root, value);
  }
  for (const name of PATH_LIST_OPTIONS) {
    const value = options[name];
    if (Array.isArray(value)) {
      options[name] = value.map((item) => typeof item === "string" ? rebasedPath(root, item) : item);
    }
  }
  return options;
}

function declarationRequested(raw: Record<string, unknown>): boolean {
  return raw.declaration === true || raw.composite === true || (raw.emitDeclarationOnly === true && raw.declaration !== false);
}

function endPositionOf(d: ApiDiagnosticResponse): DiagnosticPosition | undefined {
  const end = d.endPosition;
  if (end === undefined) return undefined;
  if (!Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character)) return undefined;
  if (end.line < 0 || end.character < 0) return undefined;
  return { line: end.line, col: end.character };
}

function positioned(d: ApiDiagnosticResponse): d is NormalizedDiagnostic & Required<Pick<ApiDiagnosticResponse, "startPosition">> {
  return typeof d.fileName === "string" && d.fileName.length > 0 && d.startPosition !== undefined;
}

function caseRelativePath(root: string, file: string): string | undefined {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * 宽度只由 startPosition/endPosition 的列差计算。pos/end 的编码口径
 * 不在本适配器内假定；跨行跨度没有单一的列宽，不猜，留 undefined。
 */
function spanWidth(d: ApiDiagnosticResponse): number | undefined {
  const start = d.startPosition;
  const end = d.endPosition;
  if (start === undefined || end === undefined) return undefined;
  if (!Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character)) return undefined;
  if (!Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character)) return undefined;
  if (start.line !== end.line || end.character < start.character) return undefined;
  return end.character - start.character;
}

/** TS7 API 未给 messageChain 子项时，空 children 是已知的「无子项」。 */
function mapChain(d: ApiDiagnosticResponse): MessageChain {
  return {
    text: d.text,
    code: d.code,
    category: d.category,
    attributes: attributesOf(d),
    children: d.messageChain?.map(mapChain) ?? [],
  };
}

/**
 * 顶层诊断的 messageChain 列表挂到根 message 下；没有列表时返回 null
 * （与 CLI 适配器的“明确无 chain”一致）。子项缺 children 时补 []。
 */
function mapMessageChain(d: ApiDiagnosticResponse): MessageChain | null {
  const children = d.messageChain?.map(mapChain) ?? [];
  if (children.length === 0) return null;
  return {
    text: d.text,
    code: d.code,
    category: d.category,
    attributes: attributesOf(d),
    children,
  };
}

function flattenMessage(d: ApiDiagnosticResponse, newLine: string, indent = 0): string {
  const pad = indent > 0 ? newLine + "  ".repeat(indent) : "";
  const children = d.messageChain?.map((child) => flattenMessage(child, newLine, indent + 1)).join("") ?? "";
  return `${pad}${d.text}${children}`;
}

function mapRelated(d: ApiDiagnosticResponse, root: string): RelatedDiagnostic {
  const out: RelatedDiagnostic = {
    message: flattenMessage(d, "\n"),
    category: d.category,
    messageChain: mapMessageChain(d),
    attributes: attributesOf(d),
    raw: d,
  };
  if (typeof d.fileName === "string" && d.fileName.length > 0) {
    out.file = caseRelativePath(root, d.fileName) ?? d.fileName;
  }
  if (d.startPosition !== undefined) {
    out.line = d.startPosition.line;
    out.col = d.startPosition.character;
  }
  const end = endPositionOf(d);
  if (end !== undefined) out.end = end;
  const width = spanWidth(d);
  if (width !== undefined) out.width = width;
  if (typeof d.code === "number") out.code = d.code;
  return out;
}

function attributesOf(d: ApiDiagnosticResponse): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (d.source !== undefined && d.source.length > 0) attributes.source = d.source;
  if (d.reportsUnnecessary !== undefined) attributes.reportsUnnecessary = d.reportsUnnecessary;
  if (d.reportsDeprecated !== undefined) attributes.reportsDeprecated = d.reportsDeprecated;
  return attributes;
}

function mapDiagnostic(d: NormalizedDiagnostic, root: string, raw: ApiDiagnosticResponse): Diagnostic {
  const out: Diagnostic = {
    file: d.fileName,
    line: d.startPosition!.line,
    col: d.startPosition!.character,
    code: d.code,
    severity: d.category === 0 ? "warning" : "error",
    message: d.text,
    messageChain: mapMessageChain(d),
    related: (d.relatedInformation ?? []).map((related) => mapRelated(related, root)),
    attributes: attributesOf(d),
    raw,
  };
  const end = endPositionOf(d);
  if (end !== undefined) out.end = end;
  const width = spanWidth(d);
  if (width !== undefined) out.width = width;
  return out;
}

function categoryName(category: number): string {
  switch (category) {
    case 0:
      return "warning";
    case 1:
      return "error";
    case 2:
      return "suggestion";
    case 3:
      return "message";
    default:
      return `category-${category}`;
  }
}

/** 与 TS7 `formatDiagnostics` 的纯文本分支同形（无 source/context/related 渲染）。 */
function fallbackFormatDiagnostics(
  diagnostics: readonly ApiDiagnosticResponse[],
  host: ApiFormatHost,
): string {
  const newLine = host.getNewLine();
  const lines = diagnostics.map((d) => {
    const message = flattenMessage(d, newLine);
    const prefix = `${categoryName(d.category)} ${d.source || "TS"}${d.code}: ${message}${newLine}`;
    if (d.fileName === undefined || d.startPosition === undefined) return prefix;
    return `${d.fileName}(${d.startPosition.line + 1},${d.startPosition.character + 1}): ${prefix}`;
  });
  return lines.join("");
}

function removeOneTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export class Ts7ApiAdapter implements Adapter {
  readonly name: string;
  readonly kind = "api" as const;
  readonly supportsOptions = true;
  private readonly moduleName: string;
  private readonly cwd: string;
  private readonly tsserverPath?: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly injectedApi?: ApiClientLike;
  private readonly apiFactory?: () => Promise<ApiClientLike>;
  private formatter?: ApiDiagnosticFormatter;
  private api: ApiClientLike | null = null;
  private initPromise: Promise<ApiClientLike> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private ownedApi = false;

  constructor(options: Ts7ApiAdapterOptions = {}) {
    this.name = options.name ?? "ts7-api";
    this.moduleName = options.moduleName ?? "typescript-7-1/async";
    this.cwd = options.cwd ?? process.cwd();
    this.tsserverPath = options.tsserverPath;
    this.extraArgs = options.extraArgs ?? DEFAULT_EXTRA_ARGS;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.closeGraceMs = options.closeGraceMs ?? 1_000;
    this.injectedApi = options.api;
    this.apiFactory = options.apiFactory;
    this.formatter = options.formatter;
  }

  async init(): Promise<void> {
    await this.ensureApi();
  }

  private async ensureApi(): Promise<ApiClientLike> {
    if (this.api !== null) return this.api;
    if (this.initPromise === null) {
      this.initPromise = (async () => {
        if (this.apiFactory !== undefined) {
          this.api = await this.apiFactory();
          this.ownedApi = true;
          return this.api;
        }
        if (this.injectedApi !== undefined) {
          this.api = this.injectedApi;
          return this.api;
        }
        const module = (await import(this.moduleName)) as {
          API?: new (options: { cwd: string; tsserverPath?: string }) => ApiClientLike;
          formatDiagnostics?: ApiDiagnosticFormatter;
        };
        if (typeof module.API !== "function") {
          throw new Error(`${this.moduleName} 没有导出 API 类`);
        }
        if (this.formatter === undefined && typeof module.formatDiagnostics === "function") {
          this.formatter = module.formatDiagnostics;
        }
        this.api = new module.API({
          cwd: this.cwd,
          ...(this.tsserverPath === undefined ? {} : { tsserverPath: this.tsserverPath }),
        });
        this.ownedApi = true;
        return this.api;
      })();
    }
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    if (this.closed) {
      return { id: input.id, status: "crash", diagnostics: [], skipReason: "TS7 API 适配器已关闭" };
    }
    // 队列等待的是实际 checkOnce，而不是带超时的返回值：某案超时后，
    // 它的 API 请求可能仍在后端执行，下一案必须等它结束，避免同一
    // API 会话上重叠 createProgram / diagnostics 请求。
    const work = this.queue.then(() => this.checkOnce(input));
    this.queue = work.then(
      () => undefined,
      () => undefined,
    );
    return this.withTimeout(work, input);
  }

  private async withTimeout(work: Promise<CaseOutcome>, input: CaseInput): Promise<CaseOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CaseOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          id: input.id,
          status: "timeout",
          diagnostics: [],
          skipReason: `TS7 API 超时（${this.timeoutMs}ms）`,
        });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async checkOnce(input: CaseInput): Promise<CaseOutcome> {
    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-ts7-api-"));
    let program: ApiProgramLike | null = null;
    try {
      const api = await this.ensureApi();
      const paths = materializeCase(tmp, input.files);
      const commandLine = [...this.extraArgs, ...input.args, ...paths];
      const unsupportedFlag = unsupportedModeFlag(commandLine);
      if (unsupportedFlag !== undefined) {
        return {
          id: input.id,
          status: "skip",
          diagnostics: [],
          skipReason: `TS7 API 不支持 ${unsupportedFlag} 模式`,
        };
      }
      const parsed = await api.parseCommandLine(commandLine);
      const host: ApiFormatHost = {
        getCurrentDirectory: () => tmp,
        getCanonicalFileName: (fileName) => api.getCanonicalFileName?.(fileName) ?? fileName,
        getNewLine: () => "\n",
      };
      const formatter = this.formatter ?? fallbackFormatDiagnostics;
      const render = (raw: NormalizedDiagnostic): string => removeOneTrailingNewline(formatter([raw], host));

      // 命令行自身错误（未知选项等）通常没有文件位置。先整体判断，避免
      // 创建 program 后把它们丢掉或误当成零诊断。
      const parseErrors = parsed.errors.filter(positioned);
      const unpositionedParseErrors = parsed.errors.filter((d) => !positioned(d));
      if (unpositionedParseErrors.length > 0) {
        return {
          id: input.id,
          status: "skip",
          diagnostics: [],
          skipReason: "TS7 API 命令行解析产生无文件位置诊断",
          message: unpositionedParseErrors.map((d) => removeOneTrailingNewline(formatter([d], host))).join("\n").slice(0, 2000),
        };
      }

      program = await api.createProgram(parsed.fileNames, rebasePathOptions(parsed.raw, tmp));
      const [programDiagnostics, globalDiagnostics, configDiagnostics, syntacticDiagnostics] = await Promise.all([
        program.getProgramDiagnostics(),
        program.getGlobalDiagnostics(),
        program.getConfigFileParsingDiagnostics?.() ?? Promise.resolve([]),
        program.getSyntacticDiagnostics(),
      ]);
      // CLI 在存在语法错误时不再继续报告语义诊断。
      let semanticDiagnostics = syntacticDiagnostics.length > 0 ? [] : await program.getSemanticDiagnostics();
      const earlyDiagnostics = [
        ...parseErrors,
        ...programDiagnostics,
        ...globalDiagnostics,
        ...configDiagnostics,
        ...syntacticDiagnostics,
      ];
      // tsc 在常规 emit（noEmit/noEmitOnError 均开启）时无条件进入声明阶段；
      // 只要 `--noEmit` 或默认的 `noEmitOnError` 可能在先验错误上阻断 emit，
      // 就要求 parse/program/global/config/syntactic/semantic 全部为空。
      const emitDeclarations = declarationRequested(parsed.raw);
      const noEmit = parsed.raw.noEmit === true;
      const noEmitOnError = parsed.raw.noEmitOnError === true;
      const declarationEligible = emitDeclarations && (
        !(noEmit || noEmitOnError) || (earlyDiagnostics.length === 0 && semanticDiagnostics.length === 0)
      );
      if (declarationEligible && typeof program.getDeclarationDiagnostics !== "function") {
        throw new Error("TS7 async API 缺少 getDeclarationDiagnostics；请使用 pinned typescript-7-1/async");
      }
      const declarationDiagnostics = declarationEligible ? await program.getDeclarationDiagnostics() : [];
      const selected = [
        ...earlyDiagnostics,
        ...semanticDiagnostics,
        ...declarationDiagnostics,
      ];

      const unpositioned = selected.filter((d) => !positioned(d));
      if (unpositioned.length > 0) {
        return {
          id: input.id,
          status: "skip",
          diagnostics: [],
          skipReason: "TS7 API 返回无文件位置的诊断",
          message: unpositioned.map((d) => removeOneTrailingNewline(formatter([d], host))).join("\n").slice(0, 2000),
        };
      }

      const unsupportedCategory = selected.find((d) => d.category !== 0 && d.category !== 1);
      if (unsupportedCategory !== undefined) {
        return {
          id: input.id,
          status: "skip",
          diagnostics: [],
          skipReason: `TS7 API 返回非 error/warning 诊断（category=${unsupportedCategory.category}）`,
          message: removeOneTrailingNewline(formatter([unsupportedCategory], host)),
        };
      }

      const cases: { mapped: NormalizedDiagnostic; original: ApiDiagnosticResponse }[] = [];
      for (const d of selected as (ApiDiagnosticResponse & { fileName: string; startPosition: ApiDiagnosticPosition })[]) {
        const file = caseRelativePath(tmp, d.fileName);
        if (file === undefined) continue; // lib / 临时目录之外的诊断，与 CLI 适配器一致
        cases.push({ mapped: { ...d, fileName: file }, original: d });
      }

      const diagnostics: Diagnostic[] = [];
      const blocks: string[] = [];
      for (const raw of cases) {
        const diagnostic = mapDiagnostic(raw.mapped, tmp, raw.original);
        const block = render(raw.mapped);
        diagnostic.fullText = block;
        diagnostics.push(diagnostic);
        blocks.push(block);
      }
      const fullText = blocks.join("\n");
      return {
        id: input.id,
        status: "ok",
        diagnostics,
        fullText,
        // API 没有逐案进程退出码；不要用诊断内容伪造 0/2。
      };
    } catch (error) {
      return {
        id: input.id,
        status: "crash",
        diagnostics: [],
        skipReason: "TS7 API 执行失败",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (program !== null) {
        try {
          await program.dispose();
        } catch {
          // dispose 失败不覆盖已有结果；API close 仍由适配器负责。
        }
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeWorker();
    return this.closePromise;
  }

  private async closeWorker(): Promise<void> {
    this.closed = true;
    const api = this.api;
    if (api === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let clearGrace!: () => void;
    const grace = new Promise<boolean>((resolve) => {
      clearGrace = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => resolve(false), this.closeGraceMs);
    });
    const settled = await Promise.race([
      this.queue.then(() => { clearGrace(); return true; }, () => { clearGrace(); return true; }),
      grace,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (settled) {
      await this.closeApi(api);
      return;
    }
    // 注入 API 可能由宿主复用，绝不推断或杀死它的子进程；保留外层
    // “有界返回 + 在途请求结束后再 close”的语义。
    if (!this.ownedApi) {
      void this.queue.then(
        () => this.closeApi(api),
        () => this.closeApi(api),
      );
      return;
    }
    // 内置 pinned ASYNC API 的子进程若被永不返回的请求卡住，只结束 stdin
    // 并终止该 API 自己的进程；unref 保证调用方无需等待后台句柄。
    const process = (api as ApiClientInternals).client?.process;
    if (process !== undefined && process !== null) {
      try {
        process.stdin?.end();
      } catch {}
      try {
        process.kill?.("SIGKILL");
      } catch {}
      try {
        process.unref?.();
      } catch {}
      this.api = null;
      return;
    }
    void this.queue.then(
      () => this.closeApi(api),
      () => this.closeApi(api),
    );
  }

  private async closeApi(api: ApiClientLike): Promise<void> {
    if (this.api !== api) return;
    this.api = null;
    try {
      await api.close();
    } catch {
      // 关闭失败已无法影响已返回的检查结果；保留完成状态，避免重复关闭。
    }
  }
}
