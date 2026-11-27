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
//
// 约定：行列 0-based（shim 负责把实现自己的 1-based 位置换算过来）；诊断文件
// 路径用请求里的 file.path；severity 缺省 error。一行只对应一个用例。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Adapter, CaseInput, CaseOutcome, CompilerOptions, Diagnostic } from "../types.ts";

export interface BatchRequest {
  protocol: 1;
  type: "check" | "shutdown";
  id?: string;
  files?: { path: string; text: string }[];
  options?: unknown;
  args?: string[];
}

export interface BatchResultMessage {
  protocol: 1;
  type: "result";
  id: string;
  status: "ok" | "skip" | "crash" | "timeout";
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
}

export interface BatchAdapterOptions {
  name: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  /**
   * 实现是否接受 per-case 编译选项。缺省 true（协议本来就能带 options）；
   * 只支持固定口径的实现应显式设 false，配合 fixedOptions 使用。
   */
  supportsOptions?: boolean;
  /** supportsOptions=false 时实现实际采用的选项（用于 --mode fixed）。 */
  fixedOptions?: CompilerOptions;
  /** hello 消息里的实现名（若实现发送了 hello）。 */
  onHello?: (impl: { name?: string; version?: string }) => void;
}

interface Pending {
  resolve: (outcome: CaseOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BatchAdapter implements Adapter {
  readonly name: string;
  readonly kind = "batch" as const;
  readonly supportsOptions: boolean;
  readonly fixedOptions?: CompilerOptions;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly onHello?: BatchAdapterOptions["onHello"];
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private exited: Promise<void> | null = null;
  private failed = false;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private stderrBuf = "";

  constructor(options: BatchAdapterOptions) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.supportsOptions = options.supportsOptions ?? true;
    this.fixedOptions = options.fixedOptions;
    this.onHello = options.onHello;
  }

  async init(): Promise<void> {
    if (this.proc !== null) return;
    this.failed = false;
    const proc = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString()).slice(-2000);
    });
    this.rl = createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    const fail = (why: string, exitCode: number | null): void => {
      this.failed = true;
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

  async check(input: CaseInput): Promise<CaseOutcome> {
    if (this.proc === null) await this.init();
    const proc = this.proc;
    if (proc === null || this.failed || proc.stdin.destroyed) {
      return { id: input.id, status: "crash", diagnostics: [], skipReason: "实现进程不可用" };
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          id: input.id,
          status: "timeout",
          diagnostics: [],
          skipReason: "实现超时",
          message: `批量适配器 ${this.timeoutMs}ms 未应答`,
        });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    const result = await outcome;
    return { ...result, id: input.id };
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let msg: BatchResultMessage | BatchHelloMessage;
    try {
      msg = JSON.parse(line) as BatchResultMessage | BatchHelloMessage;
    } catch {
      this.stderrBuf = `${this.stderrBuf}\n非 JSON 行: ${line.slice(0, 200)}`;
      return;
    }
    if (msg === null || typeof msg !== "object" || msg.protocol !== 1) return;
    if (msg.type === "hello") {
      this.onHello?.(msg.implementation ?? {});
      return;
    }
    if (msg.type !== "result" || typeof msg.id !== "string") return;
    const pending = this.pending.get(msg.id);
    if (pending === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    const statusValid = msg.status === "ok" || msg.status === "skip" || msg.status === "crash" || msg.status === "timeout";
    const diagnostics = msg.diagnostics;
    if (!statusValid || (msg.status === "ok" && !Array.isArray(diagnostics)) ||
        (diagnostics !== undefined && (!Array.isArray(diagnostics) || diagnostics.some((d) =>
          d === null || typeof d !== "object" || typeof d.file !== "string" ||
          !Number.isSafeInteger(d.line) || !Number.isSafeInteger(d.col) || !Number.isSafeInteger(d.code) ||
          (d.severity !== undefined && d.severity !== "error" && d.severity !== "warning"))))) {
      pending.resolve({ id: msg.id, status: "crash", diagnostics: [], skipReason: "批量适配器的诊断响应无效" });
      return;
    }
    const parsed: Diagnostic[] = (diagnostics ?? []).map((d) => ({ ...d, severity: d.severity ?? "error" }));
    pending.resolve({
      id: msg.id,
      status: msg.status,
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
    this.proc = null;
    const exited = this.exited;
    this.exited = null;
    try {
      if (!this.failed && !proc.stdin.destroyed) {
        proc.stdin.end(`${JSON.stringify({ protocol: 1, type: "shutdown" })}\n`);
      }
      const kill = setTimeout(() => proc.kill("SIGKILL"), 1000);
      try { await exited; } finally { clearTimeout(kill); }
    } finally {
      this.rl?.close();
      this.rl = null;
    }

  }
}
