# 多基线冒烟结果与默认口径差异

日期：2026-11-15
环境：macOS arm64 本机；Bun 1.4.4；语料为 `microsoft/TypeScript` 的 `tests/cases`
（6.0 strada 语料与 5.9 发布 tag `v5.9.3` 两套；6.0 语料自 2026-11-16 起 pin 到
v6.0.3 tag `050880ce`，此前是 strada 分支快照 `b465fdbf`）；tsc 5.9.3 / 6.0.3 /
7.1.0-beta 三个版本经 npm alias 装在 `node_modules/typescript-*`。
冒烟集为 `config/smoke-cases.json`（strada 28 例）与 `config/smoke-cases-5.9.json`
（5.9 语料 28 例），**样本很小，以下数字都不是兼容性结论**。

2026-11-16 追记：官方基线的语料 pin 已对齐 npm 包的 gitHead（6.0.3 →
`050880ce`，TS7 官方基线 → `3e92363`），复跑对照见结论 11；结论 6/7/10 里的旧
pin 数字保留为历史记录。

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
| `6.0.3` | `typescript-6-0` | strada（v6.0.3 tag `050880ce`） | `smoke-cases.json` | `--noEmit --ignoreConfig --pretty false` |
| `7.1.0-beta` | `typescript-7-1` | strada（v6.0.3 tag `050880ce`） | `smoke-cases.json` | `--noEmit --ignoreConfig --pretty false` |

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

已知偏差（2026-11-16 追记）：当时语料是 strada 分支快照 `b465fdbf`，与 npm 上的
`typescript@6.0.3`（gitHead `050880ce`）不是同一提交。把 pin 对齐到 v6.0.3 tag 后
复跑同一 191 例，结果逐项不变（结论 11）：这 2 例假阳性、4 条漏报来自 harness
保真度缺口（UTF-16 用例、`@pretty` 基线、`--noEmit`/emit 指令），不是仓库快照与
npm 补丁的逐条差异。

## 结论 7：TS7 官方基线（T0–T3）与 ratchet（v0）

配置：`7.1.0-beta-official`——tsc 仍用 7.1.0-beta，但期望源换成 TS7 Go 仓
`microsoft/TypeScript@aa814927…` 的官方 `tsc/testdata/baselines/reference`
（pin 取自 reference/tsc-rs 的 `vendor/typescript-native/7.1.0-dev-aa814927/manifest.json`）。
冒烟集 28 例（18 有错 + 10 无错，`select-smoke.ts --errors 18 --clean 10` 生成）；
另跑 120 例错误用例做扩展样本（`config/official-baseline-cases-ts71.json`）。
2026-11-16 起 pin 改为 npm 包的 gitHead `3e92363`，复跑数字不变（见结论 11）。

| 运行 | 用例 | ≥T0 location | ≥T2 text | T3 full | messageMismatch | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| tsc 7.1.0-beta 自比（冒烟 28） | 28 | 28（100%） | 28 | **28** | 0 | 修正基线映射后 0 假阳性；T3 整份渲染见结论 10 |
| tsc 7.1.0-beta 自比（错误样本 120） | 120 | 119（99.2%） | 118（98.3%） | **118** | 1 | 2 例归因见结论 11（与 pin 无关） |

**修正记录（2026-11-15）**：本表初版里 tsc 自比只有 22/28、6 例 none，并把原因归为
「npm 补丁与仓库快照漂移」——那是错的。根因是 `baselineFileOf` 只按「id 相对路径」
和「根目录平铺」两档找基线，漏了 TS7 Go 布局把 conformance 子目录**拍平**到
`baselines/reference/conformance/<basename>.errors.txt` 的第三档，导致 6 个 conformance
用例被当成「无基线=无期望错误」。修好映射后 tsc 自比与第三方实现（tsrs）都是
28/28、0 假阳性、覆盖 76/76 = 100%。


