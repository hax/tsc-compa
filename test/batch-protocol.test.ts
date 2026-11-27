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

test("完整诊断字段与结果级字段透传（不丢 raw）", async () => {
  const outcome = await adapter.check(input("rich", "FAKE_RICH\n"));
  expect(outcome.status).toBe("ok");
  expect(outcome.exitCode).toBe(2);
  expect(outcome.checkMs).toBe(12);
  expect(outcome.fullText).toContain("error TS2322: rich message");
  expect(outcome.rawOutput).toEqual({ stdout: "mock stdout", stderr: "mock stderr" });
  expect(outcome.diagnostics[0]).toMatchObject({
    file: "a.ts",
    line: 0,
    col: 0,
    code: 2322,
    width: 3,
    message: "rich message",
    messageChain: { text: "rich message", children: [{ text: "child" }] },
    related: [{ file: "a.ts", line: 0, col: 1, width: 1, code: 2728, message: "related" }],
    attributes: { source: "TS", reportsUnnecessary: false },
    fullText: "a.ts(1,1): error TS2322: rich message\n  child",
    raw: { marker: "FAKE_RICH" },
  });
});

test("多个用例复用同一个进程（顺序请求互不串扰）", async () => {
  const [a, b] = await Promise.all([
    adapter.check(input("p1", "FAKE_TS2322\n")),
    adapter.check(input("p2", "FAKE_TS2345\n")),
  ]);
  expect(a.diagnostics.map((d) => d.code)).toEqual([2322]);
  expect(b.diagnostics.map((d) => d.code)).toEqual([2345]);
});

test("ok without a diagnostics array is a protocol error, not a clean result", async () => {
  const invalid = new BatchAdapter({ name: "invalid", command: process.execPath, args: ["-e", `
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.type === 'shutdown') process.exit(0);
      console.log(JSON.stringify({protocol:1,type:'result',id:request.id,status:'ok'}));
    });
  `] });
  try {
    expect((await invalid.check(input("missing-diagnostics", ""))).status).toBe("crash");
  } finally { await invalid.close(); }
});

test("an already exited batch process closes without waiting forever", async () => {
  const lost = new BatchAdapter({ name: "lost", command: process.execPath, args: ["-e", "process.exit(70)"], timeoutMs: 500 });
  expect((await lost.check(input("broken", ""))).status).toBe("crash");
  await lost.close();
}, 2_000);
