# tsc-compa 实现状态

整理日期：2026-11-23。对应本地代码基点 `972d743`，不代表已核查远端最新状态。
本轮只整理文档，未重新执行兼容性套件或核查 GitHub Actions 运行结果。

本文记录能力、配置、实现位置、已知缺口和待办。
设计思路见 [DESIGN.md](DESIGN.md)，参数和规则见 [REFERENCE.md](REFERENCE.md)，
演进背景见 [HISTORY.md](HISTORY.md)，
实测结果及复现命令见 [RESULTS.md](RESULTS.md)，CI 操作见 [CI.md](CI.md)。

## 1. 已实现能力

| 能力 | 实现范围／入口 |
| --- | --- |
| 用例解析与分类 | 指令解析、虚拟文件、静态及运行期标签、按标签过滤 |
| 多基线配置 | 三个参考 tsc 版本、不同语料引用及默认用例清单 |
| 两种期望来源 | 现场 tsc + 缓存；官方 `.errors.txt` 子集 |
| 逐案与批量适配器 | 参考 `tsc-cli`、检查器 CLI、通用 CLI、NDJSON 客户端与模拟实现 |
| 诊断差异 | 误报、漏报、错锚、诊断覆盖率、分类与诊断码聚合 |
| 一致性分档 | T0–T3、首行文本差异、T3 未达原因 |
| 防退步清单 | 按实现 × 基线隔离、非门禁初始化与改善写回、门禁只读检查 |
| 兼容性门禁 | 运行资格、至少一个用例完成比较、防退步与显式／默认阈值 |
| 报告 | Markdown、自包含 HTML、前后差异、CI 多档汇总 |
| 性能附录 | 固定分层样本、顺序对冲、Check／墙钟差分比值及告警 |
| 外部实现接入 | 实现登记、npm／本地／cargo 获取、二进制分发 workflow |

这些能力不代表全语料已经通过，也不代表所有官方测试框架行为都已复刻。

## 2. 基线与语料配置

实际配置以 `config/baselines.json` 为准：

| 基线配置 | 参考 tsc 别名 | 语料引用 | 默认用例清单 |
| --- | --- | --- | --- |
| `5.9.3` | `typescript-5-9` | `microsoft/TypeScript@v5.9.3` | `config/smoke-cases-5.9.json` |
| `6.0.3` | `typescript-6-0` | strada，固定提交 `050880ce…` | `config/smoke-cases.json` |
| `7.1.0-beta` | `typescript-7-1` | 与 6.0.3 相同的 strada 语料 | `config/smoke-cases.json` |
| `7.1.0-beta-official` | `typescript-7-1` | TS7 Go 布局，固定提交 `3e923636…` | `config/smoke-cases-ts71-official.json` |

`7.1.0-beta-official` 选择的是基线配置，不会自动切换期望来源；
读取官方诊断基线仍需显式传 `--expectation-source official-baseline`。

两个官方基线语料的固定提交已与对应 npm 包的 `gitHead` 对齐：
6.0.3 对应 `050880ce…`，7.1.0-beta 对应 `3e923636…`。
`test/baseline-pins.test.ts` 检查此关系和 workflow 的配置驱动，
不据此断言测试框架完全保真。

### 2.1 期望侧默认值

| 配置项 | 5.9.3 | 6.0.3 | 7.1.0-beta |
| --- | --- | --- | --- |
| `target` | ES5 | ES2025 | ES2026 |
| `module` | CommonJS | ES2022 | ES2022 |
| `moduleResolution` | Node10 | Bundler | Bundler |
| `strict` | false | true | true |
| 通用基础参数 | `--noEmit --pretty false` | 同左，增加 `--ignoreConfig` | 同 6.0.3 |
| 额外显式默认项 | `--skipDefaultLibCheck --noErrorTruncation` | 同左 | 同左 |

