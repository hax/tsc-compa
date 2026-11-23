# 按实现分账的 ratchet 清单

这里说明现有清单格式。完整记录与 T0 回归门槛分离的新设计尚待实现，
具体差距见 [实现状态](../../docs/STATUS.md#53-新的诊断比较与回归策略待实现)。

格式与旧的 `config/ratchet-ts71-official.tsv` 相同（TSV：`<case id>\t<tier>`，只登记 ≥T0 的用例），
但**一份清单只属于一个「实现 × 基线」组合**：路径为 `config/ratchet/<impl>-<baseline>.tsv`。

- 档位只到 T2：`location(T0) < category(T1) < text(T2)`，分别比较位置与码、严重级别、首行文本。
  T3 full（换行归一后的 `.errors.txt` 诊断摘要文本一致）
  是**报告档**，读入/写回时归一为 `text`，因此 full → text 不算回落；T3 分布仍在 metrics 里报告；
- `tsrs`、`tsc-rs`、`ts-rust` 都基于 TypeScript 7.1 源码，行为一致，共用同一份初始清单（三份文件内容相同）；
- `tsz` 目标 TS 7.0.2，与 7.1.0-beta 基线存在版本差，首次跑 `third-party.yml` 时由 harness
  **自动初始化**自己的清单（只登记当前档位、不判红）；之后只在实现自身回落时才失败；
- 旧的根文件 `config/ratchet-ts71-official.tsv` 保留为 legacy 共用清单（显式 `--ratchet <file>` 仍可用），
  新 CI 一律走 `--ratchet-impl <impl>` 推导分账路径。

维护：CI 里清单已入库，正常不应产生写回；若 artifact 显示改善（tier 上升），维护者审阅后提交对应文件。
门禁模式要求清单已入库且非空（`registered > 0`），否则拒绝把空清单当门禁。

为什么逐案记录、怎样帮助后续升级，见 [设计思路](../../docs/DESIGN.md#7-怎样把已经做到的兼容性保留下来)；
等级定义、初始化与 CI 规则见 [技术参考](../../docs/REFERENCE.md#7-回归检查与-ci-通过条件)；
当前实现与限制见 [实现状态](../../docs/STATUS.md)。
