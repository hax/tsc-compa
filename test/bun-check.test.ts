// Bun `check` 专用适配器：参数映射、输出解析与本机真实二进制验证。
//
// 真实二进制测试只在显式提供 BUN_CHECK_BIN 时运行；不会把测试 runner 自身
// 当成被评估的 Bun 版本。命令行参数映射/计划逻辑在不设该变量时仍然全跑。

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BunCheckAdapter, compilerOptionsFromArgs, planBunCheck } from "../src/adapters/bun-check.ts";
import { createAdapter } from "../src/adapters/index.ts";

const REAL_BUN = process.env.BUN_CHECK_BIN;

const input = (args: string[], files = [{ path: "a.ts", text: 'const x: number = "s";\nexport {};\n' }]) => ({
  id: "a.ts" as const,
  files,
  options: [],
  args,
});

describe("compilerOptionsFromArgs", () => {
  test("last-wins，裸布尔与显式值都保留", () => {
    const opts = compilerOptionsFromArgs([
      "--strict", "false",
      "--target", "es2015",
      "--target", "es2022",
      "--noErrorTruncation",
      "--skipDefaultLibCheck", "true",
      "--lib", "es2022,dom",
    ]);
    expect(opts).toEqual({
      strict: false,
      target: "es2022",
      noErrorTruncation: true,
      skipDefaultLibCheck: true,
      lib: ["es2022", "dom"],
    });
  });

  test("剥离 harness 控制项，不写进 tsconfig", () => {
    const opts = compilerOptionsFromArgs([
      "--noEmit", "--pretty", "false", "--extendedDiagnostics", "--ignoreConfig",
      "--strict", "true", "--noErrorTruncation",
    ]);
    expect(opts).toEqual({ strict: true, noErrorTruncation: true });
  });
});

describe("planBunCheck", () => {
  test("es2026 显式 skip，不替换成 esnext", () => {
    const plan = planBunCheck(input(["--target", "es2026"]));
    expect(plan.skipReason).toContain("target=es2026");
  });

  test("node10/classic/baseUrl 显式 skip", () => {
    expect(planBunCheck(input(["--moduleResolution", "node10"])).skipReason).toContain("node10");
    expect(planBunCheck(input(["--moduleResolution", "classic"])).skipReason).toContain("classic");
    expect(planBunCheck(input(["--baseUrl", "."])).skipReason).toContain("baseUrl");
  });

  test("登记的 bun check CLI 开关不写进 compilerOptions", () => {
    const plan = planBunCheck(input(["--strict", "true"]), ["--no-script", "--no-pretty", "--all", "--timing"]);
    expect(plan.tsconfig.compilerOptions).toEqual({ strict: true });
  });

  test("普通选项生成独立 tsconfig 与文件列表", () => {
    const plan = planBunCheck(input(["--strict", "true", "--target", "es2022"]), []);
    expect(plan.skipReason).toBeNull();
    expect(plan.tsconfig).toEqual({
      compilerOptions: { strict: true, target: "es2022" },
      files: ["a.ts"],
    });
  });
});

