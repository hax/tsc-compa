// 逐案 CLI 适配器：每个用例起一次实现的命令行，解析 JSON 诊断。
//
// v0 用它驱动输出 JSON 诊断数组的检查器 CLI（固定参数 `--json`）。这种方式每案
// 付一次进程启动成本，只适合做冒烟与协议验证；正式批量口径见 adapters/batch.ts。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeCase } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome, CompilerOptions, Diagnostic } from "../types.ts";

/** `--json` 诊断数组里单条诊断的形状。 */
interface JsonDiagnostic {
  file: string;
  start: number;
  end: number;
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  severity: string;
  code: number;
  message: string;
}

export interface CliAdapterOptions {
  name: string;
  bin: string;
  /** 传给实现的固定参数，例如 ["--json"]。 */
  args?: string[];
  timeoutMs?: number;
  fixedOptions?: CompilerOptions;
  supportsOptions?: boolean;
}

export class CliAdapter implements Adapter {
  readonly name: string;
  readonly kind = "per-case" as const;
  readonly supportsOptions: boolean;
  readonly fixedOptions?: CompilerOptions;
  private readonly bin: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: CliAdapterOptions) {
    this.name = options.name;
    this.bin = options.bin;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fixedOptions = options.fixedOptions;
    this.supportsOptions = options.supportsOptions ?? false;
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-cli-"));
    try {
      const paths = materializeCase(tmp, input.files);
      const r = spawnSync(this.bin, [...this.args, ...paths], {
        cwd: tmp,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: this.timeoutMs,
      });
      if (r.error !== undefined) {
        const timeout = /ETIMEDOUT|timed out/i.test(String(r.error));
        return {
          id: input.id,
          status: timeout ? "timeout" : "crash",
          diagnostics: [],
          skipReason: timeout ? "实现超时（30s）" : "实现崩溃",
          message: String(r.error),
        };
      }
      if (r.status === null || r.status > 1) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: `实现异常退出（status=${r.status}）`,
          message: (r.stderr ?? "").slice(0, 200),
        };
      }
      const diagnostics = this.parseDiagnostics(tmp, r.stdout ?? "");
      if (diagnostics === null) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: "实现输出不是 JSON",
          message: (r.stdout ?? "").slice(0, 200),
        };
      }
      return { id: input.id, status: "ok", diagnostics };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** 解析实现输出；形状不对返回 null。 */
  private parseDiagnostics(tmp: string, stdout: string): Diagnostic[] | null {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const out: Diagnostic[] = [];
    for (const item of raw as JsonDiagnostic[]) {
      if (typeof item.file !== "string" || typeof item.code !== "number") continue;
      if (item.code === 0) continue; // 实现自己的 early error，无对应 tsc 错误码
      const rel = item.file.startsWith(`${tmp}/`) ? item.file.slice(tmp.length + 1) : item.file;
      out.push({
        file: rel,
        line: item.line - 1,
        col: item.col - 1,
        code: item.code,
        severity: item.severity === "error" ? "error" : "warning",
        width:
          typeof item.end === "number" && typeof item.start === "number"
            ? item.end - item.start
            : undefined,
        message: item.message,
      });
    }
    return out;
  }
}
