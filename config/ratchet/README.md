# 按实现分账的 ratchet 清单

格式与旧的 `config/ratchet-ts71-official.tsv` 相同（TSV：`<case id>\t<tier>`，只登记 ≥T0 的用例），
但**一份清单只属于一个「实现 × 基线」组合**：路径为 `config/ratchet/<impl>-<baseline>.tsv`。

- 档位只到 T2：`location(T0) < category(T1) < text(T2)`。T3 full（整份 `.errors.txt` 字节相等）
  是**报告档**，读入/写回时归一为 `text`，因此 full → text 不算回落；T3 分布仍在 metrics 里报告；
- `tsrs`、`tsc-rs`、`ts-rust` 都基于 TypeScript 7.1 源码，行为一致，共用同一份初始清单（三份文件内容相同）；
- `tsz` 目标 TS 7.0.2，与 7.1.0-beta 基线存在版本差，首次跑 `third-party.yml` 时由 harness
  **自动初始化**自己的清单（只登记当前档位、不判红）；之后只在实现自身回落时才失败；
- 旧的根文件 `config/ratchet-ts71-official.tsv` 保留为 legacy 共用清单（显式 `--ratchet <file>` 仍可用），
  新 CI 一律走 `--ratchet-impl <impl>` 推导分账路径。

维护：CI 里清单已入库，正常不应产生写回；若 artifact 显示改善（tier 上升），维护者审阅后提交对应文件。
门禁模式要求清单已入库且非空（`registered > 0`），否则拒绝把空清单当门禁。
