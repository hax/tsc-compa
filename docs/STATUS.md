# tsc-compa 实现状态

整理日期：2026-11-27。本文描述本地工作区；本地实测与 GitHub Actions 的远程运行结论分开记录。

本文记录能力、配置、实现位置、已知缺口和待办。
设计思路见 [DESIGN.md](DESIGN.md)，参数和规则见 [REFERENCE.md](REFERENCE.md)，
演进背景见 [HISTORY.md](HISTORY.md)，
实测结果及复现命令见 [RESULTS.md](RESULTS.md)，CI 操作见 [CI.md](CI.md)。

## 1. 已实现能力

| 能力 | 实现范围／入口 |
| --- | --- |
| 用例解析与分类 | 指令解析、虚拟文件、按配置分别运行、静态及运行期标签、按标签过滤 |
| 多参考配置 | 三个参考 tsc 版本、不同测试集引用及默认用例列表 |
| 三种参考结果来源 | 运行 tsc + 缓存；官方 `.errors.txt` 子集；TS7 async API |
| TS7 async API 适配器 | `ts7-api` 可同时作参考与候选；Bun 进程持客户端，TS7 后端为持久子进程 |
| 逐案与批量适配器 | `tsc-cli`、`ts7-api`、`bun-check`、检查器 CLI、通用 CLI、NDJSON 客户端与模拟实现 |
| 诊断差异 | 多报错误、漏报、位置差异、升降级、附加 warning、参照覆盖率、分类与诊断码聚合 |
| 两档比较 | 兼容／严格一致；对每项诊断差异分别记录相同、不同或未提供 |
| 回归记录 | 两档与逐字段分别记录；兼容档默认阻断，严格档按需选择；`--gate` 只读、不初始化 |
| 兼容性门禁 | 运行条件、至少一个用例完成比较、回归检查与显式／默认阈值 |
| 报告 | Markdown、自包含 HTML、前后差异、CI 多档汇总 |
| 性能附录 | 固定分层样本、平衡先后顺序、Check／实际耗时差分比值及告警 |
| 外部实现接入 | 实现登记、npm／本地／cargo 获取、二进制分发 workflow |

测试范围和官方测试框架的已知差异见第 3、5 节。

## 2. 参考配置与测试集

实际配置以 `config/baselines.json` 为准：

| 参考配置 | 参考 tsc 别名 | 测试集引用 | 默认用例列表 |
| --- | --- | --- | --- |
| `5.9.3` | `typescript-5-9` | `microsoft/TypeScript@v5.9.3` | `config/smoke-cases-5.9.json` |
| `6.0.3` | `typescript-6-0` | strada，固定提交 `050880ce…` | `config/smoke-cases.json` |
| `7.1.0-beta` | `typescript-7-1` | 与 6.0.3 相同的 strada 测试集 | `config/smoke-cases.json` |
| `7.1.0-beta-official` | `typescript-7-1` | TS7 Go 布局，固定提交 `3e923636…` | `config/smoke-cases-ts71-official.json` |

`7.1.0-beta-official` 选择的是参考配置，不会自动切换参考结果来源；
读取官方结果文件仍需传 `--expectation-source official-baseline`。
走 TS7 async API 时则使用 `--expectation-source ts7-api`，并可用同一适配器作候选。

两个官方测试集的固定提交已与对应 npm 包的 `gitHead` 对齐：
6.0.3 对应 `050880ce…`，7.1.0-beta 对应 `3e923636…`。
`test/baseline-pins.test.ts` 检查此关系和 workflow 的配置驱动，
不据此断言测试框架完全保真。

### 2.1 参考侧默认值

| 配置项 | 5.9.3 | 6.0.3 | 7.1.0-beta |
| --- | --- | --- | --- |
| `target` | ES5 | ES2025 | ES2026 |
| `module` | CommonJS | ES2022 | ES2022 |
| `moduleResolution` | Node10 | Bundler | Bundler |
| `strict` | false | true | true |
| 通用基础参数 | `--noEmit --pretty false` | 同左，增加 `--ignoreConfig` | 同 6.0.3 |
| 额外显式默认项 | `--skipDefaultLibCheck --noErrorTruncation` | 同左 | 同左 |

这些值用于运行时生成参考诊断，不自动注入候选适配器。
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

## 3. 用例与参考结果来源的支持范围

### 3.1 用例解析与选择

- 虚拟文件允许 `.ts`、`.mts`、`.cts`，因此虚拟 `.d.ts` 文件也可被解析；
  `.tsx`、`.js`、`.jsx`、`.json` 等虚拟文件跳过。
- 含 `..` 路径段的虚拟路径跳过；绝对虚拟路径另行记录，
  读取官方结果文件时跳过这类用例，不按相对路径写入临时目录。
