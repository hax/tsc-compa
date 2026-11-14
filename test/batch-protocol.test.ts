// 批量适配器协议：对着参考实现（mock-batch.ts）验证请求/响应往返。

import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { BatchAdapter } from "../src/adapters/batch.ts";
import type { CaseInput } from "../src/types.ts";

const adapter = new BatchAdapter({
  name: "mock-batch",
  command: process.execPath,
  args: [join(import.meta.dir, "..", "src", "adapters", "mock-batch.ts")],
});

afterAll(async () => {
  await adapter.close();
});

const input = (id: string, text: string): CaseInput => ({
  id,
  files: [{ path: "a.ts", text }],
  options: [{ name: "strict", value: true }],
  args: ["--strict", "true"],
});

test("ok 响应带着诊断位置与码回来", async () => {
  const outcome = await adapter.check(input("ok", "let x = 1;\nFAKE_TS2322\nFAKE_TS2345\n"));
  expect(outcome.status).toBe("ok");
  expect(outcome.diagnostics.map((d) => d.code)).toEqual([2322, 2345]);
  expect(outcome.diagnostics[0]!.line).toBe(1);
  expect(outcome.diagnostics[0]!.col).toBe(0);
});

test("skip / crash 状态按用例返回", async () => {
  const skipped = await adapter.check(input("skip", "FAKE_SKIP\n"));
  expect(skipped.status).toBe("skip");
  expect(skipped.skipReason).toBe("mock skip");
  const crashed = await adapter.check(input("crash", "FAKE_CRASH\n"));
  expect(crashed.status).toBe("crash");
});

test("多个用例复用同一个进程（顺序请求互不串扰）", async () => {
  const [a, b] = await Promise.all([
    adapter.check(input("p1", "FAKE_TS2322\n")),
    adapter.check(input("p2", "FAKE_TS2345\n")),
  ]);
  expect(a.diagnostics.map((d) => d.code)).toEqual([2322]);
  expect(b.diagnostics.map((d) => d.code)).toEqual([2345]);
});
