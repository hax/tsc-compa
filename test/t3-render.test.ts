// T3「整份 .errors.txt 字节相等」：多行阐述渲染、基线摘要块切分与失败归因。

import { describe, expect, test } from "bun:test";
import { classifyT3Diff, compareCase, renderErrorBlock, tierOf } from "../src/compare.ts";
import { parseTscOutputDetailed } from "../src/adapters/tsc-cli.ts";
import type { Diagnostic } from "../src/types.ts";

const diag = (extra: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "a.ts",
  line: 0,
  col: 0,
  code: 2322,
  severity: "error",
  message: "Type 'string' is not assignable to type 'number'.",
  ...extra,
});

const FIRST = "a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.";
/** 官方基线常见形态：摘要块 + 空行 + `====` 用例正文（正文有源码与标注，不属于诊断文本）。 */
const REAL_BASELINE = [
  FIRST,
  "  Types of property 'x' are incompatible.",
  "    Type 'string' is not assignable to type 'number'.",
  "",
  "",
  "==== a.ts (1 errors) ====",
  "    const v: number = 's';",
  "                     ~~~",
  "!!! error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
].join("\n");

describe("parseTscOutputDetailed（多行阐述与顺序）", () => {
  test("保留续行、重建首行路径、剔除临时目录之外的诊断及其续行", () => {
    const tmp = "/tmp/compa-x";
    const text = [
      `${tmp}/b.ts(2,3): error TS2322: msg b`,
      "  elaboration one",
      "    deeper elaboration",
      `/opt/lib/lib.es5.d.ts(1,1): error TS2314: lib error`,
      "  lib elaboration（应随 lib 诊断一起丢弃）",
      `${tmp}/a.ts(1,1): error TS2322: msg a`,
      "  elaboration a",
      "",
    ].join("\n");
    const parsed = parseTscOutputDetailed(tmp, text);
    expect(parsed.diagnostics.map((d) => d.file)).toEqual(["b.ts", "a.ts"]);
    expect(parsed.diagnostics[0]!.fullText).toBe(
      ["b.ts(2,3): error TS2322: msg b", "  elaboration one", "    deeper elaboration"].join("\n"),
    );
    expect(parsed.rendered).toBe(
      [
        "b.ts(2,3): error TS2322: msg b",
        "  elaboration one",
        "    deeper elaboration",
        "a.ts(1,1): error TS2322: msg a",
        "  elaboration a",
      ].join("\n"),
    );
  });
  test("无诊断时 rendered 为空串", () => {
    const parsed = parseTscOutputDetailed("/tmp/empty", "Files: 1\nCheck time: 0.1s\n");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.rendered).toBe("");
  });
});

describe("renderErrorBlock", () => {
  test("诊断带 fullText 时原样使用（含续行）", () => {
    const d = diag({ fullText: `${FIRST}\n  continuation` });
    expect(renderErrorBlock([d])).toBe(`${FIRST}\n  continuation`);
  });
  test("缺少 fullText 时只渲染首行（只能到 T2）", () => {
    expect(renderErrorBlock([diag()])).toBe(FIRST);
  });
});

describe("tierOf（T3 摘要块比较）", () => {
  test("真实基线（含 ==== 用例正文）只比较摘要块：完全一致 = full", () => {
    expect(tierOf([diag()], [diag()], REAL_BASELINE, renderErrorBlock([diag({ fullText: `${FIRST}\n  Types of property 'x' are incompatible.\n    Type 'string' is not assignable to type 'number'.` })]))).toBe("full");
  });
  test("实现只给首行、基线有阐述 → text（不再把 ==== 后正文算进期望）", () => {
    expect(tierOf([diag()], [diag()], REAL_BASELINE, FIRST)).toBe("text");
  });
  test("无基线文件时两侧都空 = full；实现多报 = text", () => {
    expect(tierOf([], [], null, "")).toBe("full");
    expect(tierOf([], [diag()], null, FIRST)).toBe("none");
  });
  test("actualText 缺省时退回由诊断渲染（首行）", () => {
    expect(tierOf([diag()], [diag()], `${FIRST}\n`, null)).toBe("full");
  });
});

describe("classifyT3Diff（T3 失败归因）", () => {
  const baseline = REAL_BASELINE;
  test("诊断缺失/多出/集合不同 → missing / extra / diagnostics", () => {
    expect(classifyT3Diff(baseline, "")).toBe("missing");
    expect(classifyT3Diff(baseline, `${FIRST}\n${FIRST}\n${FIRST}`)).toBe("extra");
  });
  test("诊断相同但次序不同 → order", () => {
    const b2 = `b.ts(1,1): error TS2322: second\n${FIRST}`;
    const a2 = `${FIRST}\nb.ts(1,1): error TS2322: second`;
    expect(classifyT3Diff(b2, a2)).toBe("order");
  });
  test("首行一致但阐述不同 → elaboration", () => {
    expect(classifyT3Diff(baseline, `${FIRST}\n  different elaboration`)).toBe("elaboration");
    expect(classifyT3Diff(baseline, FIRST)).toBe("elaboration");
  });
  test("related information 不同 → related", () => {
    const b = `${FIRST}\n  other.ts(2,2): error TS2724: related`;
    const a = `${FIRST}\n  other.ts(3,3): error TS2724: related`;
    expect(classifyT3Diff(b, a)).toBe("related");
  });
});

describe("compareCase（T3 归因写入 record）", () => {
  test("非 full 且存在官方基线正文时设置 t3Reason", () => {
    const r = compareCase("case.ts", [diag()], [diag()], [], REAL_BASELINE, FIRST);
    expect(r.tier).toBe("text");
    expect(r.t3Reason).toBe("elaboration");
  });
  test("无官方基线正文时不设置", () => {
    const r = compareCase("case.ts", [diag()], [diag()], [], null, null);
    expect(r.t3Reason).toBeUndefined();
  });
});
