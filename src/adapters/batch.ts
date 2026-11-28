// 批量适配器协议：一个进程吃多个用例，NDJSON（每行一个 JSON）双向流。
//
// 设计目标：把「每案一次进程启动」的固定成本摊掉，和官方 runner 在单进程内
// createProgram 的思路对齐，同时对实现语言中立（任何语言写个 shim 即可）。
//
// 线上的每一行都是一个 JSON 对象。
//
// 请求（客户端 → 实现）：
//   {"protocol":1,"type":"check","id":"<唯一 id>","files":[{"path":"a.ts","text":"..."}],
//    "options":[{"name":"strict","value":true}],"args":["--strict","true"]}
//   {"protocol":1,"type":"shutdown"}
//
// 响应（实现 → 客户端）：
//   {"protocol":1,"type":"result","id":"<同一 id>","status":"ok",
//    "diagnostics":[{"file":"a.ts","line":0,"col":4,"code":2322,"severity":"error",
//                    "width":3,"messageChain":null,"related":[],"attributes":{},
//                    "fullText":"a.ts(1,5): error TS2322: ..."}],
//    "fullText":"a.ts(1,5): error TS2322: ...","exitCode":2,"checkMs":12}
//   {"protocol":1,"type":"result","id":"...","status":"skip","skipReason":"@jsx"}
//   {"protocol":1,"type":"result","id":"...","status":"crash","message":"..."}
//   {"protocol":1,"type":"hello","implementation":{"name":"checker","version":"..."}}
// checker-batch 可以在 hello 或第一条有效的配对结果中被动声明 capabilities；
// 声明字段可放顶层或 capabilities 对象。不发送探测帧。在协商模式下，
// 只有 skip/error 搭配认可的选项拒绝码才是结构化拒绝。
//
// 约定：行列 0-based（shim 负责把实现自己的 1-based 位置换算过来）；诊断文件
// 路径用请求里的 file.path；severity 缺省 error。一行只对应一个用例。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Adapter, AdapterCapabilities, CaseInput, CaseOutcome, CompilerOptions, Diagnostic, OptionNegotiation, OptionValue } from "../types.ts";
import { isOptionValue, object, preflight, readCapabilities, rejectionKind, sameCapabilities, workerRejection } from "./batch-options.ts";

export interface BatchRequest {
  protocol: 1;
  type: "check" | "shutdown";
  id?: string;
  files?: { path: string; text: string }[];
  options?: CompilerOptions;
  args?: string[];
}

export interface BatchResultMessage {
  protocol: 1;
  type: "result";
  id: string;
  status: "ok" | "skip" | "crash" | "timeout" | "error";
  errorCode?: string;
  option?: { name: string; value?: OptionValue };
  capabilities?: AdapterCapabilities;
  diagnostics?: Diagnostic[];
  skipReason?: string;
  message?: string;
  /** 完整诊断输出流；空串 = 明确无诊断，缺省 = 未提供。 */
  fullText?: string;
  /** 实现原始退出码；null = 无退出码。 */
  exitCode?: number | null;
  /** 检查阶段耗时（毫秒）。 */
  checkMs?: number;
  /** 原始过程输出；仅留存，不参与比较。 */
  rawOutput?: { stdout?: string; stderr?: string };
}

export interface BatchHelloMessage {
  protocol: 1;
  type: "hello";
  implementation?: { name?: string; version?: string };
  capabilities?: AdapterCapabilities;
}

export interface BatchAdapterOptions {
  name: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  /**
   * 非协商模式的旧默认值；协商模式忽略它，读取已冻结的能力。
   */
  supportsOptions?: boolean;
  /** Enable passive v1 negotiation for checker-batch; does not grant gate trust. */
  negotiateOptions?: boolean;
  /** supportsOptions=false 时实现实际采用的选项（用于 --mode fixed）。 */
  fixedOptions?: CompilerOptions;
  /** hello 消息里的实现名（若实现发送了 hello）。 */
  onHello?: (impl: { name?: string; version?: string }) => void;
}

