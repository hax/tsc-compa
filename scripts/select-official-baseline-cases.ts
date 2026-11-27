// 生成「官方基线可消费子集」的用例清单：供 --expectation-source official-baseline 用。
//
// 用法：bun scripts/select-official-baseline-cases.ts --corpus <repo>/tests/cases \
//         [--out config/official-baseline-cases.json] [--limit 200]
//
// 条件：每个可执行配置的 plain 基线摘要都能解析，且没有绝对路径
// @filename、配置错误或语法错误。带变体后缀的缺失基线必须有其他执行证据。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandCaseVariants } from "../src/case.ts";
import { readCase, scanCorpus } from "../src/discover.ts";
import { expectationFromOfficialBaseline, expectationFromOfficialVariantBaseline, officialBaselineDirOf } from "../src/officialBaseline.ts";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const corpus = argOf("corpus") ?? process.env.TSC_COMPA_CORPUS;
if (corpus === undefined) throw new Error("需要 --corpus <repo>/tests/cases 或 TSC_COMPA_CORPUS");
const out = argOf("out") ?? "config/official-baseline-cases.json";
const limit = Number(argOf("limit") ?? 200);
const baselineDir = officialBaselineDirOf(corpus);
if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit 需要正整数");
if (!existsSync(baselineDir)) throw new Error(`官方基线目录不存在：${baselineDir}`);

const reasons: Record<string, number> = {};
const eligible: string[] = [];
for (const id of scanCorpus(corpus).sort()) {
  if (id.endsWith(".d.ts")) continue;
  const parsed = readCase(corpus, id);
  if (parsed.skip !== null || parsed.unknown.length > 0) {
    const key = "用例本身不入选（指令跳过/未知）";
    reasons[key] = (reasons[key] ?? 0) + 1;
    continue;
  }
  const expanded = expandCaseVariants(parsed);
  const reason = expanded.status === "unsupported" ? expanded.reason
    : parsed.absoluteFiles.length > 0 ? "用例含绝对路径 @filename"
    : expanded.variants.map((variant) => variant.configName === ""
      ? expectationFromOfficialBaseline(corpus, id, parsed)
      : expectationFromOfficialVariantBaseline(corpus, variant))
      .find((outcome) => outcome.status === "skip")?.reason;
  if (reason !== undefined) {
    const key = reason.replace(/（.*$/, "");
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
