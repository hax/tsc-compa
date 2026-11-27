# 兼容性差异样本 v1（草案）

这份样本优先重现兼容差异，不用于估计检查器在整个测试集上的通过率。它不接入公开评测、CI 门禁或历史报告发布，也不替换原有 [fixed-120](../official-baseline-cases-ts71.json)。

- [`inputs.json`](inputs.json) 锁定 Actions 运行号、重试次数、提交、报告 ID 和分类预算。
- [`cases.json`](cases.json) 是现有 `run.ts --cases` 可读的源文件列表。
- [`evidence.json`](evidence.json) 记录每个入选源文件的**目标配置**、入选理由、各检查器结果、两个覆盖率分母及原始产物 SHA-256。目标配置为空表示用例没有命名配置，不是通配符。
- 官方 TS6／TS7 探针单列，不放进 `cases.json`。用现有探针命令重跑，不计入全量记录或差异样本的覆盖率。

## 从 Actions 产物重建

需要登录的 `gh`、`jq` 和 Bun。在仓库根目录下载锁定的产物；Actions 产物到期后需使用此前留存的同一批文件，不能悄悄换成重跑或另一批数据。缺运行、分片、配置或有执行失败时，生成器会报错。

```bash
set -euo pipefail
bun install --frozen-lockfile
D=.cache/curated-v1
LOCK=config/curated-difference-v1/inputs.json
mkdir -p "$D/actions"
for RUN in $(jq -r '.runs[].run' "$LOCK"); do
  DIR="$D/actions/$RUN"
  mkdir -p "$DIR"
  gh api "repos/hax/tsc-compa/actions/runs/$RUN" > "$DIR/run.json"
  gh run download "$RUN" -R hax/tsc-compa -D "$DIR" \
    -p 'full-*' -p public-evaluation-request -p public-evaluation-report
done
RUN=$(jq -r '.probes.run' "$LOCK")
DIR="$D/actions/$RUN"
mkdir -p "$DIR"
gh api "repos/hax/tsc-compa/actions/runs/$RUN" > "$DIR/run.json"
gh run download "$RUN" -R hax/tsc-compa -D "$DIR" -p ts-version-probes-official
bun scripts/curate-compatibility.ts generate "$D/actions" "$D/generated"
for f in cases.json evidence.json; do diff -u "config/curated-difference-v1/$f" "$D/generated/$f"; done
```

生成器按计划验证每份 `metrics.json`、`details.json`、请求和报告，检查针对同一提交、参考诊断、测试输入及参考选项；然后按「源文件 + 命名配置」合并，不按文件名或 JSON 行顺序合并。`ledger.jsonl` 在本地保留所有 14,346 条配置记录，包括诊断的文件、位置、严重性、诊断码及跳过原因，不提交。此证据来自 Linux x64 的四份公开全量报告和 [#25](https://github.com/hax/tsc-compa/pull/25) 最终提交的两次成功预演；预演报告 ID 不作为已发布地址使用。`ts-rust` 来自 npm `tsc-rs@0.8.0`，不是 [#26](https://github.com/hax/tsc-compa/issues/26) 记录的另一个 `tsc-rs` 实现；后者执行失败不参与选样或语义统计。

## 选择规则与版本

先选官方 TS7 CLI 对 `.errors.txt` 通过、多个候选家族存在兼容差异的用例；再给只有一个家族出现差异且另一家族通过的用例留位。两个 Bun 版本分别留存，但合计只算一个家族。本批 14,346 条中未发现 Bun 1.4.4 与 1.4.5 在选用的观察字段（兼容结论、诊断位置等或跳过原因）上有差异。这里选的是兼容档，严格档「无法确认」不算差异，也不据此推断严格一致。

参考 CLI 自身与 `.errors.txt` 有差异时，单独标记 `reference-disagreement`，不归因为候选缺陷。明确不支持的选项单列为 `intentional-skip`；在该组，已完成的比较全部通过。针对使用内置声明库的 tsz 预演，只有实际退出码、有效参数和完整诊断输出能证实是选项拒绝时，才把无位置诊断归为不支持。例如实际传入 `--target es2026`，tsz 报 TS6046 且列出的允许值不包含 `es2026`。其他通用跳过不凭理由猜测；任何候选的 `skip` 都不是零诊断，也不是兼容差异。

各组按不同家族数、可比较家族数排序；单家族差异中优先保留在 fixed-120 上出现的新差异。其后优先保留较少诊断、路径及配置名排序靠前的记录。按「分类、家族及多报／漏报／位置差异的诊断码组合」合并近似差异，每个源文件、同路径编号系列只选一例。控制例按测试集分区和诊断码去重，既保留有诊断的例，也保留明确无诊断的例。fixed-120 只从控制组排除；重叠数写在 `fixed120OverlapByBucket`。草案可以改选；发布 v1 后锁定输入、规则和产物，变更样本、参考提交或取证口径时另建版本，不覆盖旧结果。

## 本地跑选中的源文件

先按 [CI 文档](../../docs/CI.md#本地-ts7-官方结果文件对照)获取测试集和设置 `TS71_CASES`；其提交必须匹配 `inputs.json`，同时要保留配套的官方 `.errors.txt`。先用官方 TS7 CLI 做参考自检；换候选时按 `evidence.json` 选择对应的固定版本、适配器、`candidateArgs` 和 `prepared.environment`。特别是 tsz 使用正式 `v0.1.75` 的 GNU x64 Release，须设置 `TSZ_USE_EMBEDDED_LIBS=1`；不要用主分支的 cargo pin 替代。最可靠的归档复核仍是上一节的产物重建。

```bash
OUT=.cache/curated-v1/local-ts7
ADAPTER=tsc-cli:node_modules/typescript-7-1/bin/tsc
TSC_COMPA_ADAPTER_ARGS='' bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus "$TS71_CASES" --cases config/curated-difference-v1/cases.json \
  --expectation-source official-baseline --mode official --option-strategy aligned \
  --adapter "$ADAPTER" --out "$OUT" --report-out "$OUT"

# 运行器展开所选源文件的所有同级配置；只读目标配置须按二元键筛选 details.json。
jq --slurpfile evidence config/curated-difference-v1/evidence.json '
  INDEX($evidence[0].cases[]; [.source,.configuration] | tojson) as $target
  | [.[] | . as $row | $target[[($row.caseId // $row.id),($row.configuration // null)] | tojson] as $case
      | select($case != null)
      | {source:$case.source, configuration:$case.configuration, bucket:$case.bucket,
         status, skipReason, compatibility:.comparison.compatibility}]
' "$OUT/details.json"

# 五个官方 TS6／TS7 补充探针独立执行。
bun run probes:versions --out .cache/curated-v1/probes
```

用 `.cases[].source` 和 `.cases[].configuration` 确定标记落在哪条记录；同文件其他配置的运行结果不共享标记。查看历史证据时读 `.cases[].observations[候选]`：`pass` / `mismatch` / `unknown` 表示完成的兼容比较，`skip` 有单独的原因及证据。`.selected.perCandidate` 只计目标配置，其中命中率分母是**已完成**比较中的参考诊断数，不包括跳过；不能用整份本地报告（含同级配置）的汇总与之直接比较。