这些值用于现场生成期望，不自动注入被测适配器。
指令选项和额外参数的来源与顺序见 [技术参考 §1.3](REFERENCE.md#13-选项来源与优先级)。

默认值核对的上游源码位置沿用此前记录，本轮未重新审计上游源码。
以下是上游仓库路径，不是本仓库文件：

- JS 实现：`src/compiler/utilities.ts` 的计算选项与严格模式默认值、
  `src/compiler/types.ts` 的 `ScriptTarget.LatestStandard`、
  `src/harness/harnessIO.ts` 的 `compileFiles`；
- Go 实现：`tsc/internal/core/compileroptions.go` 的选项计算、
  `tsc/internal/testutil/harnessutil/harnessutil.go` 的 `CompileFiles`；
- 用例选项覆盖：JS 的 `setCompilerOptionsFromHarnessSetting`、
  Go 的 `SetOptionsFromTestConfig`。

上游测试框架还设置换行等运行条件，不能把上述 `baseArgs` 表理解为完整环境复刻。
默认值核对的历史与跨版本结果见 [RESULTS.md](RESULTS.md)。

## 3. 用例与期望来源的支持范围

### 3.1 用例解析与选择

- 虚拟文件允许 `.ts`、`.mts`、`.cts`，因此虚拟 `.d.ts` 文件也可被解析；
  `.tsx`、`.js`、`.jsx`、`.json` 等虚拟文件跳过。
- 含 `..` 路径段的虚拟路径跳过；绝对虚拟路径另行记录，
  官方基线来源拒绝这类用例，不能与相对路径物化等同处理。
- 支持的编译选项包括 strict 系、target、module、moduleResolution、lib 等；
  精确表见 `src/case.ts` 的 `OPTION_DIRECTIVES`。
- JS／JSX、外部类型、路径映射、工程布局等指令的跳过表见 `SKIP_DIRECTIVES`。
- emit、pretty、诊断截断等部分指令在 `IGNORED_DIRECTIVES` 中，不传递为选项；
  已知影响见第 5 节，不能将“被忽略”解释为“无影响”。
- 位于已开始的虚拟文件内容之间的其他指令记为未知形态并跳过；
  多值指令会被记录，尚未展开为多个配置用例。
- 默认冒烟集来自 `compiler`／`conformance`；
  `scanCorpus` 会递归发现 `.ts` 文件，不单独强制过滤套件目录。
  扫描候选范围不等于已支持或已验证范围。

`scripts/select-smoke.ts` 负责按类筛选、用参考 tsc 剔除语法错误用例并生成清单。
冒烟集每档 28 例；官方基线扩展样本另有 191 例和 120 例，不能外推为全量覆盖。

### 3.2 现场 tsc 期望

- 虚拟文件写入临时目录，诊断路径映射回用例内相对路径；
- 识别到 TS1xxx 或 TS17006／TS17007 时，按框架当前筛选规则将用例归为语法错误并跳过；
  这是当前分类规则，不声称这些用例绝无其他语义诊断；
- 缓存键包含文件路径与内容、参数、tsc 版本，目录为 `.cache/expectations/`；
- 缓存键未包含编译器二进制哈希或完整环境标识，
  同版本号二进制／环境替换时应核对缓存是否仍适用。

### 3.3 官方诊断基线

支持的布局：

| 布局 | 用例目录 | 基线目录 |
| --- | --- | --- |
| strada／JS | `tests/cases/` | `tests/baselines/reference/` |
| TS7／Go | `tsc/testdata/tests/cases/` | `tsc/testdata/baselines/reference/` |

查找依次尝试用例相对目录、套件内压平、根目录压平。
通过前置支持检查但没有对应 `.errors.txt` 时，按当前规则解释为期望零诊断。

仍跳过：

- 多值指令对应的配置变体；
- 绝对路径 `@filename`；
- 用例自身的 ID 以 `.d.ts` 结尾；这不同于普通用例包含虚拟 `.d.ts` 文件；
- 基线中的无位置配置错误或按当前规则识别的语法错误。

缺文件规则依赖完整语料和正确映射，程序不会仅凭这一规则证明语料没有漏下载。

## 4. 适配器与 CI 实现

### 4.1 内置适配器

| 适配器 | 执行形态 | 外部选项 | 说明 |
| --- | --- | --- | --- |
| `tsc-cli`／`tsc-cli:<bin>` | 逐案 | 支持 | 可驱动参考 tsc 或提供兼容 CLI 的第三方实现 |
| `checker-cli`／`checker-cli:<bin>` | 逐案 | 固定选项 | 检查器 JSON 输出，适合 fixed 模式验证 |
| `checker-batch` | 批量 | 固定选项 | 同一检查器的 `--batch` NDJSON 模式 |
| `cli:<bin>` | 逐案 | 声明为不支持 | 通用 CLI；不能据此给出 official 模式的合格结论 |
| `none` | 无实际进程 | 声明为支持 | 不报告诊断，用于测试误报／漏报路径 |
| `mock-batch` | 批量 | 支持 | 批量协议参考实现 |

`api` 是接口预留形态，适配器工厂尚未提供进程内实现。
批量客户端消费诊断的 `file`、`line`、`col`、`code`、`severity`、`width`、`message`，
但尚未透传诊断或结果级 `fullText`、结果级 `checkMs`。
因此不能仅凭接口定义推断批量接入具备完整 T3 文本或 Check 相位支持。

第三方实现登记包括 `tsrs`、`tsc-rs`、`ts-rust`、`tsz`，
版本、获取方式和参数以 `config/implementations.json` 为准。
获取器可使用 npm 包、本地环境变量及 cargo 路径；
cargo 路径在需要时拉取固定提交并构建，不只是查找已有产物。

### 4.2 CI

| workflow | 当前职责 |
| --- | --- |
| `smoke.yml` | 推送／PR 单测与门禁冒烟；定时／手动变化检测；逐档报告及合并摘要 |
| `ts7-official.yml` | 手动 TS7 官方基线冒烟，带防退步与门禁 |
| `third-party.yml` | 手动实现 × 基线冒烟，按实现隔离清单 |
| `native-suite.yml` | 接收外部二进制，使用批量适配器运行套件并上传指标 |

workflow 已存在不等于已验证远端运行成功。
分支保护的必需状态检查也需要仓库设置，不能只凭 YAML 判定已启用。
操作与具体矩阵见 [CI.md](CI.md)。

## 5. 已知限制与待办

### 5.1 测试框架保真度

官方基线语料提交对齐后，已有样本的残留差异仍可归因到以下缺口：

| 缺口 | 影响 |
| --- | --- |
| pretty 基线 | 与当前诊断摘要解析／渲染形态不同 |
| UTF-16 用例 | 文件解码和源内容可能与官方测试框架不一致 |
| `--noEmit`／emit 指令处理 | 被忽略的指令及适配器固定参数可能改变诊断条件 |
| 续行路径归一 | 关联信息中的绝对路径可能导致 T3 差异 |
| `--noErrorTruncation` | 期望侧默认值、被忽略的指令与实现侧参数可能造成文本差异 |
| 无冒号指令行 | 当前解析器与官方 Go 规则不同，剥离行后可能改变诊断位置 |

逐案证据见 [RESULTS.md 结论 11](RESULTS.md#结论-11官方基线-pin-对齐-npm-githead-后的复跑v12026-11-16)。
以上是实现缺口，不是默认允许的语义差异。

### 5.2 后续工作

- [ ] 实现新的诊断比较与回归策略，具体差距见第 5.3 节；
- [ ] 修复上述已知保真度缺口并复跑对应样本；
- [ ] 展开多值指令变体，复刻官方配置命名，扩大可读取的基线范围；
- [ ] 评估语法错误、无位置配置错误及声明文件用例的独立比较规则；
- [ ] 用同源编译器构建加强来源验证；不再将“npm 与源码不同步”视为已证实的残留差异根因；
- [ ] 扩大按诊断码／目录分层的正确性样本，开展全量验证；
- [ ] 将现场期望生成改为进程内 API，减少逐案启动成本；
- [ ] 增加用例并行执行、分片及指标合并；现有报告合并不等于执行分片；
- [ ] 设计诊断跨度比较；首行和摘要文本比较已由 T2／T3 承担，不再列为未实现的 L2／L3；
- [ ] 增加实现能力／已知不支持项声明，区分整用例跳过与诊断缺失；
- [ ] 评估批量协议对完整诊断文本与 Check 相位的扩展；
- [ ] 明确用例清单完整性与防退步清单覆盖的校验策略。

尚无通用 `--update-baseline` 命令；
防退步清单改善写回也不等于更新官方 `.errors.txt`。
是否长期保留 5.9 基线，需要扩大样本后再判断维护成本与收益。

### 5.3 新的诊断比较与回归策略（待实现）

设计拟将“参考诊断是否找到”“严重级别怎样变化”“新增了哪些诊断”分开记录。
兼容比较允许附加 warning，回归门槛默认 T0，完整 T0–T3 及各项差异继续保存和报告。
具体理由见 [设计思路](DESIGN.md#4-先看问题是否找到再看它是-error-还是-warning)。

| 项目 | 当前实现 | 拟采用的设计 |
| --- | --- | --- |
| 诊断匹配与覆盖率 | 先过滤 warning，只统计 error | 匹配参考诊断时保留候选的 error 和 warning；严重级别变化单列 |
| 附加 warning | 错误统计忽略它，但全量分级会因此未达 T0 | 兼容比较中单列提醒；严格对照仍检查全量差异 |
| error → warning | 等级可达 T0，错误统计却算成漏报 | 计为已找到诊断并降级，不计为诊断漏报 |
| 原始诊断记录 | `CaseRecord.expected`／`actual` 只保留 error | 保存全部诊断，报告可复查 warning 和升降级 |
| 回归记录 | `full` 读写时归一为 `text`，最高存 T2 | 完整比较结果与回归最低要求分开存放 |
| 回归门槛 | 逐案要求不低于原来的 T0–T2 等级 | 已覆盖用例默认保持 T0，T1–T3 变化只在报告展示 |
| 比较报告 | 最高等级不足以说明严重级别和文本各自怎样变化 | 独立记录升降级、首行及完整输出差异，不因低等级不匹配而停止比较 |
| CLI 退出码 | 适配器处理退出状态，但没有独立报告原始退出码及其差异 | 保存实际退出码，供迁移项目 CI 命令时判断 |

落地时需要一起调整比较、记录、报告和门禁，而不只是把 `GATE_TOP_TIER` 改成 T0。
现有 CLI 命令、指标和清单格式仍按 [技术参考](REFERENCE.md) 描述的行为运行。

## 6. 性能附录的实现参数

- 默认样本数 300，可通过 `--perf-sample` 调整；
- 分层使用套件、主用例文件行数分桶（≤50／51–200／201–1000／>1000）、
  期望错误特征；官方基线模式预扫描时用是否存在 `.errors.txt` 作为该特征；
- 固定种子通过 `--perf-seed` 指定，每案两侧各一次，不做多轮重复；
- 实现侧沿用所选适配器，参考侧逐案调用官方 tsc；
- 空程序参考侧测 5 次、实现侧测 3 次，各取成功结果的最小值；
- 仅使用参考侧成功且实现侧有计时的样本计算比值；
- 输出 `metrics.perf`，含样本组成、测量口径、累计／逐案比值、匹配子集和告警。

计时不是零成本；空程序估计和单次样本也不能消除噪声。
具体定义见 [技术参考 §9](REFERENCE.md#9-性能指标)，实测耗时只应在说明环境的结果记录中引用。

## 7. 实现索引与维护

| 文件／目录 | 职责 |
| --- | --- |
| `src/types.ts` | 用例、诊断、适配器接口 |
| `src/case.ts`、`src/classify.ts` | 指令解析、虚拟文件、分类与过滤 |
| `src/baselines.ts`、`config/baselines.json` | 基线配置与语料引用 |
| `src/discover.ts` | 用例清单与语料扫描 |
| `src/tsc.ts`、`src/officialBaseline.ts` | 两种期望来源 |
| `src/compare.ts` | 诊断匹配、一致性分档、指标与样例 |
| `src/ratchet.ts`、`config/ratchet/` | 防退步清单；根目录旧清单保留显式路径兼容 |
| `src/gate.ts` | 门禁条件与结论 |
| `src/adapters/` | 适配器、批量协议客户端与参考实现 |
| `src/perf.ts` | 性能样本、参考调用与比值聚合 |
| `src/report.ts`、`scripts/merge-reports.ts` | 报告及 CI 汇总 |
| `src/run.ts` | 运行编排与输出 |
| `scripts/select-smoke.ts`、`scripts/select-official-baseline-cases.ts` | 样本选择 |
| `scripts/install-impl.ts`、`config/implementations.json` | 第三方实现登记与获取 |
| `scripts/detect-changes.ts`、`.github/workflows/` | CI 变化检测与各类任务 |
| `test/` | 单元及 CLI 集成测试，命令 `bun test ./test` |

维护约定：

- 设计选择的理由变化时更新设计思路；比较规则、字段或协议变化时更新技术参考及相关测试；
- 能力、支持表、版本或限制变化时更新本文；
- 重要取舍与历史修正写入演进记录；
- 新实验保留日期、输入和环境，写入结果文档，不覆盖旧数据冒充新结果。