const uint = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const stringOrAbsent = (v: unknown) => v === undefined || typeof v === "string";
const displayField = (v: unknown) => v === undefined || (typeof v === "string" && v.trim().length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v));
const position = (v: unknown) => v === undefined || (object(v) && uint(v.line) && uint(v.col));
function chain(v: unknown, depth = 0): boolean {
  return v == null || (depth < 64 && object(v) && typeof v.text === "string" && (v.code === undefined || uint(v.code)) &&
    (v.category === undefined || uint(v.category)) && (v.attributes === undefined || object(v.attributes)) &&
    (v.children === undefined || (Array.isArray(v.children) && v.children.every(child => child != null && chain(child, depth + 1)))));
}
function diagnostic(value: unknown, negotiated: boolean): boolean {
  if (!object(value) || typeof value.file !== "string" || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.col) ||
      !Number.isSafeInteger(value.code) || (value.severity !== undefined && value.severity !== "error" && value.severity !== "warning")) return false;
  if (!negotiated) return true;
  return value.file.length > 0 && uint(value.line) && uint(value.col) && uint(value.code) && value.code !== 0 &&
    (value.width === undefined || uint(value.width)) && position(value.end) && stringOrAbsent(value.message) && stringOrAbsent(value.fullText) &&
    (value.attributes === undefined || object(value.attributes)) && chain(value.messageChain) &&
    (value.related === undefined || (Array.isArray(value.related) && value.related.every(r => object(r) && typeof r.message === "string" &&
      stringOrAbsent(r.file) && [r.line, r.col, r.width, r.code, r.category].every(v => v === undefined || uint(v)) && position(r.end) &&
      (r.attributes === undefined || object(r.attributes)) && chain(r.messageChain))));
}
function validResult(row: Record<string, unknown>, negotiate: boolean, strictFields: boolean): boolean {
  if (!(typeof row.status === "string" && ["ok", "skip", "crash", "timeout"].includes(row.status)) && !(negotiate && row.status === "error")) return false;
  if (row.status === "ok" && !Array.isArray(row.diagnostics)) return false;
  if (row.diagnostics !== undefined && (!Array.isArray(row.diagnostics) || !row.diagnostics.every(d => diagnostic(d, strictFields)))) return false;
  if (!negotiate) return true;
  if (strictFields && (![row.skipReason, row.message, row.fullText].every(stringOrAbsent) ||
      (row.exitCode != null && !Number.isSafeInteger(row.exitCode)) ||
      (row.checkMs !== undefined && (typeof row.checkMs !== "number" || !Number.isFinite(row.checkMs) || row.checkMs < 0)) ||
      (row.rawOutput !== undefined && (!object(row.rawOutput) || typeof row.rawOutput.stdout !== "string" || typeof row.rawOutput.stderr !== "string")))) return false;
  return stringOrAbsent(row.errorCode) &&
    (row.option === undefined || (object(row.option) && typeof row.option.name === "string" && /^[a-z][a-z0-9]*$/i.test(row.option.name) &&
      (row.option.value === undefined || isOptionValue(row.option.value))));
}