- 支持的编译选项包括 strict 系、target、module、moduleResolution、lib 等；
  精确表见 `src/case.ts` 的 `OPTION_DIRECTIVES`。
- JS／JSX、外部类型、路径映射、工程布局等指令的跳过表见 `SKIP_DIRECTIVES`。
- emit、pretty、诊断截断等部分指令在 `IGNORED_DIRECTIVES` 中，不传递为选项；
  已知影响见第 5 节，不能将「被忽略」解释为「无影响」。
- 位于已开始的虚拟文件内容之间的其他指令记为未知形态并跳过；
  未知或无法解析的指令同样整案跳过并给出原因，不能当作零选项继续比较。
- 用例列表仍按源文件选取；支持的多值选项（如 `target`、`strict`、`declaration`）按配置
  分别执行和记录。`lib` 逗号分隔的是同一配置的库列表。`declaration` 和
  `emitDeclarationOnly` 会作为编译参数传递；声明生成诊断仍取决于适配器及实际编译选项。
- 默认冒烟集来自 `compiler`／`conformance`；
  `scanCorpus` 会递归发现 `.ts` 文件，不单独强制过滤测试目录。
  扫描候选范围不等于已支持或已验证范围。

`scripts/select-smoke.ts` 负责按类筛选、用参考 tsc 剔除语法错误用例并生成清单。
默认冒烟用例列表各有 28 个源文件；官方结果的扩展列表另有 191 和 120 个源文件。
展开配置时，逐案记录数可能大于列表长度。

### 3.2 运行 tsc 取得参考诊断

- 虚拟文件写入临时目录，诊断路径映射回用例内相对路径；
- 识别到 TS1xxx 或 TS17006／TS17007 时，按框架当前筛选规则将用例归为语法错误并跳过；
  这是当前分类规则，不声称这些用例绝无其他语义诊断；
- 缓存目录为 `.cache/expectations/`；缓存键包含解析管线版本、虚拟文件路径与内容、
  参考参数、tsc 版本，以及参考二进制身份（运行器传原生 TS7 二进制或 wrapper 的 sha256）；
  同版本换二进制会改用新键，不再复用旧结果。
- 缓存键不记录操作系统、libc、默认库目录等完整环境；仍以「同版本、同二进制」为前提，
  跨环境复用时需要核对来源和参数。
- 旧缓存缺少当前 schema／pipeline 标记时不读回，会重新采集。

### 3.3 官方结果文件

支持的布局：

| 布局 | 用例目录 | 基线目录 |
| --- | --- | --- |
| strada／JS | `tests/cases/` | `tests/baselines/reference/` |
| TS7／Go | `tsc/testdata/tests/cases/` | `tsc/testdata/baselines/reference/` |

查找依次尝试用例相对目录、测试类别目录内平铺、根目录平铺。
无配置后缀的用例沿用原有缺文件规则；具名变体缺少 `.errors.txt` 时，必须有同主文件名
（含配置后缀）的 `.types`、`.symbols`、`.js` 等产物，才能记为零诊断。

仍跳过：

- 不支持的配置，或缺少官方结果、也无其他同配置产物佐证的具名变体；
- 绝对路径 `@filename`；
- 用例自身的 ID 以 `.d.ts` 结尾；这不同于普通用例包含虚拟 `.d.ts` 文件；
- pretty 结果文件、含无位置配置诊断或按当前规则识别的语法错误的结果文件。

使用缺文件规则前，需检查测试集下载完整性和结果文件的路径映射。

## 4. 适配器与 CI 实现

### 4.1 内置适配器

| 适配器 | 执行形态 | 外部选项 | 说明 |
| --- | --- | --- | --- |
| `tsc-cli`／`tsc-cli:<bin>` | 逐案 | 支持 | 可驱动参考 tsc 或提供兼容 CLI 的第三方实现 |
| `ts7-api` | API（客户端在 Bun，后端为持久子进程） | 支持 | TS7 async API；可同时作参考与候选 |
| `bun-check`／`bun-check:<bin>` | 逐案 | 支持 | 为固定版本的 `bun check` 写独立 tsconfig；需要声明生成阶段诊断时显式跳过 |
| `checker-cli`／`checker-cli:<bin>` | 逐案 | 固定选项 | 检查器 JSON 输出，适合 fixed 模式验证 |
| `checker-batch` | 批量 | 固定选项 | 同一检查器的 `--batch` NDJSON 模式 |
| `cli:<bin>` | 逐案 | 声明为不支持 | 通用 CLI；不能据此给出 official 模式的合格结论 |
| `none` | 无实际进程 | 声明为支持 | 不报告诊断，用于测试多报错误／漏报路径 |
| `mock-batch` | 批量 | 支持 | 批量协议参考实现 |

