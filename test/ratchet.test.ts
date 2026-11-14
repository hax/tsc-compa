import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CaseRecord, Tier } from "../src/compare.ts";
import { checkRatchet, ratchetPathFor, readRatchet, writeRatchet } from "../src/ratchet.ts";

function record(id: string, tier: Tier, status: "ran" | "skip" = "ran"): CaseRecord {
  return {
    id,
    status,
    classes: [],
    expected: [],
    actual: [],
    fp: [],
    missed: [],
    hits: 0,
    misanchor: 0,
    tier: status === "skip" ? "none" : tier,
  };
}

describe("checkRatchet", () => {
  test("改善写回、回落报错", () => {
    const previous = new Map<string, Tier>([
      ["a.ts", "location"],
      ["b.ts", "text"],
    ]);
    const check = checkRatchet(previous, [record("a.ts", "text"), record("b.ts", "location"), record("c.ts", "full")]);
    expect(check.improvements.map((i) => `${i.id}:${i.now}`)).toEqual(["a.ts:text", "c.ts:full"]);
    expect(check.regressions.map((r) => `${r.id}:${r.was}->${r.now}`)).toEqual(["b.ts:text->location"]);
    expect(check.next.get("a.ts")).toBe("text");
    expect(check.next.get("b.ts")).toBe("text"); // 只升不降：回落不写回
    expect(check.changed).toBe(true);
  });

  test("先前登记的用例本次变成 skip 视为回落", () => {
    const previous = new Map<string, Tier>([["a.ts", "full"]]);
    const check = checkRatchet(previous, [record("a.ts", "none", "skip")]);
    expect(check.regressions.length).toBe(1);
    expect(check.regressions[0]!.reason).toContain("跳过");
  });

  test("未达 location 的新用例不入清单", () => {
    const check = checkRatchet(new Map(), [record("a.ts", "none"), record("b.ts", "category")]);
    expect(check.improvements.map((i) => i.id)).toEqual(["b.ts"]);
    expect(check.next.has("a.ts")).toBe(false);
  });

  test("清单读写往返（含注释与排序）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsc-compa-ratchet-"));
    try {
      const path = join(dir, "r.tsv");
      writeRatchet(
        path,
        new Map<string, Tier>([
          ["z.ts", "text"],
          ["a.ts", "location"],
        ]),
      );
      const read = readRatchet(path);
      expect([...read.entries()]).toEqual([
        ["a.ts", "location"],
        ["z.ts", "text"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("按实现分账（ratchet per impl）", () => {
  test("首次接入：空清单只登记当前档位、不产生回落", () => {
    const check = checkRatchet(new Map(), [record("a.ts", "full"), record("b.ts", "none"), record("c.ts", "none", "skip")]);
    expect(check.regressions).toEqual([]);
    expect([...check.next.entries()]).toEqual([["a.ts", "full"]]);
    expect(check.changed).toBe(true);
  });

  test("分账隔离：实现 A 的回落不影响实现 B 的清单", () => {
    const implB = new Map<string, Tier>([["a.ts", "text"]]);
    const checkA = checkRatchet(new Map<string, Tier>([["a.ts", "full"]]), [record("a.ts", "location")]);
    const checkB = checkRatchet(implB, [record("a.ts", "full")]);
    expect(checkA.regressions.length).toBe(1);
    expect(checkB.regressions).toEqual([]);
    expect(checkB.next.get("a.ts")).toBe("full");
    expect(implB.get("a.ts")).toBe("text"); // 输入清单不被就地修改
  });

  test("ratchetPathFor：按实现 × 基线推导路径并做文件名安全化", () => {
    expect(ratchetPathFor("tsrs", "7.1.0-beta-official")).toBe(join("config", "ratchet", "tsrs-7.1.0-beta-official.tsv"));
    expect(ratchetPathFor("impl A/b", "7.1 beta")).toBe(join("config", "ratchet", "impl_A_b-7.1_beta.tsv"));
  });
});
