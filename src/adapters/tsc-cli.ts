// 参考实现适配器：直接用真实 tsc 命令行跑用例。
//
// 用途：验证 harness 自身正确性——期望源与适配器用同一个 tsc 时，指标应当
// 接近「覆盖 100%、假阳性 0、错锚 0」。它也是「任意 TSC 兼容实现」协议的一个
// 活样例：适配器只负责把实现的输出翻译成 Diagnostic[]。
//
// 与 tsc.ts 生成期望的路径保持同一解析规则（同一条 CLI_DIAG 正则、同样按
// cwd 解析相对路径、同样忽略临时目录外的 lib 诊断），否则自比会出现假差异。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { materializeCase } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome, Diagnostic } from "../types.ts";

const CLI_DIAG = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s?(.*)$/;

/** 解析 tsc `--pretty false` 输出；临时目录之外的文件（lib 等）不计。 */
export function parseTscOutput(tmp: string, text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = CLI_DIAG.exec(line);
    if (m === null) continue;
    const abs = resolve(tmp, m[1]!);
    const rel = abs.startsWith(`${tmp}/`) ? abs.slice(tmp.length + 1) : null;
    if (rel === null) continue;
    out.push({
      file: rel,
      line: Number(m[2]) - 1,
      col: Number(m[3]) - 1,
      code: Number(m[5]),
      severity: m[4] === "warning" ? "warning" : "error",
      message: m[6] ?? undefined,
    });
  }
  return out;
}

export interface TscCliAdapterOptions {
  name?: string;
  /** tsc 可执行文件路径。 */
  bin: string;
  timeoutMs?: number;
}

export class TscCliAdapter implements Adapter {
  readonly name: string;
  readonly kind = "per-case" as const;
  /** tsc 接受任意编译选项，因此 official 模式下的结果是可比的。 */
  readonly supportsOptions = true;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: TscCliAdapterOptions) {
    this.name = options.name ?? "tsc-cli";
    this.bin = options.bin;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async check(input: CaseInput): Promise<CaseOutcome> {
    const tmp = mkdtempSync(join(tmpdir(), "tsc-compa-tsc-"));
    try {
      const paths = materializeCase(tmp, input.files);
      const r = spawnSync(this.bin, [...input.args, ...paths], {
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
      // tsc 的退出码：0 无错、2 有诊断；其余异常一律当 crash，避免把环境
      // 问题误算成兼容性差异。
      if (r.status === null || r.status > 2) {
        return {
          id: input.id,
          status: "crash",
          diagnostics: [],
          skipReason: `实现异常退出（status=${r.status}）`,
          message: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(0, 200),
        };
      }
      return {
        id: input.id,
        status: "ok",
        diagnostics: parseTscOutput(tmp, `${r.stdout ?? ""}${r.stderr ?? ""}`),
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