`ts7-api` 的 API 流程为 `parseCommandLine` → `createProgram` → program／global／
config／syntactic／semantic 诊断，满足条件时再收集声明生成诊断；有语法诊断时不取
semantic。单条诊断与结果级 `fullText` 使用同一份摘要。适配器保留主诊断和相关信息的
结束位置（可跨行）、消息链及附加属性，没有逐案进程退出码。
调用串行排队；超时只让该案记为 skip，在途请求仍可能阻塞下一案。

批量客户端透传诊断级 `width`、`messageChain`、`related`、`attributes`、`fullText`、
`raw`，以及结果级 `fullText`、`exitCode`、`checkMs`、`rawOutput`。实现可以不提供这些
字段，缺席时保留「未提供」；批量协议不再缺完整诊断文本和 Check 阶段耗时的通道。
`mock-batch` 的 `FAKE_RICH` 用例覆盖这条透传路径。

2026-11-27 本地记录（各行使用各自记录的测试集提交）：

| 运行 | 输入与口径 | 兼容 | 严格一致 | 报告 |
| --- | --- | --- | --- | --- |
| `ts7-api` 自比 | TS7 `3e923636…`，28 例，aligned，`--gate --gate-profile strict`，无 ratchet | 28/28 | 28/28；11 个字段均 28 equal | `.cache/goal/certified-final-2026-11-27/api-self` |
| CLI 对照官方结果文件 | TS7 `3e923636…`，28 例，`official-baseline` 为参考，CLI 候选 | 28/28 | 4/28，24 未确认 | `.cache/goal/self-smoke-finalcheck` |
| 6.0.3 官方结果子集 | strada `050880ce…`，191 例，190 完成，1 例 pretty 跳过 | 188 通过 / 2 失败 | 0 通过 / 4 失败 / 186 未确认 | `.cache/goal/ts60-official-final` |
| 6.0.3 官方结果子集（v2 复核） | strada `050880ce…`，191 例，190 完成，1 例 pretty 跳过；2 条 TS2441 漏报 | 189 通过 / 1 失败 | 0 通过 / 4 失败 / 186 未确认 | `.cache/goal/certified-final-2026-11-27/ts60-subset` |

表中 6.0.3 的两行是不同时间的本地实测：188/2 是旧证据；189/1 是采用当前诊断采集与比较规则后的复核，剩余 1 个不兼容用例为 `collisionExportsRequireAndAlias` 的 2 条 TS2441 漏报，另有 1 例 pretty 基线按规则跳过。
API 档的严格通过来自结构化 API 两侧都提供宽度、消息链、related、attributes 与输出；
CLI 对照只能从纯文本取得部分字段，所以它的严格档大多「未确认」。这是字段可得性差异，
不能把两份报告的严格档数字直接作同条件比较。
API 自比已用 Bun 1.4.4 复跑；另对照官方文件验证了 4 个含多值 `target` 的源文件，展开为 8 个配置，
4 个完成且兼容，4 个无官方运行证据而跳过。这些本地记录不代表 GitHub Actions 已运行。
CLI 对照的 24 个严格档 `unknown` 不计为通过。

API 适配限制：

- API 会为每个用例建立独立临时目录并 dispose program，但 API 会话本身跨用例复用；
  某一案超时后，后续调用可能被仍在途的后端请求拖住。关闭适配器时，内置 TS7 会话在宽限期
  后仍无响应则只回收自己的子进程；宿主注入的客户端不会被强制终止。
- 绝对虚拟路径和无位置诊断仍受第 3 节规则限制；API 适配器遇到无位置诊断时整案
  skip，不伪装成零诊断。
- 候选侧 API 没有逐案进程退出码；需要退出码语义的比较应使用 CLI 适配器。

第三方实现登记包括 `tsrs`、`tsc-rs`、`ts-rust`、`tsz`，
版本、获取方式和参数以 `config/implementations.json` 为准。
获取器可使用 npm 包、本地环境变量及 cargo 路径；
cargo 路径在需要时拉取固定提交并构建，不只是查找已有产物。

### 4.2 CI

| workflow | 当前职责 |
| --- | --- |
| `smoke.yml` | 推送／PR 单测（含 typecheck）与六档门禁冒烟（含 TS7 API 严格自比）；定时／手动变化检测；逐档报告及合并摘要 |
| `third-party.yml` | 手动实现 × 基线冒烟，按实现隔离清单 |
| `native-suite.yml` | 接收外部二进制，使用批量适配器运行测试并上传指标 |

workflow 已存在不等于已验证远端运行成功。
分支保护的必需状态检查也需要仓库设置，不能只凭 YAML 判定已启用。
其他任务见[工作流索引](../.github/workflows/README.md)，操作与具体矩阵见 [CI.md](CI.md)。

## 5. 已知限制与待办

### 5.1 测试框架保真度