读法：T0−T2 = 判定/锚点一致但首行文案不同；T2−T3 = elaboration/related 文本与
顺序未对齐。T3 的整份渲染能力已在 2026-11-15 后续实现，见结论 10（120 例自比
T3 由 0 升到 118/120）。

ratchet：`--ratchet config/ratchet-ts71-official.tsv` 当前登记 28 例（≥T0），
复跑无回落、清单幂等；回落会以非零退出，CI 用同一份清单门禁。清单只记门禁档
T0–T2（T3 full 归一为 text、不判红），因此 full → text 不算回落。2026-11-15 修
基线映射后一次运行改善 6 例（原 22 例 → 28 例）。

## 结论 8：第三方实现接入（tsrs / oxc-tsrs）

`tsrs` 是 oxc 生态的 TS7 兼容实现（Rust），CLI 与 tsc 兼容、支持
`--extendedDiagnostics`/`--singleThreaded`，pin 的 TS7 提交（`3e9236361fa9`）
与 tsc-compa 的 7.1.0-beta 一致。它通过现有 `tsc-cli` 适配器直接驱动
（`config/implementations.json` 登记获取方式），不需要写内部适配器。

| 运行 | 用例 | 完全通过 | 假阳性 | 覆盖 | 分档 |
| --- | --- | --- | --- | --- | --- |
| tsrs 0.25.0（npm）× `7.1.0-beta-official` | 28 | 28 | 0 | 76/76 = 100% | T2 24 / T3 4（整份渲染后 T3 28/28，见结论 10） |
| tsrs 0.21.0（源码构建）× `7.1.0-beta-official` | 28 | 28 | 0 | 76/76 = 100% | T2 24 / T3 4（整份渲染后 T3 28/28，见结论 10） |
| tsrs 0.21.0 × `7.1.0-beta`（strada 现场期望） | 28 | 28 | 0 | 48/48 = 100% | T2 13 / T3 15 |

同批对照：`tsc-rs`（kazhiramatsu）与 `ts-rust`（pingdotgg）源码构建二进制在
同一冒烟集上结果与 tsrs 一致（28/28、0 fp；构建与相位能力见任务报告）。


## 结论 9：兼容性跑附带的性能附录（v0，2026-11-15）

本地演示（TS7 官方基线冒烟 28 例；语料是本地 `reference/typescript` 快照，与配置 pin 不同，
仅验证管线；性能样本 20 例、seed 固定、顺序对半对冲）：

| 实现（适配器） | 正确性 | Check 累加比 | 逐案 Check 中位数 | 备注 |
| --- | --- | ---: | ---: | --- |
| tsc 7.1.0-beta 自比（tsc-cli） | 自洽 | 0.992 | 0.995 | sanity，≈1 |
| tsrs 0.25.0（tsc-cli:<bin>） | 28/28 通过、覆盖 100% | 0.365 | 0.366 | P25 0.359 / P75 0.373 |

- 用时增量：28 例正确性 + 20 例样本，自比 10.7s、tsrs 6.7s；参考跑约 3.7s（≈185ms/案），
  按 300 例约 55s，在「≤1 分钟」预算内。样本组成示例：compiler 16 / conformance 4，行数档 <=50 18 / 51–200 2，
  错误 17 / 无错 3，对冲顺序 10/10。
- tsc-cli 适配器解析 `--extendedDiagnostics` 回填 `checkMs`，因此任何 tsc 风格实现（tsrs/tsc-rs/ts-rust）
  都能直接得到 Check 比值；只输出单行诊断、没有 Check 相位的实现要进同一张表，需要实现侧
  自报每案检查耗时（或批量协议 `checkMs`），这是 M 级后续。
- 不门禁：不参与退出码；结果只在 `metrics.json.perf`。

## 结论 10：T3 整份基线与 elaboration 渲染（v1，2026-11-15）

