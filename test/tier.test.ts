import { describe, expect, test } from "bun:test";
import { renderErrorBlock, tierOf } from "../src/compare.ts";
import type { Diagnostic } from "../src/types.ts";

function diag(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    file: "a.ts",
    line: 0,
    col: 0,
    code: 2322,
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    ...overrides,
  };
}

describe("tierOf（T0~T3 官方基线一致性）", () => {
  test("位置+码一致、文案也一致 → text（没有基线原文时 T3 不可评）", () => {
    expect(tierOf([diag()], [diag()], null)).toBe("text");
  });

  test("渲染文本与官方基线摘要块字节一致 → full", () => {
    const baseline = `${renderErrorBlock([diag()])}\n\n\n==== a.ts (1 errors) ====\n`;
    expect(tierOf([diag()], [diag()], baseline)).toBe("full");
  });

  test("基线注释外多一个 elaboration 行（实现没有）→ text（T3 失败）", () => {
    const baseline = `${renderErrorBlock([diag()])}\n  elaboration line\n\n==== a.ts (1 errors) ====\n`;
    expect(tierOf([diag()], [diag()], baseline)).toBe("text");
  });

  test("位置同、文案不同 → category", () => {
    expect(tierOf([diag()], [diag({ message: "different wording" })], null)).toBe("category");
  });

  test("severity 不同 → location", () => {
    expect(tierOf([diag()], [diag({ severity: "warning" })], null)).toBe("location");
  });

  test("缺一条诊断 → none", () => {
    expect(tierOf([diag(), diag({ line: 3 })], [diag()], null)).toBe("none");
  });

  test("两侧都为空且无基线文件 → full（无期望错误且实现沉默）", () => {
    expect(tierOf([], [], null)).toBe("full");
  });

  test("两侧都为空但有基线文件（0 errors 基线）→ full", () => {
    expect(tierOf([], [], "==== a.ts (0 errors) ====\n")).toBe("full");
  });
});
