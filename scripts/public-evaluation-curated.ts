import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/baselines.ts";
import { configuredRecordId, parseCaseTargets } from "../src/case-targets.ts";
import { sha256 } from "../src/provenance.ts";

export const curatedSuite = { id: "curated-difference-v1", label: "精选差异样本 v1（33 个目标配置）" } as const;
export const curatedCorpus = "microsoft/TypeScript@3e9236361fa97a9e6c685f4833ac457ae2d8c50a";
export const curatedTargetCount = 33;
export const curatedTargetHash = "69d42f3a52021f62b7885dcc0390aa2f86fd2bd55dad6bc1da24e323570d98e4";

/** Read the committed sidecar's source/configuration pairs, without modifying its evidence format. */
export function curatedTargets() {
  const evidence = JSON.parse(readFileSync(join(REPO_ROOT, "config", curatedSuite.id, "evidence.json"), "utf8"));
  const rows = parseCaseTargets(evidence.cases.map(({ source, configuration }: { source: unknown; configuration: unknown }) => ({ source, configuration })));
  rows.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  if (evidence.corpus !== curatedCorpus || rows.length !== curatedTargetCount || sha256(JSON.stringify(rows)) !== curatedTargetHash) {
    throw new Error("Curated v1 target manifest drift; use a new suite version for changes");
  }
  return rows;
}

export const curatedTargetRecordIds = () => new Set(curatedTargets().map(configuredRecordId));

if (import.meta.main) console.log(JSON.stringify(curatedTargets(), null, 2));