改动：`tsc-cli` 适配器解析 `--pretty false` 输出时保留每条诊断的缩进阐述/related
续行与顺序（`CaseOutcome.fullText` / `Diagnostic.fullText`）；期望侧只比较
`.errors.txt` 第一个 `====` 之前的摘要块。改前 T3 全灭的一半原因是把 `====` 后的
源码标注也算进了期望文本。`totals.t3Failures` 新增未达原因：
missing / extra / diagnostics / order / elaboration / related / other。

| 运行 | 用例 | T3 full（改前 → 改后） | 未达归因 | 备注 |
| --- | --- | --- | --- | --- |
| tsc 7.1.0-beta 自比 | 28 | 4 → **28** | 0 | 0 假阳性 |
| tsc 7.1.0-beta 自比（错误样本 120） | 120 | 0 → **118** | diagnostics×2 | pin 对齐后仍在（结论 11）：`complicatedIndexedAccessKeyofReliesOnKeyofNeverUpperBound`（文案差）、`conflictingTypeParameterSymbolTransfer`（位置差） |
| tsrs 0.25.0（npm） | 28 | 4 → **28** | 0 | 与 tsc 自比完全一致 |
| tsrs 0.25.0（npm，错误样本 120） | 120 | — → **118** | diagnostics×2 | 同上两例 |

口径与偏差：当时本地语料是 `reference/typescript` 的 b7917e5 快照，与配置 pin
`aa814927` 不同。2026-11-16 已把 pin 对齐 npm gitHead `3e92363` 并以该 pin 复跑，
120 例仍是 118/120（结论 11）：剩 2 例分别因未传官方 harness 固定的
`--noErrorTruncation`（文案截断）与无冒号指令行的剥离规则不同（行号 -2），都不是
语料版本问题。`tsc-cli` 系适配器（含第三方 tsc 兼容实现）只要能提供多行输出即可
参与 T3；只有单行 message 的实现最多到 T2。T3 仍是报告档，未达不判红。

## 结论 11：官方基线 pin 对齐 npm gitHead 后的复跑（v1，2026-11-16）

背景（#7 审计）：`config/baselines.json` 的两个官方基线语料 pin 都不是 npm 包的发布
提交——6.0.3 用 strada 分支快照 `b465fdbf`（与 v6.0.3 分叉：33 ahead / 11 behind），
7.1.0-beta-official 用 `aa814927`（比 `typescript@7.1.0-beta` 的 gitHead `3e92363` 早
53 个提交）；审计推测这是 6.0 官方基线「2 例假阳性 / 4 条漏报」与 TS7「2 例 T3 未达」
的原因。本次把 pin 对齐到 npm gitHead 后复跑同一批用例：**指标逐项不变；残留项与 pin
无关，全部可归因到 harness 保真度缺口**。

pin 变更与依据：

| 语料 | 旧 ref | 新 ref | 依据 |
| --- | --- | --- | --- |
| `strada`（6.0.3 与 7.1.0-beta 共用） | `b465fdbf…`（strada 分支快照，2026-07-28） | `050880ce…` | `node_modules/typescript-6-0/package.json.gitHead`；提交 "Bump version to 6.0.3 and LKG"，2026-04-15，即 v6.0.3 tag |
| `ts71-official` | `aa814927…` | `3e92363…` | `node_modules/typescript-7-1/package.json.gitHead`；"Merge remote-tracking branch 'origin/main' into release-7.1"，2026-10-19；与 tsrs / ts-rust 登记的 upstreamPin 一致 |

