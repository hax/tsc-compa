// TS7 async API 进程内适配器：结构化诊断映射、CLI 口径对齐与真实 API 冒烟。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ts7ApiAdapter,
  type ApiClientLike,
  type ApiDiagnosticResponse,
  type ApiParsedCommandLine,
  type ApiProgramLike,
} from "../src/adapters/ts7-api.ts";
import type { CaseFile, CaseInput } from "../src/types.ts";

const input = (files: CaseFile[], args: string[] = ["--noEmit"]): CaseInput => ({
  id: "case",
  files,
  options: [],
  args,
});

function diagnostic(patch: Partial<ApiDiagnosticResponse> & Pick<ApiDiagnosticResponse, "fileName" | "text">): ApiDiagnosticResponse {
  return {
    pos: 0,
    end: 1,
    startPosition: { line: 0, character: 0 },
    endPosition: { line: 0, character: 1 },
    code: 2322,
    category: 1,
    ...patch,
  };
}

interface FakeOptions {
  parseErrors?: ApiDiagnosticResponse[];
  raw?: Record<string, unknown>;
  omitDeclarationMethod?: boolean;
  diagnosticsFor: (files: readonly string[], root: () => string) => Partial<Record<"program" | "global" | "config" | "syntactic" | "semantic" | "declaration", ApiDiagnosticResponse[]>>;
  onSemantic?: () => void;
  onDeclaration?: () => void;
}

interface FakeHandle {
  api: ApiClientLike;
  closed: () => boolean;
  lastOptions: () => Record<string, unknown> | undefined;
  parseCalls: () => number;
  createCalls: () => number;
}

function fakeApi(options: FakeOptions): FakeHandle {
  let closed = false;
  let parseCalls = 0;
  let createCalls = 0;
  let lastOptions: Record<string, unknown> | undefined;
  let root = "";
  let fileNames: readonly string[] = [];
  const api: ApiClientLike = {
    async parseCommandLine(args): Promise<ApiParsedCommandLine> {
      parseCalls++;
      fileNames = args.filter((arg) => arg.endsWith(".ts"));
      root = fileNames[0] ?? "";
      root = root.slice(0, root.lastIndexOf("/"));
      const parsed: Record<string, unknown> = options.raw ?? { noEmit: true };
      for (let i = 0; i < args.length; i++) {
        const option = args[i]!;
        if (!option.startsWith("--")) continue;
        const name = option.slice(2);
        if (["rootDir", "typeRoots", "outDir", "declarationDir", "baseUrl", "outFile", "tsBuildInfoFile"].includes(name)) {
          parsed[name] = name === "typeRoots" ? args[i + 1]!.split(",") : args[i + 1];
        } else if (["declaration", "composite", "emitDeclarationOnly", "noEmit", "noEmitOnError"].includes(name)) {
          parsed[name] = args[i + 1] === "false" ? false : true;
          if (args[i + 1] === "false" || args[i + 1] === "true") i++;
        }
      }
      return { fileNames, raw: parsed, errors: options.parseErrors ?? [] };
    },
    async createProgram(_rootFiles, compilerOptions): Promise<ApiProgramLike> {
      createCalls++;
      lastOptions = compilerOptions;
      const groups = options.diagnosticsFor(fileNames, () => root);
      const program: ApiProgramLike = {
        async getProgramDiagnostics() { return groups.program ?? []; },
        async getGlobalDiagnostics() { return groups.global ?? []; },
        async getConfigFileParsingDiagnostics() { return groups.config ?? []; },
        async getSyntacticDiagnostics() { return groups.syntactic ?? []; },
        async getSemanticDiagnostics() {
          options.onSemantic?.();
          return groups.semantic ?? [];
        },
        async getDeclarationDiagnostics() {
          options.onDeclaration?.();
          return groups.declaration ?? [];
        },
        async dispose() {},
      };
      if (options.omitDeclarationMethod) delete (program as Partial<ApiProgramLike>).getDeclarationDiagnostics;
      return program;
    },
    async close() { closed = true; },
    getCanonicalFileName: (fileName) => fileName,
  };
  return {
    api,
    closed: () => closed,
    lastOptions: () => lastOptions,
    parseCalls: () => parseCalls,
    createCalls: () => createCalls,
  };
}

