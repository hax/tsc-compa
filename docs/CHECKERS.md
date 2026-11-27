# 候选检查器目录

想判断某个固定版本是否适合你的 TypeScript 项目，先在[公开报告站](https://johnhax.net/tsc-compa/)选候选、参考配置和测试集。没有公开报告的候选，可先查下文的 Linux 适配器冒烟，再用自己的项目配置复测。本文列的是 tsc-compa 固定和验证过的配置，不是各项目的版本发布表或支持承诺。

## 登记和公开范围

第三方实现的机器可读登记是 [`config/implementations.json`](../config/implementations.json)：获取方式、完整提交、适配器、固定参数和可配对的参考配置以它为准。安装用 [`scripts/install-impl.ts`](../scripts/install-impl.ts)，本地运行参数见[技术参考](REFERENCE.md)。下表只摘录用于辨识和复查报告的版本，不另设一份运行配置。

登记有 **6 个第三方条目、5 个实现家族**（Bun 有两个版本）；将官方 TypeScript 对照也计入，共 **6 个家族**。其中只有 **4 个配置、3 个家族**可在公开评测中选择：官方 TypeScript 7.1.0-beta、Bun 1.4.4、Bun 1.4.5 和 tsrs CLI。公开候选的工作流选择值见 [CI 指南](CI.md#公开评测与报告目录public-evaluationyml)。

| 候选或登记名 | 固定版本、来源和适配器 | 已有证据 |
| --- | --- | --- |
| 官方 TypeScript（`typescript`） | `typescript@7.1.0-beta`，`tsc-cli`；公开评测的官方对照 | 公开固定样本和全量报告；另有官方 CLI／API 校验和回归记录 |
| `bun-check-1.4.4` | `oven-sh/bun` Release `bun-v1.4.4`，`bun-check`；内置 TypeScript 自报 `7.0.2` | Linux 冒烟；公开固定样本和全量报告 |
| `bun-check-1.4.5` | `oven-sh/bun` Release `bun-v1.4.5`，`bun-check`；内置 TypeScript 自报 `7.0.2` | Linux 冒烟；公开固定样本和全量报告 |
| `tsrs`（oxc-tsrs） | npm `tsrs@0.25.0-ts7.1.0-beta`，`tsc-cli`；自报跟踪 TypeScript 提交 `3e9236361fa9` | Linux 冒烟、回归记录；公开固定样本和全量报告 |
| `ts-rust`（pingdotgg） | npm **`tsc-rs@0.8.0`**，`tsc-cli`；登记的对齐目标为 `7.1.0-beta`／`3e9236361fa9`，本次 Linux CLI 自报 `Version 7.1.0-dev` | Linux 冒烟、回归记录；不在公开评测目录 |
| `tsc-rs`（kazhiramatsu） | Cargo 构建，固定源码提交 **`2b006e0`**，`tsc-cli`；本次自报 `Version 7.1.0-dev` | Linux 冒烟、回归记录；不在公开评测目录 |
| `tsz` | Cargo 构建，固定源码提交 **`0b4641a`**，`tsc-cli`；本次自报 `Version 7.0.2` | Linux 冒烟；不在公开评测目录，无入库回归记录 |

官方参考二进制由 [`package.json`](../package.json) 和 [`bun.lock`](../bun.lock) 固定为 TypeScript `5.9.3`、`6.0.3`、`7.1.0-beta`。[`config/baselines.json`](../config/baselines.json) 另固定测试集提交与默认选项：`7.1.0-beta` 用 6.0.3 的 strada 测试集和现场参考诊断；`7.1.0-beta-official` 用同一个 7.1 CLI 版本对应的 Go 布局测试集及官方 `.errors.txt`，提交为 `3e9236361fa97a9e6c685f4833ac457ae2d8c50a`。公开评测只用后一种参考配置；5.9.3 和 6.0.3 虽也用作本仓的自比对照，但不是公开候选选项。

版本号各有用途：候选的发布包或构建提交用于复现；登记的 TypeScript 对齐目标和 CLI 自报版本需要分开读。比如 `ts-rust` 的 npm 包名与 kazhiramatsu 的项目名相同，但不是同一个实现；其自报版本与登记的对齐目标分别保留，不把自报值当作源码提交的证据。`tsrs` 自报的 TypeScript 提交不是 `tsrs` 自身的源码提交。核对实际产物时，请看报告的版本和 SHA-256；启动器的摘要也不能替代原生二进制的摘要。对某个参考配置跑通测试，不等于候选覆盖该 TypeScript 版本的全部语言行为或编译选项。

自有二进制可按接口选 `tsc-cli:<bin>` 或 `checker-batch` 在本地或自有 CI 运行，也可按[受控原生检查器流程](NATIVE-CHECKERS.md)提供受信任的 Linux x64 Release asset。后者使用 `checker-batch`，不支持按用例切换编译选项，不给兼容性结论，也不自动发布到 Pages。自有二进制是接入方式，不是登记的第三方实现家族。

## Linux 适配器冒烟：28 例

[Actions 运行 45961457505](https://github.com/hax/tsc-compa/actions/runs/45961457505) 在 Linux x64 用 Bun 1.4.5 运行测试工具，选择同一份 [TS7 官方 28 例用例列表](../config/smoke-cases-ts71-official.json)，与上述固定提交的官方 `.errors.txt` 对照。以下来自每个 `adapter-smoke-<id>` 产物的 `metrics.json` 和 `details.json`。六个候选任务都通过执行检查，无崩溃或超时；**任务通过不表示两档诊断判定通过**。工作流允许明确跳过和诊断差异，不使用回归记录作门禁。

两档均按「通过 / 失败 / 无法确认」列数，只计入已完成比较的用例。必要字段缺失（例如文本接口未提供消息链或 related 信息）记为「无法确认」，不是通过；具体判定见[两档比较规则](REFERENCE.md#11-两档比较与回归判定规则)。

| 候选任务 | 可比较 / 跳过 | 兼容 | 严格一致 |
| --- | ---: | ---: | ---: |
| [Bun 1.4.4](https://github.com/hax/tsc-compa/actions/runs/45961457505/job/140380044028) | 27 / 1 | 27 / 0 / 0 | 3 / 0 / 24 |
| [Bun 1.4.5](https://github.com/hax/tsc-compa/actions/runs/45961457505/job/140380044066) | 27 / 1 | 27 / 0 / 0 | 3 / 0 / 24 |
| [tsrs CLI](https://github.com/hax/tsc-compa/actions/runs/45961457505/job/140380043992) | 28 / 0 | 28 / 0 / 0 | 4 / 0 / 24 |
| [ts-rust](https://github.com/hax/tsc-compa/actions/runs/45961457505/job/140380043994) | 28 / 0 | 28 / 0 / 0 | 4 / 0 / 24 |
| [tsc-rs](https://github.com/hax/tsc-compa/actions/runs/45961457505/job/140380044051) | 28 / 0 | 28 / 0 / 0 | 4 / 0 / 24 |
| [tsz](https://github.com/hax/tsc-compa/actions/runs/45961457505/job/140380044049) | 27 / 1 | 27 / 0 / 0 | 3 / 3 / 21 |

六个候选都命中了各自可比较用例中的 76 条参考诊断。两个 Bun 都因继承的 `target=es2026` 跳过 `compiler/inferenceWithNeverSource1.ts`；适配器不会将它换成 `esnext`。tsz 在同一例输出无文件位置的 TS6046，拒绝了该 `target`，因此没有纳入比较；另有 3 例诊断的补充说明不同，严格档失败。

Bun 候选使用固定的 Release 二进制，不用当前运行测试工具的 Bun 代替。`bun-check` 为每例生成 `tsconfig` 并解析文本诊断；涉及声明生成阶段的配置（如 `declaration` 或 `composite`）会跳过，不用普通类型诊断代替。`tsz` 的固定提交需要 `CI=1` 和外置 `CARGO_TARGET_DIR` 构建；其计时合并 Parse 与 Bind，不应与分别报告的阶段耗时直接比较。

## 公开报告：固定样本和全量类型检查测试集

2026-11-27 的 [Pages 报告索引](https://johnhax.net/tsc-compa/reports/index.json)包含以下四个配置的两种测试集。四份固定样本报告都是 **120 可比较、0 跳过、120 兼容、120 无法确认严格一致**（严格档无通过或失败），命中 385/385 条参考诊断。120 例都显式设置了 `target`，因此 Bun 的样本结果不代表它能运行 TS7 参考配置的默认 `es2026`。

全量选取 `compiler/` 和 `conformance/` 的 12,974 个源文件，按选项展开为 **14,346 条配置记录**，分 8 片。下表仍用「通过 / 失败 / 无法确认」；诊断覆盖率是可比较范围内命中的参考诊断比例，不是 14,346 条记录中通过的比例。

| 候选 | 固定样本报告 | 全量报告 | 可比较 / 跳过 | 兼容 | 严格一致 | 诊断命中 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 官方 TypeScript 7.1.0-beta | [120 例](https://johnhax.net/tsc-compa/reports/552ae85613daa37c8f899507244ef86a28fba5199734cfc35d2b3cc59444d9f9.html) | [全量](https://johnhax.net/tsc-compa/reports/c39b32e929eef994d8ed3b952859aa8120fcee9485bbd04bc49d1ae27ad03603.html) | 9,212 / 5,134 | 9,169 / 43 / 0 | 4,829 / 77 / 4,306 | 24,060 / 24,133 |
| Bun 1.4.4 | [120 例](https://johnhax.net/tsc-compa/reports/1f9324afafdf8041f717b8187f7f3ff5d51129591da1b393a5d45da875b9c6ec.html) | [全量](https://johnhax.net/tsc-compa/reports/32517ad0f8abbac5e9327c138e75dad4bdb8b55177c351f854217861ce0b65eb.html) | 8,030 / 6,316 | 7,973 / 57 / 0 | 3,994 / 103 / 3,933 | 22,315 / 22,407 |
| Bun 1.4.5 | [120 例](https://johnhax.net/tsc-compa/reports/5f8b32b11e506848c69740d62ce22c4ac9f541f75f57b0804b0b69d0b27eac4e.html) | [全量](https://johnhax.net/tsc-compa/reports/95210b7a160de9186b2c25cca74f6747fdd1637ef126a0f4de9aab6269deb2f6.html) | 8,030 / 6,316 | 7,973 / 57 / 0 | 3,994 / 103 / 3,933 | 22,315 / 22,407 |
| tsrs CLI | [120 例](https://johnhax.net/tsc-compa/reports/27f8ff7652cf9b22d6e063fecdda50e1de1fba2d70e681d21a80075f77d04329.html) | [全量](https://johnhax.net/tsc-compa/reports/261be62fe7c7936d7d37649eb369a3cf204943184e1b6a8eb3f35dcec56798be.html) | 9,212 / 5,134 | 9,169 / 43 / 0 | 4,829 / 77 / 4,306 | 24,060 / 24,133 |

官方 CLI 对照也有跳过和差异：逐例用 CLI 比较官方测试运行器的结果文件，不是运行官方测试运行器本身。例如，参考结果含本工具无法解析的诊断时也会跳过。想定位某个项目相关的选项或差异，从公开报告进入该次 Actions 运行查逐案产物；不要把相同的汇总数字当作两个实现诊断完全相同。本地复跑方式和历史实验见[测试结果](RESULTS.md)。

## 回归记录和官方对照

TS7 官方基线入库的兼容回归记录有四份：[官方 CLI](../config/ratchet-ts71-official.tsv)、[tsrs CLI](../config/ratchet/tsrs-7.1.0-beta-official.tsv)、[ts-rust](../config/ratchet/ts-rust-7.1.0-beta-official.tsv)和 [tsc-rs](../config/ratchet/tsc-rs-7.1.0-beta-official.tsv)，各记 28 例。旧记录迁移后可保护兼容档，不能证明严格一致；两个 Bun 和 tsz 没有入库记录。记录与实际启用门禁是两回事，见[回归记录说明](../config/ratchet/README.md)。

[官方对照 CI 运行 45972207811](https://github.com/hax/tsc-compa/actions/runs/45972207811) 的产物中，TS7 CLI 对照官方结果文件完成 28/28，兼容 28，严格 4 通过、24 无法确认；兼容门禁通过，无回归。独立的 TS7 async API 自比完成 28/28，全部严格通过，未使用回归记录。TS6 的 [191 例官方结果子集回归记录](../config/ratchet/typescript-6.0.3-official.tsv)也单独维护；同一运行中完成 190 例、跳过 1 例，189 例兼容，兼容门禁通过且无回归。这些是对照与回归验证，不是新增公开评测选项。

## tsrs async API 试点

[`tsrs-async` 试点 PR #22](https://github.com/hax/tsc-compa/pull/22)单独跟踪结构化 API 接入，不替换公开的 tsrs CLI 候选，也不增加一个实现家族。候选使用同一 npm 版本的 `tsrs/async` SDK 和持久原生子进程，参考侧使用独立的官方 TS7 async API（`--expectation-source ts7-api`），不是公开报告所用的 `.errors.txt`。截至 2026-11-27，试点 PR 尚未合入 `main`。

PR 记录的本地验证（macOS arm64、Bun 1.4.5、对齐选项）：28 例全部运行且兼容，严格通过 27 例；120 例全部运行、兼容且严格通过。28 例中唯一严格差异是 `compiler/builtinIterator.ts` 的 TS6502 附加诊断（related info）指向字节相同的 `lib.es2025.iterator.d.ts`，但 npm 安装绝对路径不同。[试点 Linux 任务](https://github.com/hax/tsc-compa/actions/runs/45977982412/job/140434483579)的 28 例产物也记录了 28 例兼容、27 例严格通过、1 例严格失败，未跳过。该任务分别记录候选 SDK 入口和原生可执行文件的版本与摘要，检查执行和产物来源，不以诊断一致为门禁。API 可返回声明诊断，但不生成声明文件，也不提供逐案进程退出码。