语料获取：6.0.3 从本地 `reference/typescript` 完整克隆
`git archive 050880ce… tests/cases tests/baselines/reference` 取出；TS7 用 GitHub
codeload 下载 `3e92363` 的源码包，只解出 `tsc/testdata/{tests/cases,baselines/reference}`。
CI 的 workflow 不硬编码 pin，`smoke.yml` 与 `ts7-official.yml` 都从
`config/baselines.json` 现场解析 ref（`third-party.yml` 原本如此），改配置即生效；
两份语料里 191 例 / 120 例 manifest 的用例全部存在。新增 `test/baseline-pins.test.ts`
断言两个官方基线语料的 ref 等于对应 npm 包的 gitHead、且 CI workflow 保持配置驱动
（不硬编码 SHA），防止再次漂移。

复跑（同机 macOS arm64、Bun 1.4.4、tsc 走 npm alias；命令按 #11 后的 CI 口径加
`--gate`）：

| 运行 | 指标 | 旧 pin | 新 pin |
| --- | --- | --- | --- |
| 6.0.3 官方基线 191 例 | 跑 / 跳 | 191 / 0 | 191 / 0 |
| | 完全通过 | 187 | 187 |
| | 假阳性 | 2 例 / 12 条 | 2 例 / 12 条 |
| | 覆盖 | 1338/1342 = 99.7% | 1338/1342 = 99.7% |
| | 漏报 | 4 条 | 4 条 |
| | T3 full | 185/191 | 185/191 |
| TS7 官方基线 120 例 | T3 full | 118/120 | 118/120 |
| | 分档 | none=1、category=1 | none=1、category=1 |
| | 假阳性 / 漏报 | 0 / 0 | 0 / 0 |
| | 错锚 | 1 例 / 2 条 | 1 例 / 2 条 |

**数字不变的原因**：对两批样本做逐字节哈希比对——191 例的 case 与 `.errors.txt` 在
旧 pin（strada `b465fdbf` 检出）与新 pin（v6.0.3 tag）下都是 191/191 一致；TS7 120 例
的 case 与基线在 `aa814927` 与 `3e92363` 下都是 120/120 一致。**该逐字节一致只覆盖这
两批样本**：TS7 全语料在两个 pin 之间实际有差异（cases 2 改 / 145 增、baselines 19 改
/ 469 增），只是都不在 120 例样本内。6.0 全语料层面，两个 pin 的 `tests/cases` 没有
文件差异，只有 29 个基线文件不同：28 个是 TS1344 文案差异、1 个是 lib 补全基线
（`completionsStringMethods.baseline`），其中 12 个带多值指令变体后缀（如
`(alwaysstrict=true)`）；这些也都不在 191 例样本内。因此「pin 漂移解释 2 fp/4 miss /
2 例 T3」的假设不成立。

残留项逐条归因（均为 harness 与我们消费方式的差距，与 pin 无关）：

| 运行 | 用例 | 现象 | 根因 |
| --- | --- | --- | --- |
| 6.0 | manyCompilerErrorsInTheTwoFiles | 期望 0 条、实际 11 条语法错误（11 条假阳性） | 用例带 `@pretty: true`，官方基线是 ANSI 着色格式；`parseOfficialBaselineText` 只认 `file(line,col): error TS…` 平文本，读成 0 条期望 |
| 6.0 | promiseTest | 假阳性 TS1490、漏报 TS2322 | 用例文件是 UTF-16LE（BOM `FF FE`）；`case.ts` 按 UTF-8 读成 NUL 交错乱码，tsc 报 TS1490 "File appears to be binary" |
| 6.0 | collisionExportsRequireAndAlias | 漏报 TS2441×2 | TS2441 用 `errorSkippedOn("noEmit")` 注册；官方 harness 正常 emit，`tsc-cli` 适配器固定传 `--noEmit`，该诊断被跳过（去掉 `--noEmit` 单跑可复现 2 条） |
| 6.0 | declarationEmitComputedPropertyNameSymbol2 | 漏报 TS4023 | 期望来自 `@declaration` + `@emitDeclarationOnly` 的 declaration emit；这两个指令在 v0 忽略列表，适配器又固定 `--noEmit`，不会产生该诊断 |
| 6.0 | esModuleInteropDefaultImports、parserRealSource14 | T3 未达（tier=text / category） | 续行或消息里带临时目录绝对路径（`import("/var/folders/…/mod")`、`File '/var/folders/…/typescript.ts' not found`）；目前只归一诊断首行路径 |
| TS7 | complicatedIndexedAccessKeyofReliesOnKeyofNeverUpperBound | tier=category（位置一致、首行文案差） | 适配器没传官方 harness 固定的 `--noErrorTruncation`，长类型被截成 `ChannelOfType<...>`；补上该参数后该例 T3 一致 |
| TS7 | conflictingTypeParameterSymbolTransfer | tier=none（同码不同位，2 条错锚） | 用例第 2 行是无冒号的 `// @strict`；官方 Go harness 的指令正则要求 `@name:`，该行按普通注释留在源文本，而 tsc-compa 的解析器两种写法都剥离，源文本少 2 行，行号整体 -2（只删 `@target` 行后单跑正好复现基线的 13/29 行） |

