// 被测检查器的逐案 CLI 适配器：把检查器 `--json` 的诊断映射成套件协议。
//
// 此处的「协议差异」：
//   - 检查器输出 1-based 行列与字节偏移（start/end），套件要 0-based 行列 + 宽度；
//   - code === 0 是实现自己的 early error（不对应 tsc 错误码），跳过；
//   - 文件路径是按绝对路径传进去的，需要相对用例临时目录。
//
// 这是逐案进程模式（每案一次 spawn），只适合冒烟；全量口径用批量协议
// （checker-batch，协议见 adapters/batch.ts）。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_STRICT_ESNEXT, materializeCase } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome, Diagnostic } from "../types.ts";

interface CheckerJsonDiagnostic {
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

export interface CheckerCliAdapterOptions {
  name?: string;
  bin: string;
  timeoutMs?: number;
}

export class CheckerCliAdapter implements Adapter {
  readonly name: string;
  readonly kind = "per-case" as const;
  /** 检查器不接受逐用例外部选项；fixed 口径用套件内固定 strict+esnext。 */
  readonly supportsOptions = false;
  readonly fixedOptions = FIXED_STRICT_ESNEXT;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: CheckerCliAdapterOptions) {
    this.name = options.name ?? "checker-cli";
    this.bin = options.bin;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-checker-"));
    try {
      const paths = materializeCase(tmp, input.files);
      const r = spawnSync(this.bin, ["--json", ...paths], {
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
          skipReason: timeout ? "检查器超时（30s）" : "检查器崩溃",
          message: String(r.error),
        };
      }
      // 检查器在有诊断时退出码为 1；>1 视为崩溃。
      if (r.status === null || r.status > 1) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: `检查器异常退出（status=${r.status}）`,
          message: (r.stderr ?? "").slice(0, 200),
        };
      }
      const diagnostics = this.parseDiagnostics(tmp, r.stdout ?? "");
      if (diagnostics === null) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: "检查器输出不是 JSON",
          message: (r.stdout ?? "").slice(0, 200),
        };
      }
      return { id: input.id, status: "ok", diagnostics };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** 解析检查器 --json 输出；形状不对返回 null。 */
  private parseDiagnostics(tmp: string, stdout: string): Diagnostic[] | null {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const out: Diagnostic[] = [];
    for (const item of raw as CheckerJsonDiagnostic[]) {
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
