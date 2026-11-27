# GitHub Actions 工作流

按要做的事选工作流。运行参数、本地复现和排错见 [CI 使用说明](../../docs/CI.md)。

| 工作流 | 什么时候用 |
| --- | --- |
| [`smoke`](smoke.yml) | 推送和 PR 的单元测试与兼容性门禁；也可定时或手动运行。 |
| [`candidate-adapter-smoke`](candidate-adapter-smoke.yml) | 检查[已登记候选](../../config/implementations.json)能否通过适配器完成 TS7 冒烟。诊断差异用于观察，不作为兼容性门禁。 |
| [`TS version probes`](version-probes.yml) | 校准固定参考版本在 [TS6／TS7 探针](../../config/version-probes/README.md)上的诊断差异。 |
| [`third-party-impl`](third-party.yml) | 手动试跑某个已登记实现；完整官方冒烟且有对应回归记录时执行门禁，否则只出报告。 |
| [`full-compatibility`](full-compatibility.yml) | 分片评估所有内置评测候选；可选现场 tsc 作为参考。 |
| [`public-evaluation`](public-evaluation.yml) | 评测一个公开候选与测试集组合，符合保存条件的结果进入公开报告数据分支。 |
| [`Publish public reports to Pages`](publish-public-reports.yml) | 将已保存的公开报告与站点一起部署；不重跑评测。 |
| [`native-suite`](native-suite.yml) | 运行本仓受控 Release 中的检查器二进制；结果不进入公开报告目录。 |

维护时以 YAML 为触发条件和权限的依据；移除或改名之前，先检查调用方、必需状态检查和历史运行。