这些缺口（pretty 基线、UTF-16、`--noEmit`/emit 指令、续行路径归一、
`--noErrorTruncation`、无冒号指令行）都可以单独修掉，但都不属于 #7 的 pin 对齐
范围；本结论先把它们登记清楚，#7 的验收按「只剩可解释项」处理。

CI 口径复核（本地按 #11 后的 workflow 命令等值跑）：

- 三档自比（`--gate` 零差异）：5.9.3 / 6.0.3 / 7.1.0-beta 各 28/28，假阳性、漏报、
  错锚全 0，门禁通过；
- `7.1.0-beta-official` 28 例 + ratchet（T0–T2 门禁档）+ `--gate`：T3 full 28/28，
  ratchet 无回落、无写回（#11 已把清单归一为 T0–T2，「清单停在 T3 渲染前、会写回
  24 例 text→full」的陈旧问题由 #11 一并解决），门禁通过；
- `6.0.3` 官方基线子集 191 例 + `--gate-max-fp 12 --gate-max-miss 4
  --gate-min-coverage 0.99`：fp 12 条、miss 4 条、覆盖 99.7%，门禁通过——阈值正好
  卡在实测值上，pin 对齐没有改变它们；
- `ts7-official.yml` 尚未在 GitHub 实际 dispatch（本地按同一命令跑通），合并后需手动
  触发一次，才算 #7 的「CI 用新 pin 跑通」验收完成；在那之前 `smoke.yml` 的
  7.1.0-beta-official 档已覆盖同一组 28 例。

## 局限

- 冒烟集每档只有 28 例、官方基线子集只抽了 191 例，指标不能外推；报「通过率」之前必须先对齐口径。
- 官方基线只接了 plain 名子集：多值指令变体（约 1,200 例）、语法错误基线（约 1,065 例）、
  配置错误基线（约 309 例）、绝对路径 `@filename`（约 659 例）暂不可消费。
- 官方基线语料 pin 已对齐 npm gitHead（结论 11）；残留的假阳性/漏报/T3 未达是
  harness 保真度缺口（UTF-16 用例、`@pretty` 基线、`--noEmit`/emit 指令、续行绝对
  路径、`--noErrorTruncation`、无冒号指令行），不是语料版本差异，逐条归因见结论 11。
- T3 已支持整份基线渲染（结论 10）：期望只取 `====` 前摘要块，实现侧用
  `CaseOutcome.fullText`；仍不是门禁档。
- 7.1 的普通基线（`7.1.0-beta`）与 6.0.3 共用 v6.0.3 tag 的 strada 语料；官方基线
  走单独的 `ts71-official` 语料 pin。

## 复现

