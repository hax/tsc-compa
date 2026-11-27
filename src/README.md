# 兼容性运行器

[`run.ts`](run.ts) 读取测试配置，准备并执行用例，再生成比较结果和报告。

- [`discover.ts`](discover.ts)、[`case.ts`](case.ts) 与 [`classify.ts`](classify.ts)：发现、解析和筛选用例。
- [`baselines.ts`](baselines.ts)、[`tsc.ts`](tsc.ts) 与 [`officialBaseline.ts`](officialBaseline.ts)：选择参考配置、生成或读取参考诊断。
- [适配器](adapters/README.md)负责运行候选；[`compare.ts`](compare.ts) 与 [`comparison.ts`](comparison.ts) 负责匹配诊断及判断兼容和严格一致。
- [`gate.ts`](gate.ts)、[`ratchet.ts`](ratchet.ts)、[`report.ts`](report.ts) 分别负责门禁、回归记录和报告渲染；[`perf.ts`](perf.ts) 提供不影响门禁的性能附录。

编排与部署逻辑放在[脚本目录](../scripts/README.md)，不混入诊断比较。改比较口径、CLI 或报告字段时，
更新[技术参考](../docs/REFERENCE.md)并补相应测试。
