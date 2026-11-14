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

## 结论 2：版本默认值来自官方 harness，5.9 → 6.0 发生翻转

逐条核对官方 harness 源码后，默认值如下（详见 DESIGN §3.3）：

| tsc | 默认 target | 默认 module / moduleResolution | strict 系默认 |
| --- | --- | --- | --- |
| 5.9.3 | ES5 | CommonJS / Node10 | false |
| 6.0.3 | ES2025（`LatestStandard`） | ES2022 / Bundler | true |
| 7.1.0-beta | ES2026（`LatestStandard`） | ES2022 / Bundler | true |

旧版 RESULTS 里「6.0/7.1 默认 target=ES2015」是只看 `--listFiles` 的 lib 链推出来的，
不准确：实际默认是各自版本的 `LatestStandard`（6.0=ES2025、7.1=ES2026）。
这些默认值现在显式写进 `config/baselines.json` 的 `baseArgs`，并且**只作用于期望侧**；
适配器侧只接用例指令与显式 `--base-arg` / `--adapter-arg`，用实现自己的默认值
（见 DESIGN §3.3）。

## 结论 3：跨版本差异以默认值为主，语义差异为辅

默认值对齐后，5.9 期望 × 6.0.3 / 7.1.0-beta 适配器（两边各用自己版本的官方默认值）：

| 期望源 | 适配器 | 覆盖 | 假阳性 | 漏报 | 错锚 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 5.9.3 | 6.0.3 | 31/31 = 100% | 8 例 / 43 条 | 0 | 0 | top fp：TS2454×26、TS2322×6、TS2564×5 |
| 5.9.3 | 7.1.0-beta | 31/31 = 100% | 8 例 / 43 条 | 0 | 0 | 与 6.0.3 逐条相同（7.1 与 6.0 行为一致） |

把两边显式对齐到同一套选项（`strict=false`、`target=es2015`、`module=es2015`、
`moduleResolution=bundler`，可用 `--base-arg` 同时作用于两侧）：

| 期望源 | 适配器 | 覆盖 | 假阳性 | 漏报 | 错锚 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 5.9.3 | 6.0.3 | 31/31 = 100% | 2 例 / 2 条 | 0 | 0 | 余 TS1100、TS1540；另 1 例 skip（语法错误） |
| 5.9.3 | 7.1.0-beta | 31/31 = 100% | 2 例 / 2 条 | 0 | 0 | 与 6.0.3 逐条相同 |

读法：默认口径下 43 条假阳性的大头是 5.9 → 6.0 的 strict/target 翻转，而不是检查器
判定不同；对齐选项后只剩 2 条模块上下文差异（TS1100「return 只能在函数体内」、
TS1540「只有 ESM 能异步」）。6.0.3 与 7.1.0-beta 在所有口径下逐条一致。

## 结论 4：错锚（misanchor）指标有效

专用用例集 `config/anchor-cases.json`（`compiler/overloadsWithProvisionalErrors.ts`，
已知跨版本锚点不同）：

| 期望源 | 适配器 | 覆盖 | 假阳性 | 漏报 | 错锚 | 完全通过 |
| --- | --- | --- | --- | --- | --- | --- |
| 6.0.3 | 6.0.3（自比） | 4/4 = 100% | 0 | 0 | 0 | 1 |
| 6.0.3 | 7.1.0-beta | 2/4 = 50% | 0 | 0 | **1 例 / 2 条** | 0 |

两版同码同条数、只是锚点不同：按新口径计入 misanchor，**不再同时污染 fp 与
miss 两侧**，跨版本对照时可以直接看出「判定一致、位置口径不同」。

## 结论 5：三档自比在官方默认值下仍是 100%

`config/baselines.json` 改成官方默认值之后（5.9：ES5/CommonJS/Node10/strict off；
6.0：ES2025/ES2022/Bundler/strict on；7.1：ES2026 同理），三档自比：

| 期望源 = 适配器 | 覆盖 | 假阳性 | 漏报 | 错锚 |
| --- | --- | --- | --- | --- |
| 5.9.3 | 31/31 = 100% | 0 | 0 | 0 |
| 6.0.3 | 48/48 = 100% | 0 | 0 | 0 |
| 7.1.0-beta | 48/48 = 100% | 0 | 0 | 0 |

## 结论 6：官方基线可以作为期望源（v0 子集）