官方测试集提交对齐后，剩余差异主要来自以下测试框架限制：

| 缺口 | 影响 |
| --- | --- |
| pretty 基线 | 与当前诊断摘要解析／渲染形态不同 |
| `--noEmit`／emit 指令处理 | 被忽略的指令及适配器固定参数可能改变诊断条件 |
| 续行路径归一 | 关联信息中的绝对路径可能导致 T3 差异 |
| `--noErrorTruncation` | 参考侧默认值、被忽略的指令与候选参数可能造成文本差异 |

逐案证据见 [RESULTS.md 结论 11](RESULTS.md#结论-11官方测试集提交对齐-npm-githead-后的复跑v12026-11-16)。
以上是实现缺口，不是默认允许的语义差异。UTF-16 BOM 解码与无冒号注释的处理已修正。

### 5.2 后续工作

- [ ] 修复上述已知测试框架差异并复跑对应样本；
- [ ] 在已复跑的四个具名配置源文件之外，扩大支持和验证的配置范围；
- [ ] 评估语法错误、无位置配置错误及声明文件用例的独立比较规则；
- [ ] 用同源编译器构建加强来源验证；不再将「npm 与源码不同步」视为已证实的残留差异根因；
- [ ] 扩大按诊断码／目录分层的正确性样本，开展全量验证；
- [ ] 在已经通过严格自比的 28 例及 120 例清单之外，扩大 `ts7-api` 的配置和诊断类型覆盖；
- [ ] 评估是否用 API 参考扩展其它进程内检查器，减少逐案启动成本；
- [ ] 增加用例并行执行、分片及指标合并；现有报告合并不等于执行分片；
- [ ] 增加实现能力／已知不支持项声明，区分整用例跳过与诊断缺失；
- [ ] 为批量协议的真实第三方实现补齐结构化字段与 `checkMs` 的端到端样本；
- [ ] 校验用例列表完整性和回归记录的覆盖范围。

尚无通用 `--update-baseline` 命令；
回归记录更新与官方 `.errors.txt` 更新是两种操作。
是否长期保留 5.9 基线，需要扩大样本后再判断维护成本与收益。

### 5.3 两档比较与回归

运行器保留双方诊断和退出码。参考诊断同文件同起点匹配；等价码只影响兼容档，原码仍单列。
兼容档允许已匹配诊断的严重级别变化及附加 warning。严格档需要结构化字段和完整诊断输出；
双方提供 `end` 时，标记范围可以比较跨行的结束位置。纯文本 CLI 不提供完整范围、消息链
或相关信息，因此有诊断的用例即使文本相同，也可能无法确认严格一致。

按检查器和参考配置分别保存回归记录。兼容档默认阻断兼容回归，严格档另外阻断严格一致性回归；
字段从已相同变为不同或未提供仍记为回归。旧 T0–T3 数据保留供读取历史报告，不作为严格一致的证据。

## 6. 性能附录的实现参数

- 默认样本数 300，可通过 `--perf-sample` 调整；
- 分层使用测试类别、主用例文件行数分桶（≤50／51–200／201–1000／>1000）、
  参考错误特征；读取官方结果文件时，预扫描用是否存在 `.errors.txt` 作为该特征；
- 固定种子通过 `--perf-seed` 指定，每案两侧各一次，不做多轮重复；
- 实现侧沿用所选适配器，参考侧逐案调用官方 tsc；
- 空程序参考侧测 5 次、实现侧测 3 次，各取成功结果的最小值；
- 仅使用参考侧成功且实现侧有计时的样本计算比值；
- `metrics.perf` 给出累计／逐案比值及告警；未扣除固定成本的总耗时和比值同时记录全计时样本与兼容通过子集。

计时不是零成本；空程序估计和单次样本也不能消除噪声。
具体定义见 [技术参考 §9](REFERENCE.md#9-性能指标)，实测耗时只应在说明环境的结果记录中引用。

## 7. 实现索引与维护

| 文件／目录 | 职责 |
| --- | --- |
| `src/types.ts` | 用例、诊断、适配器接口 |
| `src/case.ts`、`src/classify.ts` | 指令解析、虚拟文件、分类与过滤 |
| `src/baselines.ts`、`config/baselines.json` | 参考配置与测试集引用 |
| `src/discover.ts` | 用例列表与测试集扫描 |
| `src/tsc.ts`、`src/officialBaseline.ts` | CLI 参考缓存与官方 `.errors.txt` 参考结果 |
| `src/adapters/ts7-api.ts` | TS7 async API 参考／候选适配器，含结构化字段与完整输出 |
| `src/comparison.ts`、`src/compare.ts` | 两档判定、字段差异、逐案与聚合指标 |
| `src/ratchet.ts`、`config/ratchet/` | 回归记录；根目录旧记录保留显式路径兼容 |
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
