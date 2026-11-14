// maat 原生二进制的逐案适配器：把 maat 的 --json 诊断映射成套件协议。
//
// 此处的“协议差异”：
//   - maat 输出 1-based 行列与字节偏移（start/end），套件要 0-based 行列 + 宽度；
//   - code === 0 是 yuku early error（不对应 tsc 码），跳过；
//   - 文件路径是按绝对路径传进去的，需要相对用例临时目录。
//
// 这是逐案进程模式（每案一次 spawn），只适合冒烟；全量口径等批量协议（maat issue #8）。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_STRICT_ESNEXT, materializeCase } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome, Diagnostic } from "../types.ts";

interface MaatJsonDiagnostic {
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

export interface MaatAdapterOptions {
  name?: string;
  bin: string;
  timeoutMs?: number;
}

export class MaatAdapter implements Adapter {
  readonly name: string;
  readonly kind = "per-case" as const;
  /** maat 不接受逐用例外部选项；fixed 口径用套件内固定 strict+esnext。 */
  readonly supportsOptions = false;
  readonly fixedOptions = FIXED_STRICT_ESNEXT;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: MaatAdapterOptions) {
    this.name = options.name ?? "maat";
    this.bin = options.bin;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-maat-"));
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
          skipReason: timeout ? "maat 超时（30s）" : "maat 崩溃",
          message: String(r.error),
        };
      }
      // maat 在有诊断时退出码为 1；>1 视为崩溃。
      if (r.status === null || r.status > 1) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: `maat 异常退出（status=${r.status}）`,
          message: (r.stderr ?? "").slice(0, 200),
        };
      }
      const diagnostics = this.parseDiagnostics(tmp, r.stdout ?? "");
      if (diagnostics === null) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: "maat 输出不是 JSON",
          message: (r.stdout ?? "").slice(0, 200),
        };
      }
      return { id: input.id, status: "ok", diagnostics };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** 解析 maat --json 输出；形状不对返回 null。 */
  private parseDiagnostics(tmp: string, stdout: string): Diagnostic[] | null {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const out: Diagnostic[] = [];
    for (const item of raw as MaatJsonDiagnostic[]) {
      if (typeof item.file !== "string" || typeof item.code !== "number") continue;
      if (item.code === 0) continue; // yuku early error，无对应 tsc 码
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
