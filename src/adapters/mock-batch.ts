#!/usr/bin/env bun
// 批量适配器协议的参考实现（以及测试用 mock）。
//
// 行为：读 stdin 的 NDJSON 请求，对每个 check 按源文本里的标记产出诊断：
//   - 某行含 FAKE_TS2322 → 该行 0 列报 TS2322
//   - 某行含 FAKE_TS2345 → 该行 0 列报 TS2345
//   - 整个用例含 FAKE_SKIP  → status=skip
//   - 整个用例含 FAKE_CRASH → status=crash
//   - 整个用例含 FAKE_RICH  → 返回完整协议字段（消息链/related/attributes/
//     fullText/exitCode/checkMs/rawOutput），验证客户端不丢字段。
// shutdown 或 EOF 时退出。它演示了协议的最小实现，也给 client 侧测试用。

import { createInterface } from "node:readline";
import type { Diagnostic } from "../types.ts";

interface CheckRequest {
  protocol: 1;
  type: "check" | "shutdown";
  id?: string;
  files?: { path: string; text: string }[];
}

function diagnosticsOf(files: { path: string; text: string }[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("FAKE_RICH")) {
        out.push({
          file: file.path,
          line: i,
          col: 0,
          code: 2322,
          severity: "error",
          width: 3,
          message: "rich message",
          messageChain: { text: "rich message", children: [{ text: "child" }] },
          related: [{ file: file.path, line: i, col: 1, width: 1, code: 2728, message: "related" }],
          attributes: { source: "TS", reportsUnnecessary: false },
          fullText: `${file.path}(${i + 1},1): error TS2322: rich message\n  child`,
          raw: { marker: "FAKE_RICH" },
        });
      }
      if (line.includes("FAKE_TS2322")) {
        out.push({ file: file.path, line: i, col: 0, code: 2322, severity: "error" });
      }
      if (line.includes("FAKE_TS2345")) {
        out.push({ file: file.path, line: i, col: 0, code: 2345, severity: "error" });
      }
    }
  }
  return out;
}

const rl = createInterface({ input: process.stdin });
const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

write({ protocol: 1, type: "hello", implementation: { name: "mock-batch", version: "0" } });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let request: CheckRequest;
  try {
    request = JSON.parse(trimmed) as CheckRequest;
  } catch {
    return; // 非 JSON 行忽略
  }
  if (request.type === "shutdown") {
    process.exit(0);
  }
  if (request.type !== "check" || typeof request.id !== "string") return;
  const files = request.files ?? [];
  const text = files.map((f) => f.text).join("\n");
  if (text.includes("FAKE_CRASH")) {
    write({ protocol: 1, type: "result", id: request.id, status: "crash", message: "mock crash" });
    return;
  }
  if (text.includes("FAKE_SKIP")) {
    write({ protocol: 1, type: "result", id: request.id, status: "skip", skipReason: "mock skip" });
    return;
  }
  const diagnostics = diagnosticsOf(files);
  const rich = text.includes("FAKE_RICH");
  write({
    protocol: 1,
    type: "result",
    id: request.id,
    status: "ok",
    diagnostics,
    ...(rich && {
      fullText: diagnostics.map((d) => d.fullText).join("\n"),
      exitCode: 2,
      checkMs: 12,
      rawOutput: { stdout: "mock stdout", stderr: "mock stderr" },
    }),
  });
});
