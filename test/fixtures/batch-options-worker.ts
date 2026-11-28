// Synthetic peer, not a TypeScript checker. Only these two snippets have diagnostics.
import { createInterface } from "node:readline";
import type { CaseFile, CompilerOptions } from "../../src/types.ts";

export const strictSource = "const n: number = undefined;\n";
export const targetSource = "const n = 1n;\n";
export const capabilities = {
  supportsOptions: true,
  supportedOptions: ["strict", "target"],
  responseFields: ["file", "line", "col", "code", "severity"],
  version: "synthetic-1",
};
export const rejectionCode = "unsupported-option"; // A fixture token, not a production alias list.
const modes = ["legacy", "hello", "first-result", "bad-ok", "unmatched", "late", "changed", "unknown-code", "wrong-status"] as const;
export type WorkerMode = typeof modes[number];
type Reply = Record<string, unknown>;

function input(value: unknown): asserts value is { protocol: 1; type: "shutdown" } | {
  protocol: 1; type: "check"; id: string; files: CaseFile[]; options: CompilerOptions; args: string[];
} {
  if (value === null || typeof value !== "object") throw new Error("Expected a v1 message");
  const row = value as Record<string, unknown>;
  if (row.protocol === 1 && row.type === "shutdown") return;
  if (row.protocol !== 1 || row.type !== "check" || typeof row.id !== "string" ||
      !Array.isArray(row.files) || !row.files.every(f => typeof f?.path === "string" && typeof f.text === "string") ||
      !Array.isArray(row.options) || !row.options.every(o => typeof o?.name === "string" &&
        (typeof o.value === "boolean" || typeof o.value === "string" || (Array.isArray(o.value) && o.value.every((v: unknown) => typeof v === "string")))) ||
      !Array.isArray(row.args) || !row.args.every(a => typeof a === "string")) {
    throw new Error("Expected v1 check with options array and args, or shutdown");
  }
}

export function createWorker(mode: WorkerMode) {
  let checks = 0;
  let delayed: Reply | undefined;
  const startup = mode === "hello" ? [{ protocol: 1, type: "hello", implementation: { name: "synthetic-batch", version: capabilities.version }, capabilities }] : [];
  return {
    startup,
    receive(value: unknown): Reply[] | null {
      input(value);
      if (value.type === "shutdown") return null;
      const { id, files, options, args } = value;
      const first = checks++ === 0;
      const base = { protocol: 1, type: "result", id };
      // For this small fixture, args may carry extra options as --name value pairs.
      // The v1 structured options win when both channels set the same option.
      const effective = new Map<string, unknown>();
      for (let i = 0; i + 1 < args.length; i += 2) effective.set(args[i]!.replace(/^--/, ""), args[i + 1]);
      for (const { name, value } of options) effective.set(name, value);
      const unsupported = [...effective].find(([name, v]) => name === "strict" ? ![true, false, "true", "false"].includes(v as boolean | string)
        : name === "target" ? !["es2015", "es2020", "esnext"].includes(String(v)) : true);
      let reply: Reply = { ...base, status: "ok", diagnostics: [] };
      if (mode !== "legacy" && unsupported && mode !== "bad-ok") {
        reply = { ...reply, status: mode === "wrong-status" ? "ok" : "skip", skipReason: "Synthetic unsupported option",
          errorCode: mode === "unknown-code" ? "unsupported-option-typo" : rejectionCode,
          option: { name: unsupported[0], value: unsupported[1] } };
      } else if (!unsupported || mode === "legacy") {
        const strict = mode === "legacy" || effective.get("strict") === true || effective.get("strict") === "true";
        const diagnostics = files.flatMap(file => {
          const code = file.text === strictSource && strict ? 2322
            : file.text === targetSource && mode !== "legacy" && effective.get("target") === "es2015" ? 2737 : null;
          return code === null ? [] : [{ file: file.path, line: 0, col: 6, code, severity: "error" }];
        });
        reply.diagnostics = diagnostics;
      }
      if (first && ["first-result", "bad-ok", "changed", "unknown-code", "wrong-status"].includes(mode)) reply.capabilities = capabilities;
      if (mode === "changed" && !first) reply.capabilities = { ...capabilities, supportedOptions: ["strict", "target", "module"] };
      if (mode === "unmatched" && first) return [{ ...reply, id: `${id}:not-pending`, capabilities }, reply];
      // Release the expired response on request 2, not on a wall clock. This
      // lets the client test force the first timeout without racing a timer here.
      if (mode === "late") {
        if (first) { delayed = { ...reply, capabilities }; return []; }
        if (delayed) { const stale = delayed; delayed = undefined; return [stale, reply]; }
      }
      return [reply];
    },
  };
}

export async function runWorker(mode: WorkerMode) {
  if (process.argv.includes("--version")) {
    console.log(capabilities.version);
  } else {
    if (!modes.includes(mode) || !process.argv.includes("--batch")) throw new Error("Expected a synthetic worker mode and --batch");
    const worker = createWorker(mode);
    for (const row of worker.startup) console.log(JSON.stringify(row));
    for await (const line of createInterface({ input: process.stdin })) {
      const rows = worker.receive(JSON.parse(line));
      if (rows === null) break;
      for (const row of rows) console.log(JSON.stringify(row));
    }
  }
}

if (import.meta.main) await runWorker(process.argv[2] as WorkerMode);
