// 适配器工厂：按名字创建适配器。
//
// v0 内置：
//   maat-zig    逐案 CLI（环境变量 MAAT_ZIG_BIN），固定 strict+esnext 口径
//   none        永远不报诊断（用于跑通流水线/看漏报全貌）
//   mock-batch  批量协议的参考实现（src/adapters/mock-batch.ts）
//   cli:<bin>   通用逐案 CLI（参数取 TSC_COMPA_CLI_ARGS，按空白切分）

import { join } from "node:path";
import { FIXED_STRICT_ESNEXT } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome } from "../types.ts";
import { BatchAdapter } from "./batch.ts";
import { CliAdapter } from "./cli.ts";

class NoopAdapter implements Adapter {
  readonly name = "none";
  readonly kind = "per-case" as const;
  readonly supportsOptions = true;
  async check(input: CaseInput): Promise<CaseOutcome> {
    return { id: input.id, status: "ok", diagnostics: [] };
  }
}

export const ADAPTER_NAMES = ["maat-zig", "none", "mock-batch", "cli:<bin>"] as const;

export async function createAdapter(name: string): Promise<Adapter> {
  if (name === "maat-zig") {
    const bin = process.env.MAAT_ZIG_BIN;
    if (bin === undefined || bin.length === 0) {
      throw new Error("适配器 maat-zig 需要环境变量 MAAT_ZIG_BIN 指向 maat-zig 可执行文件");
    }
    return new CliAdapter({
      name: "maat-zig",
      bin,
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
    const bin = name.slice("cli:".length);
    if (bin.length === 0) throw new Error("cli:<bin> 需要给出可执行文件路径");
    const extra = (process.env.TSC_COMPA_CLI_ARGS ?? "").split(/\s+/).filter((s) => s.length > 0);
    return new CliAdapter({ name, bin, args: extra, supportsOptions: false });
  }
  throw new Error(`未知适配器 ${name}；可用：${ADAPTER_NAMES.join(" / ")}`);
}