```bash
# 5.9 语料（本地浅克隆 tag）
git clone --depth 1 --branch v5.9.3 --single-branch \
  https://github.com/microsoft/TypeScript /tmp/tsc-compa-corpus-5.9

# 6.0.3 语料：microsoft/TypeScript@v6.0.3（npm gitHead 050880ce），cases 在 tests/cases
git clone --depth 1 --branch v6.0.3 --single-branch \
  https://github.com/microsoft/TypeScript /tmp/tsc-compa-corpus-6.0.3
export TSC60_CORPUS=/tmp/tsc-compa-corpus-6.0.3

# 自比（三档；按 #11 的门禁口径加 --gate）
bun src/run.ts --baseline 5.9.3 --corpus /tmp/tsc-compa-corpus-5.9/tests/cases \
  --adapter tsc-cli:node_modules/typescript-5-9/bin/tsc --gate
bun src/run.ts --baseline 6.0.3 --corpus "$TSC60_CORPUS/tests/cases" \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc --gate
bun src/run.ts --baseline 7.1.0-beta --corpus "$TSC60_CORPUS/tests/cases" \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc --gate

# 5.9 期望 × 6.0.3 适配器（默认口径 → 对齐口径）
bun src/run.ts --baseline 5.9.3 --corpus /tmp/tsc-compa-corpus-5.9/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc
bun src/run.ts --baseline 5.9.3 --corpus /tmp/tsc-compa-corpus-5.9/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --base-arg strict=false --base-arg target=es2015

# 官方基线子集（语料同 v6.0.3；--expectation-source 读 tests/baselines/reference 的 .errors.txt；
# 按 #11 的 CI 门禁口径带阈值）
bun scripts/select-official-baseline-cases.ts --corpus "$TSC60_CORPUS/tests/cases" --limit 200
bun src/run.ts --baseline 6.0.3 --corpus "$TSC60_CORPUS/tests/cases" \
  --expectation-source official-baseline --cases config/official-baseline-cases.json \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --gate --gate-max-fp 12 --gate-max-miss 4 --gate-min-coverage 0.99

# TS7 官方基线冒烟（T0–T3 + ratchet + gate）
# 语料：microsoft/TypeScript@3e92363（= npm typescript@7.1.0-beta gitHead），
#       Go 布局：cases 在 tsc/testdata/tests/cases，基线在同级 baselines/reference
bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus /tmp/ts71-corpus/tsc/testdata/tests/cases \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc \
  --expectation-source official-baseline --mode official \
  --cases config/smoke-cases-ts71-official.json \
  --ratchet config/ratchet-ts71-official.tsv \
  --gate

# 锚点用例
bun src/run.ts --baseline 6.0.3 --corpus "$TSC60_CORPUS/tests/cases" \
  --cases config/anchor-cases.json --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc
```

结果写 `.cache/run/{metrics,details}.json`。

## 后续

- [x] 对齐官方 harness 默认值（结论 2/5）；
- [x] 官方基线 v0 子集接入（结论 6）；
- [x] TS7 官方 Go 布局基线（缺基线=无错）、T0–T3 分档与 ratchet（结论 7）；
- [x] T3 整份基线渲染（elaboration/related/顺序；结论 10）；
- [x] 官方基线语料 pin 对齐 npm gitHead 并复跑对照（结论 11）；
- [ ] 修 harness 保真度缺口：pretty 基线、UTF-16 用例、`--noEmit`/emit 指令、续行
  路径归一、`--noErrorTruncation`、无冒号指令行（结论 11 的残留项归因）；
- [ ] 多值指令变体基线与官方配置命名（扩大官方基线覆盖面）；
- [ ] 与基线同源的编译器构建（pin 对齐已先行，见结论 11）；
- 扩大样本（按码族/目录分层抽样）并接到公开仓 workflow 矩阵；
- 基于这批数据回答「是否长期保留 5.9 基线」：目前看 5.9 与 6.0/7.1 的差异
  主要是默认值漂移 + 少量模块上下文差异，保留 5.9 的成本主要是语料与期望
  维护，收益是能证明「承接 5.9 项目」的能力。
