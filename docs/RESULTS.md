# 参考实现（tsc-cli）自比与跨版本冒烟结果

日期：2026-11-15
环境：macOS arm64 本机；Bun 1.4.4；语料 `microsoft/TypeScript@b465fdbf`（strada 线）的 `tests/cases`；
tsc 6.0.3 与 tsc 7.1.0-beta 各自以 CLI 直接运行。冒烟集为 `config/smoke-cases.json`（30 例），
单次运行在十几到几十秒内，**不是兼容性结论**。

## 目的

`--adapter tsc-cli` 是「参考实现适配器」：用真实 tsc 命令行跑用例，把
`file(line,col): error TSxxxx: msg` 解析成统一诊断。当期望源和适配器用同一个 tsc 时，
指标应当接近「覆盖 100%、假阳性 0、错锚 0」——这能证明 harness 本身（期望生成路径与
适配器解析路径）没有系统性偏置。跨版本组合则用来观察 tsc 版本演进带来的口径差异。

## 结果

| # | 期望源 | 适配器 | 跑 / 跳过 | 覆盖 | 假阳性 | 漏报 | 错锚 | 判定可用 | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | tsc 6.0.3 | tsc 6.0.3（自比） | 28 / 2 | 46/46 = **100%** | 0 例 / 0 条 | 0 | 0 | 是 | 27.9s（期望缓存冷） |
| 2 | tsc 6.0.3 | tsc 7.1.0-beta | 28 / 2 | 44/46 = **95.7%** | 1 例 / 2 条 | 2 | 2 | 是 | 5.1s（缓存热） |
| 3 | tsc 7.1.0-beta | tsc 7.1.0-beta（自比） | 28 / 2 | 46/46 = **100%** | 0 例 / 0 条 | 0 | 0 | 是 | 9.7s（缓存热） |

结论：

1. **两版 tsc 自比都是 100% 覆盖、0 假阳性、0 错锚**，说明期望生成与适配器解析走的是同一套规则
   （同一条 CLI 正则、同样按 cwd 解析相对路径、同样过滤用例目录外的 lib 诊断），harness 没有自欺。
2. **跨版本唯一差异集中在一个用例**：`compiler/overloadsWithProvisionalErrors.ts` 的两条 `TS2769`
   （No overload matches this call）。两版**同码、同条数**，只是锚点不同：
   - tsc 6.0.3 锚在调用表达式起始列（1-based 列 1）；
   - tsc 7.1.0-beta 锚在列 11（1-based；0-based 10，落在箭头函数体附近）。
   这在指标里同时表现为 2 条漏报 + 2 条错锚 + 2 条假阳性，属于**锚点口径差异，不是判定差异**。
   跨版本多基线时这类差异必须单列，不能只报通过率。
3. **两个 SKIP 都是语法错误用例**，被正确地排除在语义比较之外：
   - `compiler/alwaysStrictModule2.ts`：strict 模式下 `var arguments` 触发语法诊断（TS1xxx）；
   - `compiler/implementClausePrecedingExtends.ts`：`implements ... extends ...` 是语法错误形态。
   说明 `config/smoke-cases.json` 的抽样没有过滤语法类用例；后续应让选择器按用例类型过滤，
   或让 runner 把 syntax 用例单列统计而不是计入 skip 原因。
4. 覆盖分母很小（46 条期望诊断 / 30 例），这些数字只说明链路正确，**不能外推兼容性**。
5. 耗时仍以每案 spawn 为主：冷缓存 27.9s 约合 56 次进程启动（期望 + 适配器各 28 次），
   与「批量适配器」(#8) 的动机一致；改成单进程批量后应降到秒级。

## 复现

```bash
export TSC_COMPA_CORPUS=/path/to/typescript/tests/cases

# 1) 6.0.3 自比
TSC_BIN=/path/to/tsc-6.0.3/bin/tsc \
TSC_COMPA_ADAPTER_TSC=$TSC_BIN \
bun src/run.ts --adapter tsc-cli --mode official --cases config/smoke-cases.json

# 2) 6.0.3 期望 vs 7.1 适配器
TSC_BIN=/path/to/tsc-6.0.3/bin/tsc \
TSC_COMPA_ADAPTER_TSC=/path/to/tsc-7.1.0-beta/bin/tsc \
bun src/run.ts --adapter tsc-cli --mode official --cases config/smoke-cases.json

# 3) 7.1 自比
TSC_BIN=/path/to/tsc-7.1.0-beta/bin/tsc \
TSC_COMPA_ADAPTER_TSC=$TSC_BIN \
bun src/run.ts --adapter tsc-cli --mode official --cases config/smoke-cases.json
```

结果写到 `.cache/run/metrics.json` 与 `details.json`（可用 `--out` 改目录）。

## 后续

- 把「语法错误用例」「emit/IDE 类用例」在语料层分类，冒烟集与全量指标都按类过滤；
- 接批量适配器（#8）后重测这三组，验证耗时下降且结果不变；
- 接 tsc 5.9.x 作为第四组，供多基线（#9）分析使用；
- 官方基线作期望源（DESIGN §5）落地后，再加一组「官方基线 vs 自生成期望」的对账。
