// tsc-compa 共享类型：用例、诊断、编译选项、适配器结果与协议荷载。
//
// 设计约束：本仓库不绑定任何实现。适配器可以把实现包成进程内的 API、
// 每案起一次的 CLI，或者下面协议定义的批量进程（推荐）。

export type Severity = "error" | "warning";

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
  width?: number;
  message?: string;
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
  /** 可选：实现自报的「检查耗时」（毫秒，不含进程启动/协议传输），供 --bench 的 check-only 指标使用。 */
  checkMs?: number;
}

/**
 * 适配器接口。
 *
 * - per-case：每个用例单独起进程（v0 的 maat-zig 适配器）；
 * - batch：一个进程消费多个用例，见 adapters/batch.ts 的 NDJSON 协议（推荐）；
 * - api：实现本身是 JS/TS，进程内调用。
 */
export interface Adapter {
  readonly name: string;
  readonly kind: "per-case" | "batch" | "api";
  /** false 表示实现不接受外部编译选项（例如固定 strict+esnext 的实现）。 */
  readonly supportsOptions: boolean;
  /**
   * supportsOptions=false 时实现实际采用的选项。只用于「刻意对齐」
   * 的冒烟模式（--mode fixed），这种模式的结果不能作为兼容性结论。
   */
  readonly fixedOptions?: CompilerOptions;
  init?(): Promise<void>;
  check(input: CaseInput): Promise<CaseOutcome>;
  close?(): Promise<void>;
}
