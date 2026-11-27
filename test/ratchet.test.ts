import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CaseRecord, Tier } from "../src/compare.ts";
import {
  checkRatchet,
  checkRatchetState,
  legacyRatchetResult,
  protectedCountsOf,
  ratchetPathFor,
  readRatchet,
  readRatchetState,
  serializeRatchet,
  serializeRatchetState,
  writeRatchet,
  writeRatchetState,
  type RatchetState,
  type RatchetStateEntry,
} from "../src/ratchet.ts";
import type { DiagnosticComparison } from "../src/comparison.ts";

function record(id: string, tier: Tier, status: "ran" | "skip" = "ran"): CaseRecord {
  return {
    id,
    status,
    classes: [],
    expected: [],
    actual: [],
    comparison: null,
    expectedOutput: null,
    actualOutput: null,
    expectedExitCode: null,
    actualExitCode: null,
    fp: [],
    missed: [],
    hits: 0,
    misanchor: 0,
    tier: status === "skip" ? "none" : tier,
  };
}

describe("checkRatchet", () => {
  test("改善写回、回落报错；T3 full 归一为 text", () => {
    const previous = new Map<string, Tier>([
      ["a.ts", "location"],
      ["b.ts", "text"],
    ]);
    const check = checkRatchet(previous, [record("a.ts", "text"), record("b.ts", "location"), record("c.ts", "full")]);
    expect(check.improvements.map((i) => `${i.id}:${i.now}`)).toEqual(["a.ts:text", "c.ts:text"]);
    expect(check.regressions.map((r) => `${r.id}:${r.was}->${r.now}`)).toEqual(["b.ts:text->location"]);
    expect(check.next.get("a.ts")).toBe("text");
    expect(check.next.get("b.ts")).toBe("text"); // 只升不降：回落不写回
    expect(check.changed).toBe(true);
  });

  test("T3 不参与门禁：full → text 不算回落，text → category 才算", () => {
    const previous = new Map<string, Tier>([["a.ts", "full"]]);
    // 实现从 full 掉到 text：T3 是报告档，不判红
    const dropT3 = checkRatchet(previous, [record("a.ts", "text")]);
    expect(dropT3.regressions).toEqual([]);
    expect(dropT3.improvements).toEqual([]);
    expect(dropT3.next.get("a.ts")).toBe("text"); // 旧 full 归一为 text
    expect(dropT3.changed).toBe(true); // 旧清单里的 full 需要归一写回（不是回落）
    // 掉到 category（T1）：属于门禁档回落
    const dropGate = checkRatchet(previous, [record("a.ts", "category")]);
    expect(dropGate.regressions.map((r) => `${r.was}->${r.now}`)).toEqual(["text->category"]);
  });

  test("先前登记的用例本次变成 skip 视为回落（档位按门禁档报告）", () => {
    const previous = new Map<string, Tier>([["a.ts", "full"]]);
    const check = checkRatchet(previous, [record("a.ts", "none", "skip")]);
    expect(check.regressions.length).toBe(1);
    expect(check.regressions[0]!.was).toBe("text");
    expect(check.regressions[0]!.now).toBe("none");
    expect(check.regressions[0]!.reason).toContain("跳过");
  });

  test("未达 location 的新用例不入清单", () => {
    const check = checkRatchet(new Map(), [record("a.ts", "none"), record("b.ts", "category")]);
    expect(check.improvements.map((i) => i.id)).toEqual(["b.ts"]);
    expect(check.next.has("a.ts")).toBe(false);
  });

  test("已登记的用例未进入结果时视为回落", () => {
    const previous = new Map<string, Tier>([["a.ts", "text"], ["b.ts", "category"]]);
    const check = checkRatchet(previous, [record("b.ts", "category")]);
    expect(check.regressions).toEqual([
      { id: "a.ts", was: "text", now: "none", reason: "未进入本次执行范围" },
    ]);
    expect(check.next).toEqual(previous);
  });

  test("清单读写往返（含注释与排序；full 归一为 text）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-ratchet-"));
    try {
      const path = join(dir, "r.tsv");
      writeRatchet(
        path,
        new Map<string, Tier>([
          ["z.ts", "full"],
          ["a.ts", "location"],
        ]),
      );
      const read = readRatchet(path);
      expect([...read.entries()]).toEqual([
        ["a.ts", "location"],
        ["z.ts", "text"],
      ]);
      expect(serializeRatchet(read)).toContain("z.ts\ttext");

      // 旧口径的 full 清单读入即归一为 text
      writeFileSync(path, "# 旧清单\na.ts\tfull\n");
      expect(readRatchet(path).get("a.ts")).toBe("text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("按实现分账（ratchet per impl）", () => {
  test("首次接入：空清单只登记当前门禁档位、不产生回落", () => {
    const check = checkRatchet(new Map(), [record("a.ts", "full"), record("b.ts", "none"), record("c.ts", "none", "skip")]);
    expect(check.regressions).toEqual([]);
    expect([...check.next.entries()]).toEqual([["a.ts", "text"]]);
    expect(check.changed).toBe(true);
  });

  test("分账隔离：实现 A 的回落不影响实现 B 的清单", () => {
    const implB = new Map<string, Tier>([["a.ts", "text"]]);
    const checkA = checkRatchet(new Map<string, Tier>([["a.ts", "full"]]), [record("a.ts", "location")]);
    const checkB = checkRatchet(implB, [record("a.ts", "full")]);
    expect(checkA.regressions.length).toBe(1);
    expect(checkB.regressions).toEqual([]);
    expect(checkB.next.get("a.ts")).toBe("text");
    expect(implB.get("a.ts")).toBe("text"); // 输入清单不被就地修改
  });

  test("ratchetPathFor：按实现 × 基线推导路径并做文件名安全化", () => {
    expect(ratchetPathFor("tsrs", "7.1.0-beta-official")).toBe(join("config", "ratchet", "tsrs-7.1.0-beta-official.tsv"));
    expect(ratchetPathFor("impl A/b", "7.1 beta")).toBe(join("config", "ratchet", "impl_A_b-7.1_beta.tsv"));
  });
});


describe("v2 两档与逐字段 ratchet", () => {
  const comparison = (patch: Partial<DiagnosticComparison> = {}): DiagnosticComparison => ({
    compatibility: "pass",
    strict: "pass",
    fields: {
      code: "equal", severity: "equal", location: "equal", width: "equal",
      message: "equal", messageChain: "equal", related: "equal", attributes: "equal",
      count: "equal", order: "equal", output: "equal",
    },
    matches: [],
    positionDifferences: [],
    missing: [],
    extraErrors: [],
    extraWarnings: [],
    unclassified: [],
    unresolved: { expected: [], actual: [] },
    ...patch,
  });
  const compared = (id: string, value: DiagnosticComparison | null): CaseRecord => ({
    ...record(id, "none"),
    comparison: value,
  });
  const entry = (patch: Partial<DiagnosticComparison> = {}) => {
    const value = comparison(patch);
    return { compatibility: value.compatibility, strict: value.strict, fields: value.fields };
  };

  test("strict pass 跌到仅兼容：记录 strict 回归，兼容保护不阻断", () => {
    const previous: RatchetState = new Map([["a.ts", entry()]]);
    const current = comparison({ strict: "fail", fields: { ...comparison().fields, message: "different" } });
    const check = checkRatchetState(previous, [compared("a.ts", current)]);
    expect(check.regressions.map((r) => [r.kind, r.field, r.was, r.now])).toEqual([
      ["strict", undefined, "pass", "fail"],
      ["field", "message", "equal", "different"],
    ]);
    expect(check.next.get("a.ts")!.strict).toBe("pass");
    expect(check.next.get("a.ts")!.fields.message).toBe("equal");
    expect(check.changed).toBe(false);
  });

  test("兼容 pass 跌到 fail：产生兼容回归；未验证的 strict 不被虚构为回归", () => {
    const previous: RatchetState = new Map([["a.ts", {
      compatibility: "pass", strict: "unknown", fields: {
        ...comparison().fields,
        code: "unavailable", severity: "unavailable", location: "unavailable", width: "unavailable",
        message: "unavailable", messageChain: "unavailable", related: "unavailable", attributes: "unavailable",
        count: "unavailable", order: "unavailable", output: "unavailable",
      },
    }]]);
    const check = checkRatchetState(previous, [compared("a.ts", comparison({ compatibility: "fail", strict: "fail" }))]);
    expect(check.regressions.map((r) => r.kind)).toEqual(["compatibility"]);
    expect(check.next.get("a.ts")!.strict).toBe("fail");
  });

  test("严格退到仅兼容在 compatibility profile 中仍被识别为回归", () => {
    const previous: RatchetState = new Map([["a.ts", entry()]]);
    const check = checkRatchetState(previous, [compared("a.ts", comparison({ strict: "unknown" }))]);
    expect(check.regressions).toEqual([
      expect.objectContaining({ id: "a.ts", kind: "strict", was: "pass", now: "unknown" }),
    ]);
  });

  test("未验证字段变 different 不算回归；已验证 equal 缺证才算", () => {
    const partial: RatchetStateEntry = {
      compatibility: "pass" as const, strict: "unknown" as const, fields: {
        ...comparison().fields, message: "unavailable",
      },
    };
    const check = checkRatchetState(new Map([["a.ts", partial]]), [
      compared("a.ts", comparison({ fields: { ...comparison().fields, message: "different" } })),
    ]);
    expect(check.regressions).toEqual([]);
    const missingField = checkRatchetState(new Map([["a.ts", entry()]]), [compared("a.ts", null)]);
    expect(missingField.regressions.some((r) => r.kind === "field" && r.field === "message")).toBe(true);
  });

  test("跳过、移出范围和比较缺失都按“已证状态变未确认”处理", () => {
    const previous: RatchetState = new Map([["a.ts", entry()]]);
    const skipped = checkRatchetState(previous, [record("a.ts", "none", "skip")]);
    expect(skipped.regressions).toHaveLength(13);
    expect(skipped.regressions.every((r) => r.reasonKind === "skip")).toBe(true);
    const scope = checkRatchetState(previous, []);
    expect(scope.regressions.map((r) => r.reasonKind).every((k) => k === "out-of-scope")).toBe(true);
    expect(scope.next).toEqual(previous);
  });

  test("非 gate 更新不降级历史保护；strict 变差也不覆盖旧 pass", () => {
    const previous: RatchetState = new Map([["a.ts", entry()]]);
    const check = checkRatchetState(previous, [compared("a.ts", comparison({ compatibility: "fail", strict: "fail" }))]);
    expect(check.regressions.every((r) => r.reasonKind === "comparison")).toBe(true);
    expect(check.next.get("a.ts")).toEqual(entry());
    expect(check.changed).toBe(false);
  });

  test("旧两列 TSV 迁移：compatibility 来自旧分级，strict/字段不虚构", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-ratchet-v2-"));
    try {
      const path = join(dir, "r.tsv");
      writeFileSync(path, "# old\na.ts\ttext\nb.ts\tfull\nc.ts\tnone\n");
      const state = readRatchetState(path);
      expect(state.get("a.ts")).toEqual({
        compatibility: "pass", strict: "unknown",
        fields: {
          code: "unavailable", severity: "unavailable", location: "unavailable", width: "unavailable",
          message: "unavailable", messageChain: "unavailable", related: "unavailable", attributes: "unavailable",
          count: "unavailable", order: "unavailable", output: "unavailable",
        },
        legacyTier: "text",
      });
      expect(state.get("b.ts")!.legacyTier).toBe("full");
      expect(state.get("c.ts")!.compatibility).toBe("unknown");
      writeRatchetState(path, state);
      expect(readFileSync(path, "utf8")).toContain("a.ts\tpass\tunknown\t");
      expect(readRatchetState(path)).toEqual(state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("首次达到 pass 或由 fail 改善时写回", () => {
    const failed: RatchetState = new Map([["a.ts", {
      compatibility: "fail", strict: "unknown", fields: entry().fields,
    }]]);
    const check = checkRatchetState(failed, [compared("a.ts", comparison())]);
    expect(check.next.get("a.ts")!.compatibility).toBe("pass");
    expect(check.next.get("a.ts")!.strict).toBe("pass");
    expect(check.improvements.map((i) => i.kind)).toEqual(["compatibility", "strict"]);
  });

  test("序列化稳定、字段完整且可回读", () => {
    const state: RatchetState = new Map<string, RatchetStateEntry>([
      ["z.ts", entry({ strict: "fail" })],
      ["a.ts", { ...entry(), legacyTier: "text" }],
    ]);
    const text = serializeRatchetState(state);
    expect(text.indexOf("a.ts\t")).toBeLessThan(text.indexOf("z.ts\t"));
    expect(text).toContain("message=equal");
    expect(text).toContain("a.ts\tpass\tpass\t");
    expect(text).toContain("\tlegacy=text");
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-ratchet-v2-"));
    try {
      const path = join(dir, "r.tsv");
      writeFileSync(path, text);
      expect(readRatchetState(path)).toEqual(state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("旧 TSV 回落可桥接到 v2 compatibility 维度", () => {
    const previous = new Map<string, Tier>([["a.ts", "text"]]);
    const check = checkRatchet(previous, [record("a.ts", "none")]);
    const bridged = legacyRatchetResult("old.tsv", previous, check);
    expect(bridged.registered).toBe(1);
    expect(bridged.stateRegressions).toEqual([
      expect.objectContaining({ id: "a.ts", kind: "compatibility", was: "pass", now: "unknown" }),
    ]);
  });

  test("protected 计数只把已有 pass 历史计入，旧 TSV 不贡献 strict", () => {
    const state = new Map<string, RatchetStateEntry>([
      ["a.ts", { compatibility: "pass", strict: "unknown", fields: entry().fields }],
      ["b.ts", { compatibility: "fail", strict: "pass", fields: entry().fields }],
      ["c.ts", { compatibility: "unknown", strict: "unknown", fields: entry().fields }],
    ]);
    expect(protectedCountsOf(state)).toEqual({ compatibility: 1, strict: 1 });
  });

});
