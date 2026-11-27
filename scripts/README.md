# 维护与评测脚本

这里是本地复现和 CI 调用的命令入口，单次测试的核心逻辑在[运行器](../src/README.md)。

- [`install-impl.ts`](install-impl.ts) 获取已登记检查器；[`select-smoke.ts`](select-smoke.ts) 和 [`select-official-baseline-cases.ts`](select-official-baseline-cases.ts) 筛选用例列表。
- [`validate-compatibility.ts`](validate-compatibility.ts) 复现固定样本的两种参考来源；[`full-compatibility.ts`](full-compatibility.ts) 负责全量分片与汇总；[`version-probes.ts`](version-probes.ts) 校准版本差异探针。
- [`curate-compatibility.ts`](curate-compatibility.ts) 从固定 Actions 产物生成[差异样本草案](../config/curated-difference-v1/README.md)，不派发评测。
- [`curated-comparison.ts`](curated-comparison.ts) 将已审阅的 v1 证据生成[只读比较产物](../docs/CI.md#并列查看兼容性差异样本-v1只读产物)，不改公开报告索引。
- [`detect-changes.ts`](detect-changes.ts) 和 [`merge-reports.ts`](merge-reports.ts) 分别负责门禁的变化检测、报告合并。
- [`public-evaluation.ts`](public-evaluation.ts) 组织公开评测，[`persist-public-evaluation.sh`](persist-public-evaluation.sh) 保存结果，[`stage-public-reports.ts`](stage-public-reports.ts) 校验并暂存发布数据。[`native-suite.ts`](native-suite.ts) 服务独立的自有检查器入口。

命令与产物见 [CI 使用说明](../docs/CI.md)。改参数、产物或退出条件时，同时核对[工作流](../.github/workflows/README.md)与[测试](../test/README.md)；生成的报告不提交到本分支。