describe("BunCheckAdapter（真实 Bun 1.4.x）", () => {
  test(
    "解析 stdout 诊断、stderr 汇总与退出码 1",
    async () => {
      if (REAL_BUN === undefined) return;
      const adapter = new BunCheckAdapter({ bin: REAL_BUN });
      const outcome = await adapter.check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(1);
      expect(outcome.diagnostics[0]).toMatchObject({ file: "a.ts", line: 0, col: 6, code: 2322, severity: "error" });
      expect(outcome.fullText).toBe("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
      expect(outcome.exitCode).toBe(1);
      expect(outcome.rawOutput?.stdout).toContain("a.ts(1,7): error TS2322");
    },
    30_000,
  );

  test(
    "无诊断时 fullText 为空串且退出码 0",
    async () => {
      if (REAL_BUN === undefined) return;
      const adapter = new BunCheckAdapter({ bin: REAL_BUN });
      const outcome = await adapter.check(input(["--strict", "true"], [{ path: "ok.ts", text: "export const x = 1;\n" }]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.fullText).toBe("");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.rawOutput?.stderr).toContain("No type errors");
    },
    30_000,
  );

  test("本机固定版本与内置 TypeScript 版本", async () => {
    if (REAL_BUN === undefined) return;
    const r = Bun.spawnSync([REAL_BUN, "-p", "JSON.stringify({bun:Bun.version,revision:Bun.revision,typescript:process.versions.typescript})"], {
      stdout: "pipe", stderr: "pipe",
    });
    const info = JSON.parse(r.stdout.toString());
    expect(info.bun).toMatch(/^1\.4\./);
    expect(info.typescript).toBe("7.0.2");
  });
});

describe("BunCheckAdapter（合成的双流输出）", () => {
  function fakeBun(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-fake-bun-"));
    const bin = join(dir, "bun");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  test("诊断在 stderr 时也能解析；跨流同一条按多重集只记一次", async () => {
    const bin = fakeBun(
      'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'." >&2\n' +
      'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."\n' +
      'echo "Found 1 error in 1 file, checked 1 file [1.00ms]" >&2\nexit 1',
    );
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(1);
      expect(outcome.fullText).toBe("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
      expect(outcome.exitCode).toBe(1);
      expect(outcome.rawOutput).toEqual({
        stdout: expect.stringContaining("TS2322"),
        stderr: expect.stringContaining("Found 1 error"),
      });
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("同一输出流内真实重复诊断必须保留计数", async () => {
    const bin = fakeBun(
      'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."\n' +
      'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."\n' +
      'echo "Found 2 errors in 1 file, checked 1 file [1.00ms]" >&2\nexit 1',
    );
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(2);
      expect(outcome.fullText?.split("\n")).toHaveLength(2);
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("跨流重复按多重集取较大出现次数，不吞掉同流重复", async () => {
    const line = 'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."';
    const bin = fakeBun(`${line}\n${line}\n${line} >&2\necho "Found 2 errors in 1 file, checked 1 file [1.00ms]" >&2\nexit 1`);
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(2);
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("CLI 选项不受支持：skip 且未提供 fullText", async () => {
    const bin = fakeBun('echo "error: Unknown flag \"--json\"" >&2\nexit 1');
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("skip");
      expect(outcome.fullText).toBeUndefined();
      expect(outcome.exitCode).toBe(1);
      expect(outcome.rawOutput?.stderr).toContain("Unknown flag");
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("运行失败/不可解析输出归 crash，不得静默跳过", async () => {
    const bin = fakeBun('echo "segfault-ish garbage" >&2\nexit 1');
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("crash");
      expect(outcome.skipReason).toContain("没有可解析诊断");
      expect(outcome.fullText).toBeUndefined();
      expect(outcome.exitCode).toBe(1);
      expect(outcome.rawOutput?.stderr).toContain("garbage");
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });
  test("可证明的配置选项不受支持才 skip；坏配置归 crash", async () => {
    const optionsError = fakeBun('echo "tsconfig.json(1,1): error TS5108: removed"\nexit 1');
    const brokenConfig = fakeBun('echo "tsconfig.json(1,1): error TS1109: bad json"\nexit 1');
    try {
      const skipped = await new BunCheckAdapter({ bin: optionsError }).check(input(["--strict", "true"]));
      expect(skipped.status).toBe("skip");
      expect(skipped.skipReason).toContain("TS5108");
      expect(skipped.fullText).toBeUndefined();
      const crashed = await new BunCheckAdapter({ bin: brokenConfig }).check(input(["--strict", "true"]));
      expect(crashed.status).toBe("crash");
      expect(crashed.skipReason).toContain("TS1109");
      expect(crashed.fullText).toBeUndefined();
    } finally {
      rmSync(join(optionsError, ".."), { recursive: true, force: true });
      rmSync(join(brokenConfig, ".."), { recursive: true, force: true });
    }
  });

  test("GitHub annotation 行不当作诊断，也不影响顺序", async () => {
    const bin = fakeBun(
      'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."\n' +
      'echo "::error file=a.ts,line=1,col=7,endLine=1,endColumn=8,title=TS2322::Type \'string\' is not assignable to type \'number\'."\n' +
      'echo "Found 1 error in 1 file, checked 1 file [1.00ms]" >&2\nexit 1',
    );
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(1);
      expect(outcome.fullText).toBe("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("权威流按诊断条数选择，保留该流的顺序", async () => {
    const bin = fakeBun(
      'echo "a.ts(1,7): error TS2322: first"\n' +
      'echo "a.ts(2,7): error TS2322: second" >&2\n' +
      'echo "a.ts(3,7): error TS2322: third" >&2\n' +
      'echo "Found 3 errors in 1 file, checked 1 file [1.00ms]" >&2\nexit 1',
    );
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics.map((d) => d.line)).toEqual([1, 2, 0]);
      expect(outcome.fullText?.split("\n").map((line) => line.includes("first") ? "first" : line.includes("second") ? "second" : "third"))
        .toEqual(["second", "third", "first"]);
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("stderr 的文件计数行不并入诊断块；--timing 成功解析", async () => {
    const bin = fakeBun(
      'echo "a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."\n' +
      'echo "Found 1 error in 1 file, checked 1 file [2.50ms]" >&2\n' +
      'echo "  88 files loaded in 1.2ms, 1 checked in 0.7ms, 11 KB of stack at the most" >&2\nexit 1',
    );
    try {
      const outcome = await new BunCheckAdapter({ bin }).check(input(["--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(1);
      expect(outcome.fullText).toBe("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
      expect(outcome.checkMs).toBe(0.7);
    } finally {
      rmSync(join(bin, ".."), { recursive: true, force: true });
    }
  });

  test("未启动进程的 skip 不采集 exitCode/rawOutput/fullText", async () => {
    const outcome = await new BunCheckAdapter({ bin: "/nonexistent/bun" }).check(input(["--target", "es2026"]));
    expect(outcome.status).toBe("skip");
    expect(outcome.fullText).toBeUndefined();
    expect(outcome.exitCode).toBeUndefined();
    expect(outcome.rawOutput).toBeUndefined();
  });
});

describe("createAdapter(bun-check)", () => {
  test("未给显式二进制时拒绝，不回落 runner", async () => {
    const saved = process.env.BUN_CHECK_BIN;
    delete process.env.BUN_CHECK_BIN;
    try {
      expect(createAdapter("bun-check")).rejects.toThrow("BUN_CHECK_BIN");
    } finally {
      if (saved === undefined) delete process.env.BUN_CHECK_BIN;
      else process.env.BUN_CHECK_BIN = saved;
    }
  });

  test("手柄：无 schema 变化时 NoopAdapter 明确空输出", async () => {
    const adapter = await createAdapter("none");
    const outcome = await adapter.check({ id: "x", files: [], options: [], args: [] });
    expect(outcome.fullText).toBe("");
  });
});