describe("Ts7ApiAdapter（注入 API）", () => {
  test("结构化字段：width、chain、related、attributes 与 fullText 同源", async () => {
    const related: ApiDiagnosticResponse = diagnostic({
      fileName: "",
      pos: 20,
      end: 21,
      startPosition: { line: 1, character: 7 },
      endPosition: { line: 1, character: 8 },
      code: 2728,
      category: 3,
      text: "'y' is declared here.",
    });
    const chain = diagnostic({ fileName: "", text: "Property 'a' does not exist on type 'B'." });
    const main = diagnostic({
      fileName: "",
      pos: 4,
      end: 7,
      startPosition: { line: 1, character: 4 },
      endPosition: { line: 1, character: 7 },
      code: 2741,
      text: "Property 'y' is missing in type '{ x: number; }' but required in type 'Point'.",
      reportsDeprecated: true,
      reportsUnnecessary: true,
      source: "TS",
      messageChain: [chain],
      relatedInformation: [related],
    });
    const childRelated = diagnostic({
      fileName: "",
      pos: 24,
      end: 25,
      startPosition: { line: 1, character: 9 },
      endPosition: { line: 1, character: 10 },
      code: 2728,
      category: 3,
      source: "TS",
      text: "'y' is declared here.",
      attributes: { marker: "child" },
    });
    chain.relatedInformation = [childRelated];
    const fake = fakeApi({
      diagnosticsFor: (files) => {
        const fileName = files[0]!;
        childRelated.fileName = fileName;
        related.fileName = fileName;
        chain.fileName = fileName;
        main.fileName = fileName;
        return {
          syntactic: [diagnostic({ fileName, pos: 0, end: 4, startPosition: { line: 0, character: 0 }, code: 1005, text: "syntax free marker" })].slice(1),
          semantic: [main],
        };
      },
    });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const outcome = await adapter.check(input([{ path: "a.ts", text: "interface Point { x: number; y: number }\nconst p: Point = { x: 1 };\n" }], ["--noEmit"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.exitCode).toBeUndefined();
      const [mapped] = outcome.diagnostics;
      expect(mapped).toMatchObject({
        file: "a.ts",
        line: 1,
        col: 4,
        end: { line: 1, col: 7 },
        width: 3,
        code: 2741,
        severity: "error",
        message: main.text,
        attributes: { source: "TS", reportsUnnecessary: true, reportsDeprecated: true },
      });
      expect(mapped!.messageChain).toMatchObject({
        text: main.text,
        code: 2741,
        category: 1,
        attributes: { source: "TS", reportsUnnecessary: true, reportsDeprecated: true },
        children: [{
          text: "Property 'a' does not exist on type 'B'.",
          code: 2322,
          category: 1,
          attributes: {},
          children: [],
        }],
      });
      expect(mapped!.related).toMatchObject([{
        file: "a.ts",
        line: 1,
        col: 7,
        end: { line: 1, col: 8 },
        width: 1,
        code: 2728,
        category: 3,
        message: "'y' is declared here.",
        messageChain: null,
        attributes: {},
      }]);
      expect("raw" in mapped!.messageChain!).toBe(false);
      expect("raw" in mapped!.messageChain!.children![0]!).toBe(false);
      expect(mapped!.related![0]!.raw).toBe(related);
      expect(mapped!.fullText).toBe(
        [
          "a.ts(2,5): error TS2741: Property 'y' is missing in type '{ x: number; }' but required in type 'Point'.",
          "  Property 'a' does not exist on type 'B'.",
        ].join("\n"),
      );
      expect(outcome.fullText).toBe(mapped!.fullText!);
    } finally {
      await adapter.close();
    }
    expect(fake.closed()).toBe(true);
  });

  test("语法诊断存在时不取 semantic；目录外诊断剔除；无诊断时 fullText 是空串", async () => {
    let semanticCalls = 0;
    const fake = fakeApi({
      diagnosticsFor: (files) => {
        const fileName = files[0]!;
        return {
          syntactic: [diagnostic({ fileName, pos: 6, end: 7, startPosition: { line: 0, character: 6 }, code: 1134, text: "Variable declaration expected." })],
          semantic: [diagnostic({ fileName, pos: 10, end: 11, startPosition: { line: 0, character: 10 }, code: 2322, text: "must not be fetched" })],
          global: [
            diagnostic({ fileName, pos: 0, end: 1, startPosition: { line: 0, character: 0 }, code: 1134, text: "Variable declaration expected." }),
            diagnostic({ fileName: "/opt/ts7/lib/lib.dom.d.ts", pos: 0, end: 1, startPosition: { line: 0, character: 0 }, code: 6385, text: "deprecated" }),
          ],
        };
      },
      onSemantic: () => { semanticCalls++; },
    });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const outcome = await adapter.check(input([{ path: "a.ts", text: "const = 2;\n" }], ["--noEmit"]));
      expect(outcome.status).toBe("ok");
      // global 与 syntactic 返回同形诊断时保留重复；不在这里跨方法合并。
      expect(outcome.diagnostics).toHaveLength(2);
      expect(outcome.diagnostics.map((d) => d.code)).toEqual([1134, 1134]);
      expect(outcome.diagnostics.every((d) => d.file === "a.ts")).toBe(true);
      expect(outcome.fullText).toBe(
        [
          "a.ts(1,1): error TS1134: Variable declaration expected.",
          "a.ts(1,7): error TS1134: Variable declaration expected.",
        ].join("\n"),
      );
      expect(semanticCalls).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  test("超时后下一案等待被放弃的实际请求，不在同一 API 上重叠", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const fake: ApiClientLike = {
      async parseCommandLine(args) {
        const fileName = args.find((arg) => arg.endsWith(".ts"))!;
        return { fileNames: [fileName], raw: { noEmit: true }, errors: [] };
      },
      async createProgram() {
        active++;
        maxActive = Math.max(maxActive, active);
        await blocked;
        active--;
        return {
          async getProgramDiagnostics() { return []; },
          async getGlobalDiagnostics() { return []; },
          async getSyntacticDiagnostics() { return []; },
          async getSemanticDiagnostics() { return []; },
          async getDeclarationDiagnostics() { return []; },
          async dispose() {},
        };
      },
      async close() {},
    };
    const adapter = new Ts7ApiAdapter({ api: fake, timeoutMs: 20 });
    try {
      const first = await adapter.check(input([{ path: "a.ts", text: "const a = 1;\n" }], ["--noEmit"]));
      expect(first.status).toBe("timeout");
      const secondPromise = adapter.check(input([{ path: "b.ts", text: "const b = 1;\n" }], ["--noEmit"]));
      // 第二案必须排在未完成的 createProgram 之后。
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(active).toBe(1);
      release();
      const second = await secondPromise;
      expect(second.status).toBe("ok");
      expect(maxActive).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  test("close 在请求在途时有界返回；注入 API 等待请求结束后只关闭一次，不触碰其它 API", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let closes = 0;
    let unrelatedCloses = 0;
    const fake: ApiClientLike = {
      async parseCommandLine(args) {
        const fileName = args.find((arg) => arg.endsWith(".ts"))!;
        return { fileNames: [fileName], raw: { noEmit: true }, errors: [] };
      },
      async createProgram() {
        await blocked;
        return {
          async getProgramDiagnostics() { return []; },
          async getGlobalDiagnostics() { return []; },
          async getSyntacticDiagnostics() { return []; },
          async getSemanticDiagnostics() { return []; },
          async getDeclarationDiagnostics() { return []; },
          async dispose() {},
        };
      },
      async close() { closes++; },
    };
    const adapter = new Ts7ApiAdapter({ api: fake, timeoutMs: 10, closeGraceMs: 10 });
    const pending = adapter.check(input([{ path: "a.ts", text: "const x = 1;\n" }], ["--noEmit"]));
    const timedOut = await pending;
    expect(timedOut.status).toBe("timeout");

    const started = Date.now();
    await adapter.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(closes).toBe(0);

    const after = await adapter.check(input([{ path: "b.ts", text: "const y = 1;\n" }], ["--noEmit"]));
    expect(after.status).toBe("crash");
    expect(after.skipReason).toContain("已关闭");

    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closes).toBe(1);
    await adapter.close();
    expect(closes).toBe(1);
    expect(unrelatedCloses).toBe(0);

    const unrelated: ApiClientLike = {
      async parseCommandLine() { return { fileNames: [], raw: {}, errors: [] }; },
      async createProgram() { throw new Error("unused"); },
      async close() { unrelatedCloses++; },
    };
    const other = new Ts7ApiAdapter({ api: unrelated });
    await other.init();
    await other.close();
    expect(unrelatedCloses).toBe(1);
    expect(closes).toBe(1);
  });

  test("仅内置 pinned API 的 close 超时通过 stdin.end/kill/unref 兜底", async () => {
    let stdinEnded = 0;
    let kills = 0;
    let unrefs = 0;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const fake = fakeApi({ diagnosticsFor: () => ({}) });
    const builtIn = {
      ...fake.api,
      async createProgram() {
        entered();
        await blocked;
        return {
          async getProgramDiagnostics() { return []; },
          async getGlobalDiagnostics() { return []; },
          async getSyntacticDiagnostics() { return []; },
          async getSemanticDiagnostics() { return []; },
          async getDeclarationDiagnostics() { return []; },
          async dispose() {},
        };
      },
      client: {
        process: {
          stdin: { end() { stdinEnded++; } },
          kill() { kills++; return true; },
          unref() { unrefs++; },
        },
      },
    };
    const adapter = new Ts7ApiAdapter({ apiFactory: async () => builtIn, timeoutMs: 10, closeGraceMs: 10 });
    const pending = adapter.check(input([{ path: "a.ts", text: "const x = 1;\n" }], ["--noEmit"]));
    await started;
    expect((await pending).status).toBe("timeout");
    await adapter.close();
    expect({ stdinEnded, kills, unrefs }).toEqual({ stdinEnded: 1, kills: 1, unrefs: 1 });
    release();
  });

  test("declaration 阶段按 CLI 语义门控，Pinned API 缺失时明确 crash", async () => {
    let declarationCalls = 0;
    const decl = (fileName: string) => diagnostic({
      fileName, pos: 13, end: 16,
      startPosition: { line: 0, character: 13 },
      endPosition: { line: 0, character: 16 },
      code: 4094,
      text: "Property 'bar' of exported anonymous class type may not be private or protected.",
    });
    const semanticFake = fakeApi({
      raw: { noEmit: true, declaration: true },
      diagnosticsFor: (files) => ({
        semantic: [diagnostic({ fileName: files[0]!, code: 2322, text: "type error" })],
      }),
      onDeclaration: () => { declarationCalls++; },
    });
    const semanticAdapter = new Ts7ApiAdapter({ api: semanticFake.api });
    try {
      const semanticFailure = await semanticAdapter.check(input([{ path: "a.ts", text: "export const foo = class { private bar = 1; };\nconst x: string = 1;\n" }], ["--noEmit", "--declaration"]));
      expect(semanticFailure.status).toBe("ok");
      expect(semanticFailure.diagnostics.map((d) => d.code)).toEqual([2322]);
      expect(declarationCalls).toBe(0);
    } finally {
      await semanticAdapter.close();
    }

    const cleanFake = fakeApi({
      raw: { noEmit: true, declaration: true },
      diagnosticsFor: (files) => ({ declaration: [decl(files[0]!)] }),
      onDeclaration: () => { declarationCalls++; },
    });
    const cleanAdapter = new Ts7ApiAdapter({ api: cleanFake.api });
    try {
      const clean = await cleanAdapter.check(input([{ path: "b.ts", text: "export const foo = class { private bar = 1; };\n" }], ["--noEmit", "--declaration"]));
      expect(clean.status).toBe("ok");
      expect(clean.diagnostics).toMatchObject([{
        file: "b.ts", line: 0, col: 13, end: { line: 0, col: 16 }, width: 3, code: 4094,
      }]);
      expect(clean.fullText).toBe("b.ts(1,14): error TS4094: Property 'bar' of exported anonymous class type may not be private or protected.");
      expect(declarationCalls).toBe(1);
    } finally {
      await cleanAdapter.close();
    }

    const noMethod = fakeApi({ diagnosticsFor: () => ({}), omitDeclarationMethod: true });
    const pinned = new Ts7ApiAdapter({ api: noMethod.api });
    try {
      const outcome = await pinned.check(input([{ path: "a.ts", text: "export const foo = class { private bar = 1; };\n" }], ["--noEmit", "--declaration"]));
      expect(outcome.status).toBe("crash");
      expect(outcome.skipReason).toContain("执行失败");
      expect(outcome.message).toContain("getDeclarationDiagnostics");
    } finally {
      await pinned.close();
    }
  });

  test("同一方法的同形诊断保留重数（不去重）", async () => {
    const fake = fakeApi({
      diagnosticsFor: (files) => {
        const fileName = files[0]!;
        const d = diagnostic({ fileName, pos: 6, end: 7, startPosition: { line: 0, character: 6 }, code: 2322, text: "Type 'number' is not assignable to type 'string'." });
        // AST/API 不保证诊断数组内无重复；没有 CLI 输出作证据时不能擅自合并。
        return { semantic: [d, { ...d }] };
      },
    });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const outcome = await adapter.check(input([{ path: "a.ts", text: "const x: string = 1;\n" }], ["--noEmit"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(2);
      expect(outcome.fullText).toBe(
        [
          "a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.",
          "a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.",
        ].join("\n"),
      );
    } finally {
      await adapter.close();
    }
  });

  test("无文件位置的诊断不能被当成零诊断", async () => {
    const fake = fakeApi({
      diagnosticsFor: () => ({}),
      parseErrors: [diagnostic({ fileName: undefined, pos: 0, end: 0, startPosition: undefined, code: 5023, text: "Unknown compiler option '--bogus'." })],
    });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const outcome = await adapter.check(input([{ path: "a.ts", text: "const x = 1;\n" }], ["--noEmit", "--bogus"]));
      expect(outcome.status).toBe("skip");
      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.skipReason).toContain("无文件位置");
      expect(outcome.message).toContain("TS5023");
    } finally {
      await adapter.close();
    }
  });

  test("pos/end 不作为 width 依据：width 只按 UTF-16 字符列计算，跨行跨度缺省", async () => {
    const fake = fakeApi({
      diagnosticsFor: (files) => ({
        semantic: [
          diagnostic({
            fileName: files[0]!,
            pos: 32,
            end: 39,
            startPosition: { line: 0, character: 26 },
            endPosition: { line: 0, character: 27 },
            text: "same-line",
          }),
          diagnostic({
            fileName: files[0]!,
            pos: 0,
            end: 10,
            startPosition: { line: 0, character: 4 },
            endPosition: { line: 1, character: 2 },
            text: "multi-line",
          }),
          diagnostic({
            fileName: files[0]!,
            pos: 0,
            end: 2,
            startPosition: { line: 0, character: 4 },
            endPosition: { line: 0, character: 6 },
            text: "utf16 span",
          }),
        ],
      }),
    });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const outcome = await adapter.check(input([{ path: "a.ts", text: "const s = '😀😀😀'; const x: string = 1;\n" }], ["--noEmit"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics.map((d) => d.message)).toEqual(["same-line", "multi-line", "utf16 span"]);
      // pos/end 的差与 UTF-16 列差/UTF-8 字节差都不绑定；width 只取列差。
      expect(outcome.diagnostics[0]!.width).toBe(1);
      expect(outcome.diagnostics[2]!.width).toBe(2);
      // 跨行不猜宽度。
      expect(outcome.diagnostics[1]!.width).toBeUndefined();
      expect(outcome.diagnostics[1]!.end).toEqual({ line: 1, col: 2 });
    } finally {
      await adapter.close();
    }
  });

  test("rootDir/typeRoots 相对路径按用例临时目录重定基，绝对路径不变，API 仍复用", async () => {
    const fake = fakeApi({ diagnosticsFor: () => ({}) });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const first = await adapter.check(input([{ path: "a.ts", text: "export const a = 1;\n" }], [
        "--noEmit", "--rootDir", "src", "--typeRoots", "types,extra", "--outDir", "dist",
      ]));
      expect(first.status).toBe("ok");
      const firstOptions = fake.lastOptions()!;
      const tempRoot = String(firstOptions.rootDir).slice(0, -"/src".length);
      expect(tempRoot).toContain("tsc-compa-ts7-api-");
      expect(firstOptions).toMatchObject({
        rootDir: `${tempRoot}/src`,
        typeRoots: [`${tempRoot}/types`, `${tempRoot}/extra`],
        outDir: `${tempRoot}/dist`,
      });

      const absolute = await adapter.check(input([{ path: "b.ts", text: "export const b = 1;\n" }], [
        "--noEmit", "--rootDir", "/shared/src", "--typeRoots", "/shared/types",
      ]));
      expect(absolute.status).toBe("ok");
      expect(fake.lastOptions()).toMatchObject({ rootDir: "/shared/src", typeRoots: ["/shared/types"] });
      expect(fake.parseCalls()).toBe(2);
      expect(fake.createCalls()).toBe(2);
    } finally {
      await adapter.close();
    }
  });

  test("project 与不可在 API 单案中复现的模式显式 skip，不创建 program", async () => {
    const fake = fakeApi({ diagnosticsFor: () => ({}) });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      for (const args of [
        ["--noEmit", "--project", "."],
        ["--noEmit", "-p", "."],
        ["--noEmit", "--watch"],
        ["--noEmit", "-w"],
        ["--build", "."],
        ["--init"],
        ["--showConfig"],
        ["--listFilesOnly"],
        ["--help"],
        ["--version"],
      ]) {
        const outcome = await adapter.check(input([{ path: "a.ts", text: "export const a = 1;\n" }], args));
        expect(outcome.status).toBe("skip");
        expect(outcome.skipReason).toContain("不支持");
      }
      expect(fake.parseCalls()).toBe(0);
      expect(fake.createCalls()).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  test("只有 warning 时退出码为 undefined，related 缺位置时保留其余字段", async () => {
    const fake = fakeApi({
      diagnosticsFor: (files) => ({
        semantic: [
          diagnostic({
            fileName: files[0]!,
            pos: 1,
            end: 2,
            startPosition: { line: 0, character: 1 },
            code: 6133,
            category: 0,
            reportsUnnecessary: true,
            reportsDeprecated: true,
            text: "'x' is declared but its value is never read.",
            relatedInformation: [{ fileName: undefined, pos: 0, end: 0, startPosition: undefined, code: 2728, category: 3, text: "declared here" }],
          }),
        ],
      }),
    });
    const adapter = new Ts7ApiAdapter({ api: fake.api });
    try {
      const outcome = await adapter.check(input([{ path: "a.ts", text: "const x = 1;\n" }], ["--noEmit"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.exitCode).toBeUndefined();
      expect(outcome.diagnostics[0]).toMatchObject({
        severity: "warning",
        related: [{ code: 2728, message: "declared here" }],
        attributes: { reportsUnnecessary: true, reportsDeprecated: true },
      });
      expect(outcome.diagnostics[0]!.related![0]!.file).toBeUndefined();
      expect(outcome.diagnostics[0]!.related![0]!.line).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});

describe("Ts7ApiAdapter（真实 TS7 async API）", () => {
  test("结构化 chain/related/width 与 formatDiagnostics fullText", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tsc-compa-ts7-api-test-"));
    const adapter = new Ts7ApiAdapter({ cwd });
    try {
      const outcome = await adapter.check(input([
        {
          path: "chain.ts",
          text: [
            "interface A { a: string }",
            "interface B { b: number }",
            "declare const x: A | B;",
            "x.a;",
          ].join("\n"),
        },
        {
          path: "related.ts",
          text: "export default class C {\n}\nexport default class C {\n}\n",
        },
      ], ["--noEmit", "--skipDefaultLibCheck", "--strict", "true"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.exitCode).toBeUndefined();
      const chain = outcome.diagnostics.find((d) => d.code === 2339);
      expect(chain).toMatchObject({
        file: "chain.ts",
        line: 3,
        col: 2,
        width: 1,
        message: "Property 'a' does not exist on type 'A | B'.",
        messageChain: { text: "Property 'a' does not exist on type 'A | B'.", children: [{ text: "Property 'a' does not exist on type 'B'." }] },
      });
      expect(chain!.attributes).toEqual({});
      expect(chain!.related).toEqual([]);
      expect(chain!.fullText).toBe(
        [
          "chain.ts(4,3): error TS2339: Property 'a' does not exist on type 'A | B'.",
          "  Property 'a' does not exist on type 'B'.",
        ].join("\n"),
      );

      const related = outcome.diagnostics.filter((d) => d.code === 2528);
      expect(related).toHaveLength(2);
      expect(related.map((d) => d.related?.[0]?.code)).toEqual([2753, 2752]);
      for (const d of related) {
        expect(d.file).toBe("related.ts");
        expect(d.width).toBe(1);
        expect(d.messageChain).toBeNull();
        expect(d.attributes).toEqual({});
        expect(d.related?.[0]?.file).toBe("related.ts");
        expect(d.related?.[0]?.line).toBe(related[0] === d ? 2 : 0);
        expect(d.related?.[0]?.col).toBe(21);
      }
      expect(outcome.fullText!.split("\n")).toEqual([
        "chain.ts(4,3): error TS2339: Property 'a' does not exist on type 'A | B'.",
        "  Property 'a' does not exist on type 'B'.",
        "related.ts(1,22): error TS2528: A module cannot have multiple default exports.",
        "related.ts(3,22): error TS2528: A module cannot have multiple default exports.",
      ]);
    } finally {
      await adapter.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("真实 API：非 ASCII 前缀后仍用 startPosition 的字符列算 width", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tsc-compa-ts7-api-test-"));
    const adapter = new Ts7ApiAdapter({ cwd });
    try {
      const outcome = await adapter.check(input([
        { path: "unicode.ts", text: "const s = '😀😀😀'; const x: string = 1;\n" },
      ], ["--noEmit"]));
      expect(outcome.status).toBe("ok");
      expect(outcome.diagnostics).toHaveLength(1);
      const d = outcome.diagnostics[0]!;
      expect(d).toMatchObject({ file: "unicode.ts", line: 0, col: 26, width: 1, code: 2322 });
      expect(d.fullText).toBe("unicode.ts(1,27): error TS2322: Type 'number' is not assignable to type 'string'.");
      expect("exitCode" in outcome).toBe(false);
    } finally {
      await adapter.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("真实 API：--declaration 在 noEmitOnError=false 时保留 semantic 与 TS4094", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tsc-compa-ts7-api-test-"));
    const adapter = new Ts7ApiAdapter({ cwd, extraArgs: [] });
    try {
      const both = await adapter.check(input([
        { path: "both.ts", text: "export const foo = class { private bar = 1; };\nconst x: string = 1;\n" },
      ], ["--noEmit", "false", "--declaration", "--noEmitOnError", "false"]));
      expect(both.status).toBe("ok");
      // API 方法各自的返回顺序是 semantic、declaration；CLI 汇合后会按位置排序，
      // 因此这里只断言 API 原序，另用 CLI 口径断言汇合后的预期顺序。
      expect(both.diagnostics.map((d) => d.code)).toEqual([2322, 4094]);
      expect(both.fullText).toBe(
        [
          "both.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.",
          "both.ts(1,14): error TS4094: Property 'bar' of exported anonymous class type may not be private or protected.",
        ].join("\n"),
      );
      expect([...both.diagnostics].sort((a, b) => a.line - b.line || a.col - b.col).map((d) => d.code))
        .toEqual([4094, 2322]);

      const noEmit = await adapter.check(input([
        { path: "noemit.ts", text: "export const foo = class { private bar = 1; };\nconst x: string = 1;\n" },
      ], ["--noEmit", "true", "--declaration", "--noEmitOnError", "false"]));
      expect(noEmit.status).toBe("ok");
      expect(noEmit.diagnostics.map((d) => d.code)).toEqual([2322]);
      expect(noEmit.fullText).toBe("noemit.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.");

      const gated = await adapter.check(input([
        { path: "gated.ts", text: "export const foo = class { private bar = 1; };\nconst x: string = 1;\n" },
      ], ["--noEmit", "false", "--declaration", "--noEmitOnError", "true"]));
      expect(gated.status).toBe("ok");
      expect(gated.diagnostics.map((d) => d.code)).toEqual([2322]);
      expect(gated.fullText).toBe("gated.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.");
    } finally {
      await adapter.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("语法错误对齐 CLI：不继续产出 semantic；clean 例返回空 fullText", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tsc-compa-ts7-api-test-"));
    const adapter = new Ts7ApiAdapter({ cwd });
    try {
      const syntax = await adapter.check(input([
        { path: "b.ts", text: "const = 2;\n" },
        { path: "a.ts", text: "const a: string = 1;\n" },
      ], ["--noEmit"]));
      expect(syntax.status).toBe("ok");
      expect(syntax.exitCode).toBeUndefined();
      expect(syntax.diagnostics.map((d) => d.code)).toEqual([1134, 1134]);
      expect(syntax.fullText).toBe(
        [
          "b.ts(1,7): error TS1134: Variable declaration expected.",
          "b.ts(1,9): error TS1134: Variable declaration expected.",
        ].join("\n"),
      );

      const clean = await adapter.check(input([{ path: "clean.ts", text: "const x: string = 'ok';\n" }], ["--noEmit"]));
      expect(clean.status).toBe("ok");
      expect(clean.exitCode).toBeUndefined();
      expect(clean.diagnostics).toEqual([]);
      expect(clean.fullText).toBe("");
    } finally {
      await adapter.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
