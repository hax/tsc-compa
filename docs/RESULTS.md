# 多基线冒烟结果与默认口径差异

日期：2026-11-15
环境：macOS arm64 本机；Bun 1.4.4；语料为 `microsoft/TypeScript` 的 `tests/cases`
（6.0 strada 线 `b465fdbf` 与 5.9 发布 tag `v5.9.3` 两套）；tsc 5.9.3 / 6.0.3 /
7.1.0-beta 三个版本经 npm alias 装在 `node_modules/typescript-*`。
冒烟集为 `config/smoke-cases.json`（strada 28 例）与 `config/smoke-cases-5.9.json`
（5.9 语料 28 例），**样本很小，以下数字都不是兼容性结论**。

## 目的

1. 验证三档基线（5.9.3 / 6.0.3 / 7.1.0-beta）在 harness 上都能自比 100%——
   同版本同时作期望源与实现，是 harness 自身正确性的检查；
2. 观察「版本默认值不同」和「真实语义不同」各自贡献多少跨版本差异；
3. 用锚点专用用例验证 misanchor（同码不同位）口径；
4. 为「是否长期保留多基线」积累数据。

## 配置

`config/baselines.json` 把「tsc 版本 × 语料 tag」成对定义：

| baseline | tsc | 语料 | 冒烟集 | 基础参数 |
| --- | --- | --- | --- | --- |
| `5.9.3` | `typescript-5-9` | `v5.9.3` tag | `smoke-cases-5.9.json` | `--noEmit --pretty false` |
| `6.0.3` | `typescript-6-0` | strada `b465fdbf` | `smoke-cases.json` | `--noEmit --ignoreConfig --pretty false` |
| `7.1.0-beta` | `typescript-7-1` | strada `b465fdbf` | `smoke-cases.json` | `--noEmit --ignoreConfig --pretty false` |

5.9 的 CLI 不认 `--ignoreConfig`（报 TS5023），且用例材料写到临时目录后没有
tsconfig 可发现，故省略该参数，口径不变。冒烟集已按分类标签排除
parser/JS/JSX/emit/module/lib/env 类用例，并用对应基线的 tsc 现场核对、
踢掉语法错误用例。

## 结论 1：三档自比全部 100%

| 期望源 = 适配器 | 语料 | 跑/跳 | 覆盖 | 假阳性 | 漏报 | 错锚 | 完全通过 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tsc 5.9.3 | v5.9.3 | 28 / 0 | 31/31 = 100% | 0 | 0 | 0 | 28 |
| tsc 6.0.3 | strada | 28 / 0 | 48/48 = 100% | 0 | 0 | 0 | 28 |
| tsc 7.1.0-beta | strada | 28 / 0 | 48/48 = 100% | 0 | 0 | 0 | 28 |

期望生成路径与参考适配器解析路径没有系统性偏置；冒烟集里不再有语法错误用例
（上一版有两个，已被选择器剔除）。

## 结论 2：版本默认值漂移（跨版本差异的大头）

指令没写到的选项，v0 用各版本 CLI 的默认值。实测三档默认值不同：

| tsc | 默认 target（由 `--listFiles` 的 lib 链推断） | 默认 strict | `--target es5` |
| --- | --- | --- | --- |
| 5.9.3 | ES5（lib.es5 + dom） | false | 支持 |
| 6.0.3 | ES2015（lib.es5 + es2015 + …） | true | 弃用，报 TS5107 |
| 7.1.0-beta | ES2015 | true | 已移除，报 TS5108 |

## 结论 3：跨版本差异以默认值为主，语义差异为辅

同一冒烟集，改「适配器版本」或「附加口径」后的指标：

| # | 期望源 | 适配器 | 附加口径 | 覆盖 | 假阳性 | 漏报 | 错锚 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 6.0.3 | 7.1.0-beta | 无（默认值一致） | 48/48 = 100% | 0 | 0 | 0 | 6.0 与 7.1 默认值相同 |
| 2 | 5.9.3 | 6.0.3 | 无 | 31/31 = 100% | 8 例 / 43 条 | 0 | 0 | 默认 strict 由 false 变 true |
| 3 | 5.9.3 | 7.1.0-beta | 无 | 同 #2（逐条相同） | 8 例 / 43 条 | 0 | 0 | 7.1 与 6.0 表现一致 |
| 4 | 5.9.3 | 6.0.3 | `--base-arg strict=false` | 31/31 = 100% | 3 例 / 4 条 | 0 | 0 | 余 TS1202×2、TS1100、TS1540 |
| 5 | 5.9.3 | 6.0.3 | `strict=false` + `target=es2015` | 31/31 = 100% | 2 例 / 2 条 | 0 | 0 | 余 TS1100、TS1540；另 1 例 skip（期望侧语法错误） |
| 6 | 5.9.3 | 7.1.0-beta | 同 #5 | 逐条同 #5 | 2 例 / 2 条 | 0 | 0 | 7.1 与 6.0 表现一致 |

