import { describe, expect, test } from "bun:test";
import { fingerprint, observe, probeEvidence, type Point } from "../scripts/version-probes.ts";
import type { CaseOutcome, Diagnostic } from "../src/types.ts";

const point: Point = ["probe.ts", 2, 3, "error", 2345];
const diag: Diagnostic = { file: "probe.ts", line: 1, col: 2, severity: "error", code: 2345 };
const ok: CaseOutcome = { id: "probe", status: "ok", exitCode: 0, diagnostics: [], fullText: "" };
const evidence = (outcome: CaseOutcome, adapter: "tsc-cli" | "bun-check" = "tsc-cli") => probeEvidence(outcome, ["probe.ts"], adapter);

describe("TS version probe observations", () => {
  test("retains file, UTF-16 position, severity, exact code and multiplicity; not wording or order", () => {
    const other: Point = ["other.ts", 1, 1, "warning", 2741];
    const actual = fingerprint([{ ...diag, message: "differs" }, { file: "other.ts", line: 0, col: 0, severity: "warning", code: 2741 }, diag]);
    expect(observe({ status: "checked", fingerprint: actual }, [other, point, point], [other, point], true)).toBe("ts6");
    expect(observe({ status: "checked", fingerprint: [point] }, [], [point], true)).toBe("ts7");
    for (const difference of [
      ["other.ts", 2, 3, "error", 2345], ["probe.ts", 2, 4, "error", 2345],
      ["probe.ts", 2, 3, "warning", 2345], ["probe.ts", 2, 3, "error", 2741],
    ] satisfies Point[]) {
      expect(observe({ status: "checked", fingerprint: [difference] }, [point], [], true)).toBe("neither");
    }
  });

  test("does not assign a version when an official anchor drifts", () => {
    expect(observe({ status: "checked", fingerprint: [] }, [], [point], false)).toBe("uncalibrated");
  });

  test("distinguishes verified empty output, unsupported and execution errors", () => {
    const empty = evidence({ ...ok, rawOutput: { stdout: "Files:    58\nCheck time:     0.001s\n" } });
    expect(empty).toMatchObject({ status: "checked", fingerprint: [] });
    expect(observe(empty, [point], [], true)).toBe("ts7");
    const bunEmpty = evidence({ ...ok, rawOutput: { stderr: "✓ No type errors in 1 file [1.2ms]\n" } }, "bun-check");
    expect(bunEmpty).toMatchObject({ status: "checked", fingerprint: [] });
    expect(evidence({ ...ok, rawOutput: { stdout: "" } }).status).toBe("execution-error");
    expect(evidence({ ...ok, rawOutput: { stderr: "✓ No type errors in 0 files\n" } }, "bun-check").status).toBe("execution-error");
    expect(observe(evidence({ ...ok, status: "skip", skipReason: "unsupported option" }), [], [point], true)).toBe("unsupported");
    for (const status of ["crash", "timeout"] as const) {
      expect(observe(evidence({ ...ok, status }), [], [point], true)).toBe("execution-error");
    }
  });

  test("refuses to fingerprint incomplete diagnostic output", () => {
    const plain = "probe.ts(2,3): error TS2345: type mismatch";
    const withExtraLine = (extra: string) => evidence({ ...ok, diagnostics: [diag], rawOutput: { stdout: `${plain}\n${extra}\n` } });
    expect(withExtraLine("other.ts(1,1): error TS2345: outside fixture").status).toBe("unsupported");
    expect(withExtraLine("probe.ts(1,1): message TS1450: unsupported severity").status).toBe("unsupported");
    expect(withExtraLine("error TS6053: File not found").status).toBe("execution-error");
  });
});
