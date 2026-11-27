import { readFileSync } from "node:fs";
import { expandCaseVariants, type ParsedCase } from "./case.ts";
import { isValidCaseId } from "./discover.ts";

export type CaseTarget = { source: string; configuration: string | null };

export function parseCaseTargets(input: unknown): CaseTarget[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Target manifest must be a nonempty array");
  const sources = new Set<string>();
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, "source") || !Object.hasOwn(entry, "configuration") ||
        typeof entry.source !== "string" || !isValidCaseId(entry.source) ||
        !(entry.configuration === null || typeof entry.configuration === "string" &&
          /^[a-z0-9_-]+=[a-z0-9_-]+(?:,[a-z0-9_-]+=[a-z0-9_-]+)*$/.test(entry.configuration))) {
      throw new Error(`Invalid exact case target: ${JSON.stringify(entry)}`);
    }
    if (sources.has(entry.source)) throw new Error(`Duplicate target source: ${entry.source}`);
    sources.add(entry.source);
    return { source: entry.source, configuration: entry.configuration };
  });
}

export function configuredRecordId({ source, configuration }: CaseTarget): string {
  if (configuration === null) return source;
  const extension = source.lastIndexOf(".");
  const suffix = extension > source.lastIndexOf("/") ? extension : source.length;
  return `${source.slice(0, suffix)}(${configuration})${source.slice(suffix)}`;
}

export function loadCaseTargets(path: string): CaseTarget[] {
  return parseCaseTargets(JSON.parse(readFileSync(path, "utf8")));
}

/** Resolve a target to exactly one variant. No fallback to a sibling or to an unconfigured record. */
export function resolveCaseTarget(parsed: ParsedCase, target: CaseTarget) {
  if (parsed.id !== target.source) throw new Error(`Target does not match parsed source: ${target.source}`);
  const reason = parsed.skip ?? (parsed.unknown.length ? `未知指令 ${parsed.unknown[0]}` : null);
  const expanded = reason === null ? expandCaseVariants(parsed) : { status: "unsupported" as const, reason };
  const variant = expanded.status === "ok" && expanded.variants.find((v) => (v.configName || null) === target.configuration);
  if (!variant) throw new Error(`Unresolved target configuration: ${target.source} (${target.configuration ?? "default"})`);
  return variant;
}