读法：

- #2 → #4：把 strict 默认值钉齐后，假阳性从 43 条降到 4 条，说明**跨版本差异的
  大头是默认值翻转，而不是检查器判定不同**。
- #4 → #5：再把默认 target 钉齐（5.9 默认 ES5，6.0/7.1 默认 ES2015；ES5 在
  6.0 已弃用、7.1 已移除，只能把两侧都钉到 ES2015），只剩 2 条残余
  （TS1100「return 只能在函数体内」、TS1540「只有 ESM 能异步」），集中在
  模块上下文，怀疑 `module`/`moduleDetection` 默认值也还有差异未钉齐。
- 6.0.3 与 7.1.0-beta 在所有口径下逐条一致——TS7 原生实现在这套冒烟集上
  没有表现出与 6.0 的行为差异。

## 结论 4：错锚（misanchor）指标有效

专用用例集 `config/anchor-cases.json`（`compiler/overloadsWithProvisionalErrors.ts`，
已知跨版本锚点不同）：

| 期望源 | 适配器 | 覆盖 | 假阳性 | 漏报 | 错锚 | 完全通过 |
| --- | --- | --- | --- | --- | --- | --- |
| 6.0.3 | 6.0.3（自比） | 4/4 = 100% | 0 | 0 | 0 | 1 |
| 6.0.3 | 7.1.0-beta | 2/4 = 50% | 0 | 0 | **1 例 / 2 条** | 0 |

两版同码同条数、只是锚点不同：按新口径计入 misanchor，**不再同时污染 fp 与
miss 两侧**，跨版本对照时可以直接看出「判定一致、位置口径不同」。

## 局限

- 冒烟集每档只有 28 例，指标不能外推；报「通过率」之前必须先对齐口径。
- 期望生成用的是 CLI 默认值，官方 harness 的 `defaultOptions` 仍未对齐（DESIGN §3.3）。
- 7.1 基线暂时复用 strada 语料；官方基线（`.errors.txt`）尚未接入。
- 5.9 与 6.0/7.1 的残余差异只做到 strict/target 两项对齐，module 默认值待钉。

## 复现

```bash
# 5.9 语料（本地浅克隆 tag）
git clone --depth 1 --branch v5.9.3 --single-branch \
  https://github.com/microsoft/TypeScript /tmp/tsc-compa-corpus-5.9

# 自比（三档）
bun src/run.ts --baseline 5.9.3 --corpus /tmp/tsc-compa-corpus-5.9/tests/cases \
  --adapter tsc-cli:node_modules/typescript-5-9/bin/tsc
bun src/run.ts --baseline 6.0.3 --corpus ../reference/typescript-strada/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc
bun src/run.ts --baseline 7.1.0-beta --corpus ../reference/typescript-strada/tests/cases \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc

# 5.9 期望 × 6.0.3 适配器（默认口径 → 对齐口径）
bun src/run.ts --baseline 5.9.3 --corpus /tmp/tsc-compa-corpus-5.9/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc
bun src/run.ts --baseline 5.9.3 --corpus /tmp/tsc-compa-corpus-5.9/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --base-arg strict=false --base-arg target=es2015

# 锚点用例
bun src/run.ts --baseline 6.0.3 --corpus ../reference/typescript-strada/tests/cases \
  --cases config/anchor-cases.json --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc
```

结果写 `.cache/run/{metrics,details}.json`。

## 后续

- 对齐官方 harness 的默认值（`defaultOptions`）与官方基线（`.errors.txt`）；
- 把 module / moduleDetection 的默认值差异钉齐，再重测 5.9 ↔ 6.0/7.1；
- 扩大样本（按码族/目录分层抽样）并接到公开仓 workflow 矩阵；
- 基于这批数据回答「是否长期保留 5.9 基线」：目前看 5.9 与 6.0/7.1 的差异
  主要是默认值漂移 + 少量模块上下文差异，保留 5.9 的成本主要是语料与期望
  维护，收益是能证明「承接 5.9 项目」的能力。