`--expectation-source official-baseline` 直接读 `tests/baselines/reference/*.errors.txt`
的错误摘要块。v0 可消费子集 = plain 名基线（无多值指令变体）、无绝对路径 `@filename`、
基线无语法/配置错误；在 strada 6.0 语料上约 3,816 例可消费，取 191 例抽样，
以同版本 tsc 6.0.3 作适配器：

| 指标 | 数值 |
| --- | --- |
| 跑 / 跳过 | 191 / 0 |
| 完全通过 | 187 |
| 假阳性 | 2 例 / 12 条（TS18026×4、TS1434×3、TS1134×2、TS1002、TS1109、TS1490） |
| 覆盖 | 1338/1342 = 99.7% |
| 漏报 | 4 条（TS2441×2、TS2322×1、TS4023×1） |
| 错锚 | 0 |

已知偏差：官方基线来自仓库源码快照（strada `b465fdbf`），与 npm 上发布的
`typescript@6.0.3` 补丁不完全一致，所以「基线期望 × 同版本 npm tsc 适配器」仍有
2 例假阳性、4 条漏报。正式口径前要么改用与基线同源的编译器，要么把这些点位登记豁免。

## 局限

- 冒烟集每档只有 28 例、官方基线子集只抽了 191 例，指标不能外推；报「通过率」之前必须先对齐口径。
- 官方基线只接了 plain 名子集：多值指令变体（约 1,200 例）、语法错误基线（约 1,065 例）、
  配置错误基线（约 309 例）、绝对路径 `@filename`（约 659 例）暂不可消费。
- 官方基线来自仓库源码快照，与 npm 补丁版本存在少量逐条差异（见结论 6），暂未做豁免登记。
- 7.1 基线暂时复用 strada 语料。

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

# 官方基线子集（先扫描可消费清单，再跑）
bun scripts/select-official-baseline-cases.ts --corpus "$TSC_COMPA_CORPUS" --limit 200
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" \
  --expectation-source official-baseline --cases config/official-baseline-cases.json \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# 锚点用例
bun src/run.ts --baseline 6.0.3 --corpus ../reference/typescript-strada/tests/cases \
  --cases config/anchor-cases.json --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc
```

结果写 `.cache/run/{metrics,details}.json`。

## 后续

- [x] 对齐官方 harness 默认值（结论 2/5）；
- [x] 官方基线 v0 子集接入（结论 6）；
- [ ] 多值指令变体基线与官方配置命名（扩大官方基线覆盖面）；
- [ ] 与基线同源的编译器构建，消除「仓库快照 vs npm 补丁」偏差；
- 扩大样本（按码族/目录分层抽样）并接到公开仓 workflow 矩阵；
- 基于这批数据回答「是否长期保留 5.9 基线」：目前看 5.9 与 6.0/7.1 的差异
  主要是默认值漂移 + 少量模块上下文差异，保留 5.9 的成本主要是语料与期望
  维护，收益是能证明「承接 5.9 项目」的能力。

## 计时（--bench，2026-11-15 演示）

与正确性验证彻底分开：头条口径是真实项目目录上的 Check 相位（tsc 系实现用 --extendedDiagnostics 自报）；没有相位输出的实现退回 wall 并标注不可横比。

项目：maat/ts（TypeScript 实现源码，带 tsconfig）。命令见 docs/DESIGN.md 6.5。

warm（第 2-5 轮中位）：
- tsc 6.0.3：Check 1145.0ms / Parse 210.0 / Bind 110.0 / Total 1520.0 / 启动其它 55.0 / 诊断 0 / warm wall 1599.7
- tsc 7.1.0-beta：Check 161.0ms / Parse 22.0 / Bind 6.0 / Total 189.5 / 启动其它 0.5 / 诊断 0 / warm wall 261.3
- maat（含渲染）：wall 51.6ms / 诊断 32（wall-fallback，不可与 Check 横比）
- maat（--noMessages）：wall 56.1ms / 诊断 32（同上）

cold（第 1 轮）：
- tsc 6.0.3：Check 1130 / Total 1510 / wall 1593.9
- tsc 7.1.0-beta：Check 158 / Total 191 / wall 267.1
- maat（含渲染）：wall 62.3
- maat（--noMessages）：wall 49.8

读法：tsc 6.0.3 与 7.1.0-beta 的 Check 相位差一个数量级；maat 只有 wall 回退数字（含进程启动与 32 条诊断渲染），不可与 Check 相位横比。--noMessages 在本例没有收益（诊断少、渲染占比小），作为渲染附加档保留。本条目只演示口径，不外推性能结论。

结果 JSON：out/bench-project-demo2/bench-project.json。
