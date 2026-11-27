// tsc-compa 共享类型：用例、诊断、编译选项、适配器结果与协议荷载。
//
// 设计约束：本仓库不绑定任何实现。适配器可以把实现包成进程内的 API、
// 每案起一次的 CLI，或者下面协议定义的批量进程（推荐）。

export type Severity = "error" | "warning";

export interface DiagnosticPosition { line: number; col: number }

export interface MessageChain {
  text: string;
  children?: MessageChain[];
  code?: number;
  category?: number;
  attributes?: Record<string, unknown>;
}

export interface RelatedDiagnostic {
  file?: string;
  line?: number;
  col?: number;
  width?: number;
  end?: DiagnosticPosition;
  code?: number;
  category?: number;
  message: string;
  messageChain?: MessageChain | null;
  attributes?: Record<string, unknown>;
  raw?: unknown;
}

/**
 * 诊断。位置是「用例内相对路径 + 0-based 行列」；宽度只有部分实现给得出
 * （tsc CLI 不给），比较时宽度缺失即跳过宽度比较。message 为可选。
 */
export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  code: number;
  severity: Severity;
  /**
   * 主诊断的标记跨度，单位与 col 相同（UTF-16 code unit）。CLI 文本没有范围时
   * 不填；不能用 end - start 之外的字节偏移冒充。
   */
  width?: number;
  /** 0-based UTF-16 position, including spans crossing line boundaries. */
  end?: DiagnosticPosition;
  message?: string;
  /** 结构化消息链。undefined = 接口未提供；null = 明确无链。 */
  messageChain?: MessageChain | null;
  /** 结构化 related info，顺序保留。undefined = 未提供；[] = 明确为空。 */
  related?: RelatedDiagnostic[];
  /** 实现返回的其他结构化属性（source、reportsUnnecessary 等）。未提供为 undefined。 */
  attributes?: Record<string, unknown>;
  /** 实现原始诊断对象（仅留存诊断采集问题，不参与比较）。 */
  raw?: unknown;
  /**
   * 该诊断的完整文本块（首行 + 缩进阐述/related 续行），换行归一为 LF，
   * 不包含空行、计时或调试日志。undefined = 未提供；空串只用于显式空块。
   * 严格比较的「完整诊断输出」使用完整诊断流，见 CaseOutcome.fullText。
   */
  fullText?: string;
}

/** 用例里的一个虚拟文件。 */
export interface CaseFile {
  path: string;
  text: string;
}

export type OptionValue = boolean | string | string[];

/**
 * 一条编译选项。name 用 tsc 的 canonical 拼写（如 strictNullChecks），
 * 便于适配器把它翻译成自己的接受方式。
 */
export interface CompilerOption {
  name: string;
  value: OptionValue;
}

export type CompilerOptions = CompilerOption[];

/** 交给适配器的一个用例。 */
export interface CaseInput {
  /** 用例在语料内的相对路径（`tests/cases/` 之后的部分）。 */
  id: string;
  files: CaseFile[];
  /** 有效编译选项：case 指令按官方语义覆盖默认值之后的结果。 */
  options: CompilerOptions;
  /** 由 options 归一出的 tsc 风格命令行参数（不含文件路径）。 */
  args: string[];
}

export type OutcomeStatus = "ok" | "skip" | "crash" | "timeout";

/** 适配器对一个用例的答复。非 ok 状态按 SKIP 分类统计，不进入兼容性分母。 */
export interface CaseOutcome {
  id: string;
  status: OutcomeStatus;
  diagnostics: Diagnostic[];
  skipReason?: string;
  message?: string;
  /**
   * 完整诊断输出流（严格比较的 output 字段）：
   * - 与 official `.errors.txt` 摘要区同口径：按输出顺序拼接每条诊断的
   *   首行（用例内相对路径 + 1-based 行列 + severity + TS码 + message）和
   *   该诊断的缩进续行；
   * - 只含诊断摘要，不含 `====` 后的源码标注、空行、--extendedDiagnostics
   *   计时或其他调试日志；
   * - 行尾统一 LF，行内空白/续行顺序原样；
   * - `""` = 已成功取得输出且明确没有诊断；`undefined` = 未提供，不能当作空。
   *
   * 非 pretty CLI 的解析结果符合此契约；official-baseline 的完整文件包含
   * 源码标注，只提供摘要子串（`summaryBlockOf`），标注部分不可得。
   */
  fullText?: string;
  /** 进程原始退出码；null = 进程被信号终止/没有退出码；undefined = 未采集。 */
  exitCode?: number | null;
  /**
   * 实现自报的检查耗时（毫秒，可选）：性能附录的 Check 相位口径。
   * 只有能给出 `--extendedDiagnostics` 类相位数据的适配器才填；
   * 缺失时性能附录退回 wall − 空程序基线的降级口径。
   */
  checkMs?: number;
  /** 实现原始输出的可保留附件（stdout/stderr），用于诊断采集问题，不参与比较。 */
  rawOutput?: { stdout?: string; stderr?: string };
}

export interface ToolIdentity {
  path: string;
  version: string | null;
  sha256: string | null;
  native?: { path: string; sha256: string | null };
  embeddedTypeScript?: string;
  sdk?: { module: string; path: string; version: string; sha256: string };
}

/**
 * 适配器接口。
 *
 * - per-case：每个用例单独起进程（v0 的逐案 CLI 适配器）；
 * - batch：一个进程消费多个用例，见 adapters/batch.ts 的 NDJSON 协议（推荐）；
 * - api：实现本身是 JS/TS，进程内调用。
 */
export interface Adapter {
  readonly name: string;
  readonly kind: "per-case" | "batch" | "api";
  /** false 表示实现不接受外部编译选项（例如固定 strict+esnext 的实现）。 */
  readonly supportsOptions: boolean;
  /** 适配器自行选择后端时，提供与启动参数相同的工具来源。 */
  readonly toolIdentity?: ToolIdentity;
  /**
   * supportsOptions=false 时实现实际采用的选项。只用于「刻意对齐」
   * 的冒烟模式（--mode fixed），这种模式的结果不能作为兼容性结论。
   */
  readonly fixedOptions?: CompilerOptions;
  init?(): Promise<void>;
  check(input: CaseInput): Promise<CaseOutcome>;
  close?(): Promise<void>;
}
