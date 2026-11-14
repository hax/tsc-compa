// 生成「官方基线可消费子集」的用例清单：供 --expectation-source official-baseline 用。
//
// 用法：bun scripts/select-official-baseline-cases.ts --corpus <repo>/tests/cases \
//         [--out config/official-baseline-cases.json] [--limit 200]
//
// 条件（见 src/officialBaseline.ts 头注）：plain 基线、无多值指令、无绝对路径
// @filename、基线摘要块可解析且不含配置错误/语法错误。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { parseCase } from "../src/case.ts";
import { loadManifest, scanCorpus } from "../src/discover.ts";
import { expectationFromOfficialBaseline, parseOfficialBaselineText, officialBaselineDirOf } from "../src/officialBaseline.ts";
import { readFileSync, existsSync } from "node:fs";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const corpus = argOf("corpus") ?? process.env.TSC_COMPA_CORPUS;
if (corpus === undefined) throw new Error("需要 --corpus <repo>/tests/cases 或 TSC_COMPA_CORPUS");
const out = argOf("out") ?? "config/official-baseline-cases.json";
const limit = Number(argOf("limit") ?? 200);
const baselineDir = officialBaselineDirOf(corpus);

const reasons: Record<string, number> = {};
const eligible: string[] = [];
for (const id of scanCorpus(corpus).sort()) {
  if (id.endsWith(".d.ts")) continue;
  const parsed = parseCase(readFileSync(join(corpus, id), "utf8"), id);
  if (parsed.skip !== null || parsed.unknown.length > 0) {
    const key = "用例本身不入选（指令跳过/未知）";
    reasons[key] = (reasons[key] ?? 0) + 1;
    continue;
  }
  const outcome = expectationFromOfficialBaseline(corpus, id, parsed);
  if (outcome.status === "skip") {
    const key = outcome.reason.replace(/（.*$/, "");
    reasons[key] = (reasons[key] ?? 0) + 1;
    continue;
  }
  eligible.push(id);
}

const stride = Math.max(1, Math.ceil(eligible.length / limit));
const chosen = eligible.filter((_, i) => i % stride === 0).slice(0, limit);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(chosen, null, 2)}\n`);
console.log(
  `语料 ${corpus}\n基线目录 ${baselineDir}（${existsSync(baselineDir) ? "存在" : "不存在"}）\n` +
    `可消费用例 ${eligible.length}，按步长 ${stride} 抽样 ${chosen.length} 例 -> ${out}`,
);
console.log("跳过原因：", JSON.stringify(reasons, null, 2));
