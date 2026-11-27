import { expect, test } from "bun:test";
import { compareDiagnostics } from "../src/comparison.ts";
import type { Diagnostic } from "../src/types.ts";

const d = (patch: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "input.ts", line: 0, col: 4, code: 2339, severity: "error",
  width: 1, message: "Property does not exist.", messageChain: null, related: [], attributes: {}, ...patch,
});
const outputs = { expectedOutput: "diagnostic", actualOutput: "diagnostic" };
const equivalentCodes = [[2339, 2551]];

test("matched severity changes, equivalent codes, messages and widths are independent", () => {
  const result = compareDiagnostics([d()], [d({ code: 2551, severity: "warning", message: "Did you mean x?", width: 2 })], { equivalentCodes });
  expect(result.compatibility).toBe("pass");
  expect(result.strict).toBe("fail");
  expect(result.fields).toMatchObject({ code: "different", severity: "different", message: "different", width: "different", location: "equal" });
  expect(result.missing).toEqual([]);
  expect(compareDiagnostics([d()], [d({ code: 2551 })]).compatibility).toBe("fail");
});

test("compatibility absorbs a candidate error before a redundant warning even with an equivalent code", () => {
  const warning = d({ severity: "warning" });
  const error = d({ code: 2551 });
  for (const candidates of [[warning, error], [error, warning]]) {
    const result = compareDiagnostics([d()], candidates, { equivalentCodes });
    expect(result.compatibility).toBe("pass");
    expect(result.strict).toBe("fail");
    expect(result.extraErrors).toEqual([]);
    expect(result.extraWarnings).toEqual([candidates.indexOf(warning)]);
  }
});

test("duplicate diagnostics require independent matches", () => {
  const result = compareDiagnostics([d(), d()], [d()], outputs);
  expect(result.matches).toHaveLength(1);
  expect(result.missing).toHaveLength(1);
  expect(result.compatibility).toBe("fail");
  expect(result.strict).toBe("fail");
});

test("incomplete key yields unknown only if the observed keys permit a complete covering", () => {
  const partial = d({ col: -1 });
  const result = compareDiagnostics([d()], [partial]);
  expect(result.compatibility).toBe("unknown");
  expect(result.missing).toEqual([]);
  expect(result.extraErrors).toEqual([]);
  expect(result.unresolved).toEqual({ expected: [0], actual: [0] });
  expect(compareDiagnostics([d()], [{ ...partial, code: 9876 }]).compatibility).toBe("fail");
  expect(compareDiagnostics([d(), d()], [partial]).compatibility).toBe("fail");
  expect(compareDiagnostics([d()], [d(), { ...partial, severity: "warning" }]).compatibility).toBe("pass");
});

test("one-to-one possible evidence can reassign a confirmed match to an incomplete diagnostic", () => {
  const result = compareDiagnostics([d(), d({ col: -1, code: 2551 })], [d(), d({ col: -1 })], { equivalentCodes });
  expect(result.compatibility).toBe("unknown");
  expect(compareDiagnostics([d(), d({ file: "other.ts", col: -1 })], [d(), d({ col: -1 })]).compatibility).toBe("fail");
});

test("a moved anchor is a location difference, not a match, and keeps other field differences", () => {
  const result = compareDiagnostics([d()], [d({ col: 8, message: "Different" })], outputs);
  expect(result.compatibility).toBe("fail");
  expect(result.matches).toEqual([]);
  expect(result.fields).toMatchObject({ location: "different", message: "different", code: "equal" });
  expect(result.positionDifferences).toHaveLength(1);
});

test("a message with incomplete width must not manufacture a strict failure due to matching order", () => {
  const unknownWidth = d({ width: undefined });
  const knownWidth = d();
  expect(compareDiagnostics([unknownWidth, knownWidth], [knownWidth, d({ width: 2 })], outputs).strict).toBe("fail");
  const result = compareDiagnostics([knownWidth, unknownWidth], [unknownWidth, knownWidth], outputs);
  expect(result.strict).toBe("unknown");
  expect(result.fields.width).toBe("unavailable");
  expect(result.fields.order).not.toBe("different");
});

test("order reversals are visible even with an extra warning", () => {
  const first = d();
  const second = d({ col: 5 });
  const result = compareDiagnostics([first, second], [second, first, d({ severity: "warning", col: 6 })]);
  expect(result.compatibility).toBe("pass");
  expect(result.strict).toBe("fail");
  expect(result.fields.order).toBe("different");
});

test("explicit emptiness, unavailable structure and known independently different output", () => {
  expect(compareDiagnostics([], [], { expectedOutput: "", actualOutput: "" }).strict).toBe("pass");
  expect(compareDiagnostics([], []).strict).toBe("unknown");
  expect(compareDiagnostics([d()], [d()], outputs).strict).toBe("pass");
  expect(compareDiagnostics([d()], [d({ related: undefined })], outputs).strict).toBe("unknown");
  expect(compareDiagnostics([d()], [d({ related: undefined })], { ...outputs, actualOutput: "visible difference" }).strict).toBe("fail");
  const r = (width?: number) => d({ related: [{ file: "input.ts", line: 0, col: 0, width, code: 23, message: "related" }] });
  expect(compareDiagnostics([r(1)], [r()], outputs).fields.related).toBe("unavailable");
  expect(compareDiagnostics([r(1)], [r(2)], outputs).fields.related).toBe("different");
});

test("swapping duplicate anchors affects order, not severity in either direction", () => {
  const error = d();
  const warning = d({ severity: "warning" });
  for (const [e, a] of [[[error, warning], [warning, error]], [[warning, error], [error, warning]]] as const) {
    const result = compareDiagnostics([...e], [...a], outputs);
    expect(result.compatibility).toBe("pass");
    expect(result.strict).toBe("fail");
    expect(result.fields).toMatchObject({ severity: "equal", order: "different" });
  }
});

test("multiline end positions and nested diagnostic metadata affect strict fields", () => {
  const messageChain = { text: "chain", code: 100, category: 1, attributes: {}, children: [] };
  const related = { file: "input.ts", line: 0, col: 0, end: { line: 1, col: 1 }, code: 123,
    category: 1, message: "related", attributes: {}, messageChain: null };
  const expected = d({ width: undefined, end: { line: 1, col: 2 }, messageChain, related: [related] });
  expect(compareDiagnostics([expected], [expected], outputs).strict).toBe("pass");
  const actual = d({ ...expected, end: { line: 2, col: 2 }, messageChain: { ...messageChain, category: 3 }, related: [{ ...related, code: 234 }] });
  const result = compareDiagnostics([expected], [actual], outputs);
  expect(result.compatibility).toBe("pass");
  expect(result.strict).toBe("fail");
  expect(result.fields).toMatchObject({ width: "different", messageChain: "different", related: "different", location: "equal" });
});
