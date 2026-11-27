# 测试配置与用例列表

这里保存运行器和 CI 共同使用的测试输入，不存放上游 TypeScript 测试集或生成的报告。

- [`baselines.json`](baselines.json)：参考 tsc、测试集引用、基础选项、默认用例列表和等价诊断码。
- [`implementations.json`](implementations.json)：供脚本读取的第三方检查器登记，包括版本、获取方式、适配器和参数。公开评测另有固定选择，见 [CI 使用说明](../docs/CI.md#公开评测与报告目录public-evaluationyml)。
- 用例列表：5.9 [冒烟](smoke-cases-5.9.json)、strada [冒烟](smoke-cases.json)及[官方结果子集](official-baseline-cases.json)、TS7 [官方冒烟](smoke-cases-ts71-official.json)及[固定诊断样本](official-baseline-cases-ts71.json)。[位置差异用例](anchor-cases.json)单独保存。
- [回归记录](ratchet/README.md)按检查器与参考配置分别维护；[`ratchet-ts71-official.tsv`](ratchet-ts71-official.tsv) 是 `smoke` 门禁仍显式读取的旧格式记录。
- [版本差异探针](version-probes/README.md)独立于冒烟和全量评测。

更新版本或测试集引用时，连同用例路径、获取方式和对应回归记录一起核对，再运行相关检查。
