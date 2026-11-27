// 参考期望采集：原始顺序、全文字段、退出码、stats-only clean 与缓存管线版本。

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { expectationOf, EXPECTATION_PIPELINE, EXPECTATION_SCHEMA_VERSION } from "../src/tsc.ts";

const files = [{ path: "x.ts", text: "export {};\n" }];

function fakeTsc(script: string): { dir: string; bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-tsc-test-"));
  const bin = join(dir, "fake-tsc");
  const marker = join(dir, "runs");
  writeFileSync(bin, script.replaceAll("@MARKER@", marker));
  chmodSync(bin, 0o755);
  return { dir, bin, marker };
}

function invoke(bin: string, cacheDir: string, compilerIdentity = "fake-1") {
  return expectationOf("compiler/x.ts", files, [], {
    tscBin: bin,
    tscVersion: "test",
    args: ["--noEmit", "--pretty", "false"],
    cacheDir,
    compilerIdentity,
  });
}

describe("expectationOf（参考采集契约）", () => {
  test("诊断保持输出顺序，fullText 是摘要流，exitCode/rawOutput 保留", () => {
    const fake = fakeTsc(
      '#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf "%s(2,1): error TS2322: second\\n  detail second\\n%s(1,1): error TS2339: first\\n" "$last" "$last"\nexit 2\n',
    );
    const cacheDir = join(fake.dir, "cache");
    try {
      const result = invoke(fake.bin, cacheDir);
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(2);
      expect(result.diagnostics.map((d) => d.code)).toEqual([2322, 2339]);
      expect(result.fullText).toBe([
        "x.ts(2,1): error TS2322: second",
        "  detail second",
        "x.ts(1,1): error TS2339: first",
      ].join("\n"));
      expect(result.rawOutput?.stdout).toContain("TS2322");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("成功输出但退出码非 0 且无诊断：crash", () => {
    const fake = fakeTsc('#!/bin/sh\necho "Files: 1"\nexit 1\n');
    const cacheDir = join(fake.dir, "cache");
    try {
      const result = invoke(fake.bin, cacheDir);
      expect(result.status).toBe("crash");
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("clean 且只有 extendedDiagnostics 统计：ok、fullText 空串、exitCode 0", () => {
    const fake = fakeTsc(
      '#!/bin/sh\necho "Files: 1"\necho "Lines of Library: 1"\necho "I/O Read time: 0.00s"\necho "ResolveLibrary time: 0.00s"\necho "ResolveModule time: 0.00s"\necho "printTime time: 0.00s"\necho "Parse time: 0.001s"\necho "Bind time: 0.001s"\necho "Check time: 0.002s"\necho "Total time: 0.004s"\nexit 0\n',
    );
    const cacheDir = join(fake.dir, "cache");
    try {
      const result = invoke(fake.bin, cacheDir);
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect(result.diagnostics).toEqual([]);
      expect(result.fullText).toBe("");
      expect(result.rawOutput?.stdout).toContain("ResolveLibrary time");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("非零退出且无诊断：crash，不落成零诊断", () => {
    const fake = fakeTsc('#!/bin/sh\necho "internal failure" >&2\nexit 1\n');
    const cacheDir = join(fake.dir, "cache");
    try {
      const result = invoke(fake.bin, cacheDir);
      expect(result.status).toBe("crash");
      expect(result.exitCode).toBe(1);
      expect(result.rawOutput?.stderr).toContain("internal failure");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("不支持的编译选项显式跳过，其余无位置故障仍为 crash", () => {
    const unsupported = fakeTsc('#!/bin/sh\necho "error TS6046: Argument for --target is not valid."\nexit 1\n');
    const removed = fakeTsc('#!/bin/sh\necho "error TS5108: Option target=ES5 has been removed."\nexit 2\n');
    const missing = fakeTsc('#!/bin/sh\necho "error TS6053: File not found."\nexit 1\n');
    try {
      expect(invoke(unsupported.bin, join(unsupported.dir, "cache"))).toMatchObject({ status: "unsupported", exitCode: 1 });
      expect(invoke(removed.bin, join(removed.dir, "cache"))).toMatchObject({ status: "unsupported", exitCode: 2 });
      expect(invoke(missing.bin, join(missing.dir, "cache"))).toMatchObject({ status: "crash", exitCode: 1 });
    } finally {
      rmSync(unsupported.dir, { recursive: true, force: true });
      rmSync(missing.dir, { recursive: true, force: true });
      rmSync(removed.dir, { recursive: true, force: true });
    }
  });

  test("异常不会永久占用同二进制的缓存键", () => {
    const fake = fakeTsc('#!/bin/sh\necho "transient failure" >&2\nexit 1\n');
    const cacheDir = join(fake.dir, "cache");
    try {
      expect(invoke(fake.bin, cacheDir).status).toBe("crash");
      writeFileSync(fake.bin, '#!/bin/sh\nexit 0\n');
      expect(invoke(fake.bin, cacheDir).status).toBe("ok");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("compilerIdentity 进入缓存键：同版本不同二进制不复用", () => {
    const fake = fakeTsc(
      '#!/bin/sh\nprintf run >> "@MARKER@"\nfor arg in "$@"; do last="$arg"; done\nprintf "%s(1,1): error TS2322: identify\n" "$last"\nexit 2\n',
    );
    const cacheDir = join(fake.dir, "cache");
    try {
      invoke(fake.bin, cacheDir, "identity-a");
      invoke(fake.bin, cacheDir, "identity-b");
      expect(readdirSync(cacheDir)).toHaveLength(2);
      expect(readFileSync(fake.marker, "utf8")).toBe("runrun");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("参考诊断 raw 对象与原始顺序保留", () => {
    const fake = fakeTsc(
      '#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf "%s(2,3): error TS2322: second\n%s(1,4): error TS2339: first\n" "$last" "$last"\nexit 2\n',
    );
    const cacheDir = join(fake.dir, "cache");
    try {
      const result = invoke(fake.bin, cacheDir);
      expect(result.diagnostics.map((d) => d.code)).toEqual([2322, 2339]);
      expect(result.original?.map((d) => d.code)).toEqual([2322, 2339]);
      expect(result.rawDiagnostics).toHaveLength(2);
      expect(result.rawDiagnostics?.[0]).toMatchObject({ lineNumber: 2, colNumber: 3, code: 2322 });
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("缓存带 schema/pipeline；旧管线结果不会读回", () => {
    const fake = fakeTsc(
      '#!/bin/sh\nprintf run >> "@MARKER@"\nfor arg in "$@"; do last="$arg"; done\nprintf "%s(1,1): error TS2322: cached\\n" "$last"\nexit 2\n',
    );
    const cacheDir = join(fake.dir, "cache");
    try {
      const first = invoke(fake.bin, cacheDir);
      expect(first.status).toBe("ok");
      const entries = readdirSync(cacheDir);
      expect(entries).toHaveLength(1);
      const path = join(cacheDir, entries[0]!);
      const stored = JSON.parse(readFileSync(path, "utf8"));
      expect(stored.schemaVersion).toBe(EXPECTATION_SCHEMA_VERSION);
      expect(stored.pipeline).toBe(EXPECTATION_PIPELINE);
      // 第二次命中缓存，不再启动 fake tsc。
      invoke(fake.bin, cacheDir);
      expect(readFileSync(fake.marker, "utf8")).toBe("run");
      // 模拟旧解析管线写入同一路径：必须忽略并重新采集。
      writeFileSync(path, JSON.stringify({ status: "ok", diagnostics: [] }));
      const third = invoke(fake.bin, cacheDir);
      expect(third.diagnostics.map((d) => d.code)).toEqual([2322]);
      expect(readFileSync(fake.marker, "utf8")).toBe("runrun");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });
});