interface Pending {
  input: CaseInput;
  deadline: number;
  resolve: (outcome: CaseOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BatchAdapter implements Adapter {
  readonly name: string;
  readonly kind = "batch" as const;
  private readonly fallbackSupportsOptions: boolean;
  get supportsOptions(): boolean {
    return this.negotiateOptions ? this.negotiation === "negotiated" && this.negotiatedCapabilities?.supportsOptions === true
      : this.fallbackSupportsOptions;
  }
  readonly fixedOptions?: CompilerOptions;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly negotiateOptions: boolean;
  private negotiation: OptionNegotiation = "legacy";
  private negotiatedCapabilities?: AdapterCapabilities;
  private implementation?: Readonly<{ name?: string; version?: string }>;
  private protocolError?: string;
  private checkQueue = Promise.resolve();
  get optionNegotiation(): OptionNegotiation | undefined { return this.negotiateOptions ? this.negotiation : undefined; }
  get capabilities(): AdapterCapabilities | undefined { return this.negotiatedCapabilities; }
  get batchImplementation(): Readonly<{ name?: string; version?: string }> | undefined { return this.implementation; }
  private readonly onHello?: BatchAdapterOptions["onHello"];
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private exited: Promise<void> | null = null;
  private failed = false;
  private closing = false;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private stderrBuf = "";

  constructor(options: BatchAdapterOptions) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.negotiateOptions = options.negotiateOptions ?? false;
    this.negotiation = this.negotiateOptions ? "pending" : "legacy";
    this.fallbackSupportsOptions = options.supportsOptions ?? true;
    this.fixedOptions = options.fixedOptions;
    this.onHello = options.onHello;
  }

  async init(): Promise<void> {
    if (this.proc !== null) return;
    this.failed = false;
    this.negotiation = this.negotiateOptions ? "pending" : "legacy";
    this.negotiatedCapabilities = undefined;
    this.implementation = undefined;
    this.protocolError = undefined;
    this.stderrBuf = "";
    const proc = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString()).slice(-2000);
    });
    this.rl = createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    const fail = (why: string, exitCode: number | null): void => {
      this.failed = true;
      if (this.negotiateOptions && !this.closing) this.negotiation = "failed";
      for (const [id, item] of this.pending) {
        clearTimeout(item.timer);
        item.resolve({ id, status: "crash", diagnostics: [], skipReason: "实现进程退出", message: why, exitCode });
      }
      this.pending.clear();
    };
    this.exited = new Promise<void>((resolve) => {
      // close follows stdio drain and also fires after a spawn error. Store the
      // promise now, so close() after an already-exited child cannot miss it.
      proc.once("close", (code, signal) => {
        fail(`批量适配器退出（code=${code} signal=${signal}）：${this.stderrBuf.slice(-200)}`, code);
        resolve();
      });
    });
    proc.on("error", (error) => fail(error.message, null));
    proc.stdin.on("error", (error) => fail(error.message, null));
  }

  check(input: CaseInput): Promise<CaseOutcome> {
    // The first real request is the only in-flight request while negotiating.
    // Keep negotiated peers serial too; legacy/mock BatchAdapter callers retain pipelining.
    if (!this.negotiateOptions) return this.checkOne(input);
    const request = structuredClone(input);
    const result = this.checkQueue.then(() => this.checkOne(request));
    this.checkQueue = result.then(() => {}, () => {});
    return result;
  }

  private async checkOne(input: CaseInput): Promise<CaseOutcome> {
    if (this.proc === null) await this.init();
    const proc = this.proc;
    if (proc === null || this.failed || this.closing || proc.stdin.destroyed) {
      return { id: input.id, status: "crash", diagnostics: [], skipReason: "实现进程不可用" };
    }
    if (this.protocolError !== undefined) return this.invalidResult(input.id, this.protocolError);
    if (this.negotiation === "negotiated" && this.negotiatedCapabilities) {
      const rejection = preflight(input, this.negotiatedCapabilities, "preflight");
      if (rejection) return this.rejected(input.id, rejection);
    }
    const id = `${this.seq++}:${input.id}`;
    const request: BatchRequest = {
      protocol: 1,
      type: "check",
      id,
      files: input.files,
      options: input.options,
      args: input.args,
    };
    const outcome = new Promise<CaseOutcome>((resolve) => {
      const deadline = performance.now() + this.timeoutMs;
      const timer = setTimeout(() => this.expire(id), this.timeoutMs);
      this.pending.set(id, { input, deadline, resolve, timer });
    });
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    const result = await outcome;
    return { ...result, id: input.id };
  }

  private expire(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.finishTimeout(pending);
  }

  private finishTimeout(pending: Pending): void {
    if (this.negotiation === "pending") this.negotiation = "failed";
    pending.resolve({ id: pending.input.id, status: "timeout", diagnostics: [],
      skipReason: "实现超时", message: `批量适配器 ${this.timeoutMs}ms 未应答` });
  }

  private invalidResult(id: string, reason: string): CaseOutcome {
    return { id, status: "crash", diagnostics: [], skipReason: reason };
  }

  private rejected(id: string, optionRejection: NonNullable<CaseOutcome["optionRejection"]>): CaseOutcome {
    return { id, status: "skip", diagnostics: [], skipReason: optionRejection.reason, optionRejection };
  }

  /** Treat malformed/conflicting declarations as protocol failures, not legacy. */
  private failNegotiation(reason: string): void {
    this.negotiation = "failed";
    this.protocolError = reason;
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.resolve(this.invalidResult(id, reason));
    }
    this.pending.clear();
  }

  private acceptDeclaration(caps: AdapterCapabilities | null): boolean {
    if (caps === null) return true;
    if (this.negotiation === "pending") {
      this.negotiatedCapabilities = caps;
      this.negotiation = "negotiated";
      return true;
    }
    return this.negotiation === "negotiated" && this.negotiatedCapabilities !== undefined && sameCapabilities(this.negotiatedCapabilities, caps);
  }

  private handleHello(row: Record<string, unknown>): void {
    const impl = row.implementation === undefined ? {} : row.implementation;
    if (!object(impl) || !displayField(impl.name) || !displayField(impl.version)) {
      if (this.negotiateOptions) this.failNegotiation("批量适配器的 hello 实现信息无效");
      return;
    }
    const implementation = { ...(typeof impl.name === "string" && { name: impl.name }), ...(typeof impl.version === "string" && { version: impl.version }) };
    if (!this.negotiateOptions) { this.onHello?.(implementation); return; }
    // A timed-out first case must not be upgraded by a late hello either.
    const firstPending = this.negotiation === "pending" ? this.pending.keys().next().value : undefined;
    if (firstPending !== undefined && performance.now() >= this.pending.get(firstPending)!.deadline) this.expire(firstPending);
    if (this.negotiation === "failed") return;
    const caps = readCapabilities(row);
    if (caps === undefined || !this.acceptDeclaration(caps)) {
      this.failNegotiation("批量适配器的能力声明无效、迟到或与会话声明冲突");
      return;
    }
    if (this.implementation === undefined) this.implementation = Object.freeze(implementation);
    this.onHello?.(implementation);
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0 || this.failed || this.closing) return;
    let row: unknown;
    try { row = JSON.parse(line); } catch {
      this.stderrBuf = `${this.stderrBuf}\n非 JSON 行: ${line.slice(0, 200)}`.slice(-2000);
      return;
    }
    if (!object(row) || row.protocol !== 1) return;
    if (row.type === "hello") { this.handleHello(row); return; }
    if (row.type !== "result" || typeof row.id !== "string") return;
    const pending = this.pending.get(row.id);
    if (!pending) return;
    if (performance.now() >= pending.deadline) { this.expire(row.id); return; }
    this.pending.delete(row.id);
    clearTimeout(pending.timer);
    const invalid = (reason: string) => {
      if (this.negotiateOptions) this.failNegotiation(reason);
      pending.resolve(this.invalidResult(pending.input.id, reason));
    };
    const hasDeclaration = ["capabilities", "supportsOptions", "supportedOptions", "responseFields"].some(key => Object.hasOwn(row, key));
    const strictFields = hasDeclaration || this.negotiatedCapabilities !== undefined || Object.hasOwn(row, "errorCode");
    if (!validResult(row, this.negotiateOptions, this.negotiateOptions && strictFields)) { invalid("批量适配器的诊断响应无效"); return; }
    const msg = row as unknown as BatchResultMessage;
    const code = this.negotiateOptions ? rejectionKind(msg.errorCode) : undefined;
    if (this.negotiateOptions && ((msg.errorCode !== undefined && (!code || (msg.status !== "skip" && msg.status !== "error"))) ||
        (msg.status === "error" && !code) || (msg.option !== undefined && !code) ||
        (code && ((msg.diagnostics?.length ?? 0) !== 0 || (msg.fullText !== undefined && msg.fullText !== ""))))) {
      invalid("批量适配器的错误码与响应状态不匹配"); return;
    }
    const canDeclare = msg.status === "ok" || msg.status === "skip" || msg.status === "error";
    const caps = this.negotiateOptions && canDeclare ? readCapabilities(row) : null;
    if (caps === undefined || (caps !== null && this.negotiation !== "pending" &&
        (this.negotiation !== "negotiated" || !this.negotiatedCapabilities || !sameCapabilities(this.negotiatedCapabilities, caps)))) {
      const reason = "批量适配器的能力声明无效、迟到或与会话声明冲突";
      invalid(reason); return;
    }
    const effectiveCaps = this.negotiatedCapabilities ?? caps ?? undefined;
    const rejection = code && (msg.status === "skip" || msg.status === "error")
      ? workerRejection(pending.input, effectiveCaps, msg.errorCode!, msg.skipReason ?? msg.message ?? "实现拒绝编译选项", msg.option) : undefined;
    if (code && !rejection) { invalid("批量适配器的选项拒绝与本次请求不匹配"); return; }
    if (this.negotiateOptions && effectiveCaps?.supportsOptions && msg.status === "ok" && msg.diagnostics?.some(d =>
      d.severity === undefined || !pending.input.files.some(file => file.path === d.file))) {
      invalid("协商模式的诊断未提供 severity，或文件不属于本次请求"); return;
    }
    if (performance.now() >= pending.deadline) { this.finishTimeout(pending); return; }
    if (this.negotiateOptions && this.negotiation === "pending") {
      if (!canDeclare) this.negotiation = "failed";
      else if (caps === null) this.negotiation = "legacy";
      else this.acceptDeclaration(caps);
    }
    if (rejection) { pending.resolve(this.rejected(pending.input.id, rejection)); return; }
    if (msg.status === "ok" && this.negotiation === "negotiated" && effectiveCaps) {
      const unchecked = preflight(pending.input, effectiveCaps, "unchecked-result");
      if (unchecked) { pending.resolve(this.rejected(pending.input.id, unchecked)); return; }
    }
    const parsed: Diagnostic[] = (msg.diagnostics ?? []).map(d => ({ ...d, severity: d.severity ?? "error" }));
    pending.resolve({
      id: msg.id,
      status: msg.status === "error" ? "crash" : msg.status,
      diagnostics: parsed,
      ...(msg.skipReason !== undefined && { skipReason: msg.skipReason }),
      ...(msg.message !== undefined && { message: msg.message }),
      ...(msg.fullText !== undefined && { fullText: msg.fullText }),
      ...(msg.exitCode !== undefined && { exitCode: msg.exitCode }),
      ...(msg.checkMs !== undefined && { checkMs: msg.checkMs }),
      ...(msg.rawOutput !== undefined && { rawOutput: msg.rawOutput }),
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === null) return;
    this.closing = true;
    const exited = this.exited;
    this.exited = null;
    try {
      if (!this.failed && !proc.stdin.destroyed) {
        proc.stdin.end(`${JSON.stringify({ protocol: 1, type: "shutdown" })}\n`);
      }
      const kill = setTimeout(() => proc.kill("SIGKILL"), 1000);
      try { await exited; } finally { clearTimeout(kill); }
    } finally {
      this.proc = null;
      this.closing = false;
      this.rl?.close();
      this.rl = null;
    }
  }
}
