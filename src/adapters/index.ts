// 适配器工厂：按名字创建适配器。
//
// 内置：
//   tsc-cli        参考实现：直接用真实 tsc 跑逐案 CLI（TSC_COMPA_ADAPTER_TSC 覆盖二进制）
//   tsrs-async     固定 tsrs npm SDK 与原生后端（可选候选）
//   bun-check      Bun 内置类型检查器（bun-check:<bin> 或显式 BUN_CHECK_BIN）
//   checker-cli    被测检查器逐案 CLI（CHECKER_BIN 或 checker-cli:<bin>），固定 strict+esnext 口径
//   checker-batch  同一检查器的批量 NDJSON 模式（CHECKER_BATCH_BIN，缺省回落 CHECKER_BIN），固定口径
//   none           永远不报诊断（用于跑通流水线/看漏报全貌）
//   mock-batch     批量协议的参考实现（src/adapters/mock-batch.ts）
//   cli:<bin>      通用逐案 CLI（参数取 TSC_COMPA_CLI_ARGS，按空白切分）

import { join, resolve } from "node:path";
import { FIXED_STRICT_ESNEXT } from "../case.ts";
import type { Adapter, CaseInput, CaseOutcome } from "../types.ts";
import { BatchAdapter } from "./batch.ts";
import { BunCheckAdapter } from "./bun-check.ts";
import { CheckerCliAdapter } from "./checker-cli.ts";
import { CliAdapter } from "./cli.ts";
import { Ts7ApiAdapter } from "./ts7-api.ts";
import { TscCliAdapter } from "./tsc-cli.ts";
import { createTsrsAsyncAdapter } from "./tsrs-async.ts";

class NoopAdapter implements Adapter {
  readonly name = "none";
  readonly kind = "per-case" as const;
  readonly supportsOptions = true;
  async check(input: CaseInput): Promise<CaseOutcome> {
    return { id: input.id, status: "ok", diagnostics: [], fullText: "" };
  }
}

export const ADAPTER_NAMES = [
  "tsc-cli",
  "ts7-api",
  "tsrs-async",
  "bun-check",
  "bun-check:<bin>",
  "checker-cli",
  "checker-cli:<bin>",
  "checker-batch",
  "none",
  "mock-batch",
  "cli:<bin>",
] as const;

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
  if (name === "ts7-api") return new Ts7ApiAdapter();
  if (name === "tsrs-async") return createTsrsAsyncAdapter();
  if (name === "bun-check" || name.startsWith("bun-check:")) {
    // 只用显式指定的固定版本：不把当前 runner 的 Bun 当成候选。
    const embedded = name.startsWith("bun-check:") ? name.slice("bun-check:".length) : "";
    const raw = embedded.length > 0 ? embedded : (process.env.BUN_CHECK_BIN ?? "");
    if (raw.length === 0) {
      throw new Error("适配器 bun-check 需要 BUN_CHECK_BIN 或 bun-check:<bin> 指向固定版本的 Bun 可执行文件");
    }
    const extraArgs = (process.env.TSC_COMPA_ADAPTER_ARGS ?? "").split(/\s+/).filter((s) => s.length > 0);
    return new BunCheckAdapter({
      name: embedded.length > 0 ? name : "bun-check",
      bin: raw.includes("/") ? resolve(raw) : raw,
      extraArgs,
    });
  }
  if (name === "checker-cli" || name.startsWith("checker-cli:")) {
    // 被测检查器的逐案 CLI；checker-cli:<bin> 显式指定路径，缺省读 CHECKER_BIN。
    const embedded = name.startsWith("checker-cli:") ? name.slice("checker-cli:".length) : "";
    const raw = embedded.length > 0 ? embedded : (process.env.CHECKER_BIN ?? "");
    if (raw.length === 0) {
      throw new Error("适配器 checker-cli 需要 CHECKER_BIN 或 checker-cli:<bin> 指向可执行文件");
    }
    return new CheckerCliAdapter({
      name: embedded.length > 0 ? name : "checker-cli",
      bin: raw.includes("/") ? resolve(raw) : raw,
    });
  }
  if (name === "checker-batch") {
    // 同一检查器的批量模式：一个常驻进程吃完整 --cases，协议见 batch.ts。
    // 只支持固定口径，故 supportsOptions=false。
    const raw = process.env.CHECKER_BATCH_BIN ?? process.env.CHECKER_BIN;
    if (raw === undefined || raw.length === 0) {
      throw new Error("适配器 checker-batch 需要环境变量 CHECKER_BATCH_BIN（或 CHECKER_BIN）指向检查器可执行文件");
    }
    const adapter = new BatchAdapter({
      name: "checker-batch",
      command: raw.includes("/") ? resolve(raw) : raw,
      args: ["--batch"],
      fixedOptions: FIXED_STRICT_ESNEXT,
      supportsOptions: false,
    });
    await adapter.init();
    return adapter;
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
