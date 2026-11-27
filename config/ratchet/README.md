# 按检查器分别保存的回归记录

这里说明回归记录的格式和维护规则。
设计理由见 [设计思路](../../docs/DESIGN.md#7-怎样把已经做到的兼容性保留下来)，
比较与门禁规则见 [技术参考](../../docs/REFERENCE.md#114-记录与回归)，
当前实现进度见 [实现状态](../../docs/STATUS.md)。

一份记录只属于一个「检查器 × 参考配置」组合，路径为
`config/ratchet/<impl>-<baseline>.tsv`。记录同时保存兼容、严格一致两档结果和
每个差异项的验证状态；门禁默认保护兼容档，可选择严格一致档。

## 格式

```text
# 注释行
<case id>	<compatibility>	<strict>	<fields>	<legacy>
```

- `compatibility`、`strict`：`pass` / `fail` / `unknown`；
- `fields`：`,` 分隔的 `字段=equal|different|unavailable`，覆盖全部差异项
  （`code`、`severity`、`location`、`width`、`message`、`messageChain`、
  `related`、`attributes`、`count`、`order`、`output`）；`-` 表示全部 `unavailable`；
- `legacy`：新版记录写 `-`。从旧两列 TSV 迁移的条目保留 `legacy=<旧分级>`，
  便于审阅来源；它不参与 strict 推断。

记录只升不降：非门禁运行发现改善时写回，回落不会降低历史保护；
门禁运行只读，不初始化、不写回。本次完整结果保存在 `details.json`，不按门禁档
截断，也不因更新记录而抹去上一次结果。

## 旧 TSV 迁移

旧格式为 `<case id>	<tier>`（T0–T2；`full` 在旧实现中归一为 `text`）。
读入时：

- 旧 `location|category|text|full` 迁移为 `compatibility=pass`；
- 旧 `none` 迁移为 `compatibility=unknown`；
- `strict=unknown`，全部字段 `unavailable`。

旧档位不能证明两档比较下的严格一致或逐字段结果，因此不会生成 strict 证据。
严格一致档门禁要求记录里至少有一个已验证的 `strict=pass`；只有旧记录的检查器
需要先做一次非门禁运行，审阅后提交带 strict 证据的新记录。

## 保护档与门禁

| 门禁档 | 无记录时 | 有记录时阻断 |
| --- | --- | --- |
| `compatibility`（默认） | 兼容档必须全部 `pass`，`unknown` 不能算通过 | 兼容回归 |
| `strict` | 严格档必须全部 `pass`，`unknown` 不能算通过 | 兼容回归与严格回归 |

严格一致退到仅兼容始终记为严格一致性回归：严格档门禁失败，兼容档门禁仍通过
并在报告中展示。逐字段回归（某个已验证相同的差异项变为不同或未提供）也会保留
和报告；它不单独作为门禁档。

有记录但所选档没有任何 pass 历史时，门禁不能判绿：兼容档至少需要一个
`compatibility=pass`，严格档至少需要一个 `strict=pass`。空记录同样视为配置错误。
显式数字阈值仍是附加限制，不能替代回归检查。

维护：门禁使用已入库的记录，不写回改善；若 `details.json` 显示改善，维护者本地
去掉 `--gate` 运行、审阅后提交对应文件。
