// 适配器工厂：按名字创建适配器。
//
// v0 内置：
//   tsc-cli     参考实现：直接用真实 tsc 跑逐案 CLI（TSC_COMPA_ADAPTER_TSC 覆盖二进制）
//   maat-zig    逐案 CLI（环境变量 MAAT_ZIG_BIN），固定 strict+esnext 口径
//   none        永远不报诊断（用于跑通流水线/看漏报全貌）
//   mock-batch  批量协议的参考实现（src/adapters/mock-batch.ts）
//   cli:<bin>   通用逐案 CLI（参数取 TSC_COMPA_CLI_ARGS，按空白切分）

import { join, resolve } from "node:path";
import { FIXED_STRICT_ESNEXT } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome } from "../types.ts";
import { BatchAdapter } from "./batch.ts";
import { CliAdapter } from "./cli.ts";
import { TscCliAdapter } from "./tsc-cli.ts";

class NoopAdapter implements Adapter {
  readonly name = "none";
  readonly kind = "per-case" as const;
  readonly supportsOptions = true;
  async check(input: CaseInput): Promise<CaseOutcome> {
    return { id: input.id, status: "ok", diagnostics: [] };
  }
}

export const ADAPTER_NAMES = ["tsc-cli", "maat-zig", "none", "mock-batch", "cli:<bin>"] as const;

export async function createAdapter(name: string): Promise<Adapter> {
  if (name === "tsc-cli" || name.startsWith("tsc-cli:")) {
    // `tsc-cli:<bin>` 允许一次运行里显式指定另一个 tsc（跨版本对照），
    // 缺省取 TSC_COMPA_ADAPTER_TSC，再退到期望源用的 TSC_BIN。
    const embedded = name.startsWith("tsc-cli:") ? name.slice("tsc-cli:".length) : "";
    const raw = embedded.length > 0 ? embedded : (process.env.TSC_COMPA_ADAPTER_TSC ?? process.env.TSC_BIN ?? "");
    if (raw.length === 0) {
      throw new Error("适配器 tsc-cli 需要 TSC_COMPA_ADAPTER_TSC 或 TSC_BIN 指向 tsc 可执行文件（也可写 tsc-cli:<bin>）");
    }
    // 适配器在临时目录里 spawn，带分隔符的相对路径必须先转绝对路径。
    const bin = raw.includes("/") ? resolve(raw) : raw;
    const extraArgs = (process.env.TSC_COMPA_ADAPTER_ARGS ?? "").split(/\s+/).filter((s) => s.length > 0);
    return new TscCliAdapter({ name: embedded.length > 0 ? name : "tsc-cli", bin, extraArgs });
  }
  if (name === "maat-zig") {
    const raw = process.env.MAAT_ZIG_BIN;
    if (raw === undefined || raw.length === 0) {
      throw new Error("适配器 maat-zig 需要环境变量 MAAT_ZIG_BIN 指向 maat-zig 可执行文件");
    }
    return new CliAdapter({
      name: "maat-zig",
      bin: raw.includes("/") ? resolve(raw) : raw,
      args: ["--json"],
      fixedOptions: FIXED_STRICT_ESNEXT,
      supportsOptions: false,
    });
  }
  if (name === "none") return new NoopAdapter();
  if (name === "mock-batch") {
    const adapter = new BatchAdapter({
      name: "mock-batch",
      command: process.execPath,
      args: [join(import.meta.dir, "mock-batch.ts")],
    });
    await adapter.init();
    return adapter;
  }
  if (name.startsWith("cli:")) {
    const raw = name.slice("cli:".length);
    if (raw.length === 0) throw new Error("cli:<bin> 需要给出可执行文件路径");
    const extra = (process.env.TSC_COMPA_CLI_ARGS ?? "").split(/\s+/).filter((s) => s.length > 0);
    return new CliAdapter({ name, bin: raw.includes("/") ? resolve(raw) : raw, args: extra, supportsOptions: false });
  }
  throw new Error(`未知适配器 ${name}；可用：${ADAPTER_NAMES.join(" / ")}`);
}
