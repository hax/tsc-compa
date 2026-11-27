# tsc-compa

面向 TypeScript 类型检查器、与具体实现无关的兼容性测试工具。

本仓库不绑定任何一种实现：只要检查器提供 TSC 兼容的二进制程序，就可以通过适配器
驱动它，在官方 TypeScript 测试集上与多个 tsc 参考配置对照，并报告：

- **多报错误** — 实现报告了错误，而 tsc 没有；
- **覆盖率** — 参考诊断中，候选实际报告了多少；
- **位置差异** — 文件和诊断码相同，但位置不同（单独计数，不混入多报错误或漏报）；
- **跳过** — 对不支持的构造分类并说明原因，而不是静默忽略。

目标是在官方测试集上验证检查器是否接近 100% 兼容，并让任意 TSC 兼容实现
都能使用同一套测试。

## 当前状态

新版运行器把「是否找到了同一个问题」和「诊断是否完全一致」分开判断：

- **兼容**：同文件同起点找到同码或已登记的等价码，没有漏报或新增 error；严重级别变化、附加 warning 独立展示。
- **严格一致**：范围、文字、消息链、相关信息、顺序与完整输出也必须相同。CLI 未提供必要字段时显示「无法确认」，不会按旧 T3 判通过。
- 同一批用例可以对照现场生成的 tsc 诊断、官方 `.errors.txt`，或通过 TS7 async API 为每个用例建立 program 取结构化诊断；报告保留诊断、退出码、选项与版本出处。
- `--report-out` 同时生成 Markdown 和 HTML；`--gate` 默认保护兼容档，也可选择 `--gate-profile strict`。
- 2026-11-27 用 Bun 1.4.4 复跑的[本地 TS7 API 自比](docs/STATUS.md#41-内置适配器)严格通过 28/28。纯文本 CLI 缺少必要字段时仍是「无法确认」。

设计思路与报告解读见 [docs/DESIGN.md](docs/DESIGN.md)；
参数、字段和适配器协议见 [docs/REFERENCE.md](docs/REFERENCE.md)；
能力、已知限制与待办见 [docs/STATUS.md](docs/STATUS.md)；
历史演进与认识修正见 [docs/HISTORY.md](docs/HISTORY.md)；
自比与跨版本结果（包括不同 tsc 版本的默认选项漂移）见 [docs/RESULTS.md](docs/RESULTS.md)；
任务通过本仓库的 [Issue 列表](https://github.com/hax/tsc-compa/issues) 跟踪。

## 查阅公开报告

[公开报告目录](https://johnhax.net/tsc-compa/)可以按「候选检查器和版本 → 参考 TypeScript → 测试集」筛选，也可以分享当前选择。公开评测只开放固定版本的官方 TypeScript（对照组）、两版 Bun 和 tsrs CLI，参考为 TS 7.1.0-beta 的官方结果文件。固定的 120 例诊断样本与全量报告分开列出；28 例冒烟用于校准运行器和候选适配器，不是公开评估选项。

目录只展示已发布的报告，未见结果不表示检查器不兼容，也不会自动启动 CI。有仓库写权限的维护者可在 [GitHub Actions 评测工作流](https://github.com/hax/tsc-compa/actions/workflows/public-evaluation.yml)点 **Run workflow**。评测和发布是两个操作，参见 [CI 使用说明](docs/CI.md#公开评测与报告目录public-evaluationyml)。

## 快速开始

环境要求：[Bun](https://bun.com) ≥ 1.3、`microsoft/TypeScript` 测试集检出，
以及通过 npm 别名安装的 `tsc` 二进制（见 `package.json`）。

```bash
bun install

# 测试集路径：指向检出的 tests/cases，版本须与参考配置匹配
export TSC_COMPA_CORPUS=/path/to/typescript/tests/cases

# 自比：同一个 tsc 既生成参考诊断，也作为候选
bun src/run.ts --baseline 6.0.3 \
  --corpus "$TSC_COMPA_CORPUS" \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# 从官方 .errors.txt 读取参考诊断（筛选后的子集）
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --expectation-source official-baseline --cases config/official-baseline-cases.json --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# TS7 官方结果文件（Go 仓库布局，兼容档回归记录）
export TSC_COMPA_CORPUS=/path/to/typescript-go/tsc/testdata/tests/cases
bun src/run.ts --baseline 7.1.0-beta-official --corpus "$TSC_COMPA_CORPUS" \
  --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json \
  --ratchet config/ratchet-ts71-official.tsv --gate \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc

# TS7 async API 自比（参考与候选都走 API；严格一致门禁）
OUT=.cache/run/ts7-api-self
bun src/run.ts --baseline 7.1.0-beta-official --corpus "$TSC_COMPA_CORPUS" \
  --expectation-source ts7-api --adapter ts7-api \
  --option-strategy aligned \
  --cases config/smoke-cases-ts71-official.json \
  --gate --gate-profile strict \
  --out "$OUT" --report-md "$OUT/report.md" --report-html "$OUT/report.html"

# 用同一测试集测试另一个检查器（批量适配器）
CHECKER_BATCH_BIN=/path/to/checker \
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --adapter checker-batch
# 对照：同一个二进制用逐案 CLI 模式
CHECKER_BIN=/path/to/checker bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --adapter checker-cli
```

运行结果写入 `.cache/run/metrics.json` 和 `.cache/run/details.json`，并打印摘要：

```
tsc-compa smoke — 用例 28：跑 28，完全通过 28，跳过 0
假阳性 0 用例 / 0 条；覆盖 48/48 = 100.0%；漏报 0；错锚 0 用例 / 0 条（不计入 fp/miss）
分类 suite:compiler：跑 15，假阳性 0 例 / 0 条，覆盖 100.0%，错锚 0 条
分类 suite:conformance：跑 13，假阳性 0 例 / 0 条，覆盖 100.0%，错锚 0 条
口径：adapter=tsc-cli:node_modules/typescript-6-0/bin/tsc mode=official baseline=6.0.3 tsc=6.0.3
```

## 参考配置

`config/baselines.json` 将通过 npm 别名安装的 `tsc` 版本与测试集版本、默认用例列表、
基础 CLI 参数配对（例如 5.9 不接受 `--ignoreConfig`）：

| 参考配置 | tsc | 测试集 | 默认用例列表 |
| --- | --- | --- | --- |
| `5.9.3` | `typescript-5-9` | `v5.9.3` 标签 | `config/smoke-cases-5.9.json` |
| `6.0.3` | `typescript-6-0` | strada，v6.0.3 标签 `050880ce` | `config/smoke-cases.json` |
| `7.1.0-beta` | `typescript-7-1` | strada，v6.0.3 标签 `050880ce` | `config/smoke-cases.json` |
| `7.1.0-beta-official` | `typescript-7-1` | TS7 Go 测试集，固定提交 `3e92363` | `config/smoke-cases-ts71-official.json` |

两套官方测试集的固定提交均与对应 npm 包（`typescript@6.0.3` /
`typescript@7.1.0-beta`）的 `gitHead` 一致；`test/baseline-pins.test.ts` 检查这一
对齐关系，CI workflow 从 `config/baselines.json` 解析测试集引用，不硬编码 SHA。

每个基线的 `baseArgs` 显式编码**官方测试框架的默认值**（参数顺序见
[技术参考](docs/REFERENCE.md#13-选项来源与优先级)，这样设计的原因见 `docs/DESIGN.md` §3.3）：

- 5.9：target ES5 / module CommonJS / moduleResolution Node10 / strict 关闭；
- 6.0：target ES2025 / module ES2022 / moduleResolution Bundler / strict 开启；
- 7.1：target ES2026 / 模块相关设置与 6.0 相同 / strict 开启。

这些默认值**只作用于参考侧**。适配器接收用例指令及显式传入的
`--base-arg` / `--adapter-arg`，其余选项使用实现自己的默认值。
跨版本比较若要单独观察语义差异，必须显式对齐选项：

```bash
# 5.9 参考与 6.0.3 候选对照，两侧显式使用相同选项
bun src/run.ts --baseline 5.9.3 --corpus /path/to/v5.9.3/tests/cases --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc --base-arg strict=false --base-arg target=es2015 --base-arg module=es2015 --base-arg moduleResolution=bundler
```

基线间的差异以及固定版本／提交的重要性，见 [docs/RESULTS.md](docs/RESULTS.md)。

## 报告

每次运行都可以从生成的 `metrics.json` / `details.json` 输出人类可读报告，
无需为生成报告重复执行测试：

```bash
# Markdown + 自包含 HTML（默认文件名为 report.md / report.html）
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --report-out .cache/run/report

# 显式指定输出路径，并对比上次运行（可传 metrics.json 或其所在输出目录）
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --report-md report/report.md --report-html report/report.html \
  --prev-report .cache/previous/metrics.json

# 从已有输出目录重新生成报告
bun src/report.ts --from .cache/run --md .cache/run/report.md --html .cache/run/report.html
```

Markdown 报告包括：

- 运行信息：时间、测试集／tsc 固定版本或提交、检查器名称及二进制 sha256、参考配置／模式；
- 指标摘要：兼容与严格一致各自的通过、失败与无法确认数，及单独汇总的字段差异、覆盖率和跳过原因；
- 已验证的兼容性、严格一致性与字段回归，以及启用 `--gate` 时的阻断原因；
- 与上次运行的差异：通过 `--prev-report` 指定；未指定时，若存在
  `<out>/prev/metrics.json` 则自动使用；
- 失败与回归提示。

HTML 报告包含相同内容，使用内联样式，不依赖外部资源。
生成过程具有确定性（相同输入生成相同字节），因此可缓存或比较差异。
报告渲染或写入失败会以非零退出码结束，不会把失败的运行变成通过。

独立报告 CLI 与 `run.ts` 默认使用相同的 `<out>/prev/metrics.json` 作为上次运行数据，
因此在使用默认对比数据时，`bun src/report.ts --from <out>` 可以逐字节复现运行时的报告
（若 `run.ts` 显式指定了 `--prev-report`，重新生成时也要传相同路径）。

CI 中，`smoke.yml` 的每个矩阵任务写入 `report.md` / `report.html`，与
`metrics.json` / `details.json` 一起上传为 `report-<entry>` 产物。
即使门禁失败也会生成报告；若运行在写入指标前崩溃，则生成失败占位报告。
`report` 任务将所有任务项合并到该次运行的 **Summary** 页面，并上传
`report-summary` 产物；下载后打开 `report/index.html` 即可浏览各任务项的 HTML 报告。
workflow 令牌为只读（`contents: read`），因此只通过步骤摘要和产物发布报告，
不向 PR 发送评论。报告头部列出用例列表路径与 SHA-256、选项策略及参考侧／候选侧
二进制（含 TS7 wrapper 与原生二进制各自 sha256）；输出目录不带用例路径时可只靠这些
指纹判断输入是否一致。`details.json` 保存逐案名单和诊断，可以核对 `--limit` 后究竟
跑了哪些用例；没有 `details.json` 时报告只能给出汇总，不能逐案查看。

用例列表仍填写源文件 ID，例如 `compiler/Foo.ts`。按支持的多值指令展开后，
`details.json` 会分别记录 `compiler/Foo(target=es2015).ts` 等配置；`lib` 的逗号分隔值
仍是一组选项，不展开。`--limit N` 在展开前截取前 N 个源文件，展开后的记录数可以超过 N。
读取官方结果时，具名配置没有 `.errors.txt` 也没有同名配置的其他产物佐证，就记为跳过，
不当作零诊断。具体规则见[技术参考](docs/REFERENCE.md#42-读取官方结果文件)。

## CI 与兼容性门禁

`.github/workflows/smoke.yml` 在每次推送和 PR 上运行，下表中的矩阵构成兼容性门禁；
同时每日定时触发一次（`cron 23 19 * * *`，即 UTC 19:23／北京时间次日 03:23，
避开整点）。**每日任务由变化驱动，并非每日全量运行**：先运行 `detect` 任务
（约 30 秒），只有检测到变化才执行测试。没有变化时不运行测试，
以「无变化，跳过」摘要结束，状态为通过。

变化检测（`scripts/detect-changes.ts`）将当前状态与上次**成功**运行测试后记录的状态
比较，状态通过 `actions/cache` 保存：

| 检测信号 | 检测方式 | 查询条件／用途 |
| --- | --- | --- |
| 本地输入 | `config/**`（参考配置／测试集／用例列表／检查器／回归记录）、`package.json` 和 `bun.lock` 的 SHA-256 | 始终可查 |
| 仓库 HEAD | 当前 `github.sha` 与上次成功运行记录的 HEAD 比较 | 始终可查 |
| npm 固定版本 | 从 npm registry 查询各精确固定版本的 `dist.integrity`（tsc 别名及 `implementations.json` 中的 npm 版本） | 需要网络；不可查询时视为未变化 |
| 测试集固定引用 | 通过 GitHub API 解析 `config/baselines.json` 中的各个 `corpora.*.ref`（标签移动会改变提交） | 需要网络／GitHub API；不可查询时视为未变化 |
| 第三方 cargo git 固定提交 | 检查固定提交是否仍存在于 GitHub（`tsc-rs`、`tsz`）；非 GitHub URL 标记为不可比较 | 需要网络／GitHub API；不可查询时视为未变化 |
| 上游默认分支 HEAD | 只报告，不触发运行（版本／提交已固定，输入不随上游 HEAD 改变） | 仅供参考 |

定时或手动触发时，若首次运行没有缓存状态，则视为有变化。
`workflow_dispatch` 默认也经过变化检测；设置 `force` 输入可跳过检测、强制运行测试。
只有所有测试通过后才更新已保存的状态，因此失败会在后续检测中重试，直到通过。

测试矩阵（仅在检测判定需要运行时执行，共六档）：

| 任务项（slug） | 参考结果来源 | 门禁 |
| --- | --- | --- |
| `5.9.3-self` / `6.0.3-self` / `7.1.0-beta-self` | 固定版本 tsc | 完成用例全部兼容；`--option-strategy aligned` |
| `7.1.0-beta-api-self`，28 例 | 参考与候选均为 TS7 async API | `aligned` + `--gate --gate-profile strict`，无 ratchet |
| `7.1.0-beta-official`，28 例 | TS7 官方 `.errors.txt` | `config/ratchet-ts71-official.tsv`，默认兼容保护档 |
| `6.0.3-official-subset`，191 例 | strada `.errors.txt` | `config/ratchet/typescript-6.0.3-official.tsv`，另检查多报／漏报／覆盖率阈值 |


启用 `--gate` 后，至少需要一个完成用例和可作结论的运行；未配置回归记录时，完成用例全部满足保护档才通过。
配置记录后，已验证的用例不能退步或离开执行范围。严格一致退到仅兼容仍是回归，但只有 `--gate-profile strict` 才阻断。
数字阈值可附加约束，不能把无法确认改判为通过。详见 [回归规则](docs/REFERENCE.md#7-回归检查与-ci-通过条件)。

配置分支保护时，应将稳定的聚合任务 **`compat-gate`** 设为必需状态检查。
它汇总 `detect` / `unit` / `smoke` / `report`：无变化而跳过时通过；
测试、检测或报告任务失败时失败。
必需状态检查属于仓库设置，不能仅通过 workflow 文件声明。
在 Actions 手动运行 `smoke` 时勾选 `force`，可跳过变化检测并重跑六档门禁，
包括 TS7 官方结果文件的 28 例回归检查。只跑前几例或换用自选适配器，请按
[本地 TS7 官方结果文件对照](docs/CI.md#本地-ts7-官方结果文件对照)运行；
远端结果以相应 GitHub Actions 运行的 Summary 和产物为准。

## 用例分类

`src/classify.ts` 为每个用例添加不同维度的标签，例如 `suite:compiler`、
`files:multi`、`lang:js`、`lang:jsx`、`shape:parser`、`options:module`、
`options:lib`、`options:emit`、`env:skip`，以及运行时标签
`expect:syntax`、`expect:no-errors`。指标包含 `byClass` 分类明细；
标签可能重叠，因此各分类数字不能直接相加。

通过 `--exclude-class a,b` / `--only-class` 过滤。被排除的用例会记录为
SKIP，原因为 `类排除:<tag>`，不会静默消失。

重新生成冒烟用例列表（按类过滤，再由参考 tsc 剔除语法错误用例）：

```bash
bun scripts/select-smoke.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --out config/smoke-cases.json
```

## 其他适配器

- `tsc-cli`：逐案参考 CLI；`tsc-cli:<bin>` 可驱动参考 tsc 或第三方 TSC 兼容二进制；
- `ts7-api`：TS7 的 async API 适配器。Bun 进程内只持有 API 客户端，TS7 后端仍是持久子进程，
  通过 JSON-RPC 调用 `parseCommandLine` / `createProgram` / 诊断方法；`--adapter ts7-api`
  和 `--expectation-source ts7-api` 同时使用时，参考与候选共用同一实现但各自建 program；
- `bun-check`：Bun 内置 `bun check` 的逐案适配器，必须显式给 `bun-check:<bin>` 或 `BUN_CHECK_BIN`，
  不使用当前运行器的 Bun 充当候选。需要声明生成阶段诊断的配置会显式跳过；
- `none`：不报告任何诊断，用于验证多报错误和漏报路径；
- `mock-batch`：批量协议参考实现，见 `src/adapters/mock-batch.ts`；
- `cli:<bin>`：通用逐案 CLI，通过 `TSC_COMPA_CLI_ARGS` 传额外参数；
- `checker-cli`：驱动支持 `--json` 输出的检查器二进制，逐案运行、使用固定选项集，
  通过 `CHECKER_BIN` 或 `checker-cli:<bin>` 指定二进制；
- `checker-batch`：同一二进制的批量 NDJSON 模式，使用 `CHECKER_BATCH_BIN`，
  未设置时回退到 `CHECKER_BIN`。

`ts7-api` 使用运行器生成的命令行参数和物化后的用例文件；解析器已经把支持的指令
转成 `CaseInput.args`，适配器不再改写成另一种 CLI 格式。它以
`typescript-7-1/async` 的 `API` 调用 `createProgram`，保留结束位置 `end`（可跨行）、
消息链、相关信息、附加属性和格式化后的 `fullText`。诊断调用在一个会话里串行排队，
每个用例独立建 program 并 dispose。API 没有逐案进程退出码，报告会显示「未提供」
而不是伪造 0/2。某案超时后，后续调用仍可能被后端在途请求拖住，不能把超时当作
后端已取消。

批量 NDJSON 客户端会透传诊断级 `width`、`messageChain`、`related`、`attributes`、
`fullText`、`raw`，以及结果级 `fullText`、`exitCode`、`checkMs`、`rawOutput`。
实现侧不提供这些字段时，报告保持「未提供」，不会补出虚假的结构或空输出。
`checker-batch` 在工厂里固定 `supportsOptions=false`；即使传 `--mode official`，
也不能据此给出兼容性结论。它适合用 `--mode fixed` 验证远端二进制的批量管线，
真实实现的字段完整度和 Check 耗时仍要逐项核对。`mock-batch` 是协议自检实现，
不是真实检查器。


## 第三方实现

任何提供 TSC 兼容 CLI 的检查器都可通过现有 `tsc-cli` 适配器驱动，
无需为其编写内部适配器。获取方式（npm 预编译包／cargo 构建／本地二进制）、
固定 CLI 参数、上游固定提交及阶段指标登记在
[`config/implementations.json`](config/implementations.json)：

```bash
# 按登记信息获取实现，并打印二进制路径
BIN=$(bun scripts/install-impl.ts --name tsrs --dest .tools | tail -1)

# 在 TS7 官方结果文件上对该实现运行同一套冒烟测试

IMPL=tsrs
TSC_COMPA_ADAPTER_ARGS="--singleThreaded" \
bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus /tmp/ts71-corpus/tsc/testdata/tests/cases \
  --adapter "tsc-cli:$BIN" --mode official \
  --expectation-source official-baseline \
  --option-strategy aligned \
  --ratchet-impl "$IMPL"
```

`--ratchet-impl` 推导 `config/ratchet/<impl>-<baseline>.tsv`；第一次不带
`--gate` 运行会在本地生成并登记当前结果，审阅后再提交。门禁只读取已入库记录；
`--limit` 或只跑部分用例时不能把这一次写成完整回归通过。

`.github/workflows/third-party.yml` 在 CI 中执行相同流程（手动触发，
按「检查器 × 参考配置」运行）。本地记录中，`tsrs` 在 TS7 官方结果文件和 strada 7.1
参考配置上均为 28/28 通过、0 多报错误、100% 覆盖率；完整固定版本样本见
[docs/RESULTS.md](docs/RESULTS.md)。这些是本地实测，不代表 GitHub Actions 的
`third-party.yml` 已成功运行。

要在同一份 120 例样本上分别对照现场 tsc 与官方 `.errors.txt`，见
[本地固定版本双来源对照](docs/CI.md#本地固定版本双来源对照)。公开评测只用官方参考结果，
与双来源复现不是同一个入口。

## 目录导航

- 使用和维护：[项目文档](docs/README.md) · [测试配置](config/README.md) · [维护脚本](scripts/README.md)
- 开发：[运行器和适配器](src/README.md) · [自动化测试](test/README.md)
- 报告和自动化：[公开报告站点](site/README.md) · [GitHub 配置和工作流](.github/README.md)

## 可选性能附录

`--perf-ratio` 为常规兼容性运行增加性能**附录**，不改变通过／失败结论。
`ts7-api` 作为参考来源时，性能参考仍逐案调用 tsc CLI，不能把 API 参考和候选的计时
直接当成同一进程成本。
常规运行时直接记录实现的逐案实际耗时，并在同一次运行中用官方 tsc
带 `--extendedDiagnostics` 执行固定分层样本（默认 300 例），生成性能比值。

```bash
bun src/run.ts --baseline 7.1.0-beta-official --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json --adapter checker-cli:<bin> --perf-ratio
```

参考 tsc 使用固定分层样本（测试类别 × 行数分桶 × 参考错误，默认 300 例，
通过 `--perf-sample` 调整）。每个用例两侧各运行一次，一半样本先运行参考 tsc，
另一半先运行被测实现。两侧都报告 `--extendedDiagnostics` 时，
主比值使用累计 Check 阶段时间；否则使用扣除空程序基线后的实际耗时
（若参考侧固定成本占主导，则保护性地返回 null）。
`metrics.json` 的 `perf` 还记录未扣除固定成本的实际耗时及比值，分别汇总双方都完成
计时的样本和其中兼容档通过的子集；这些数字包含调用开销，不等同于 Check 阶段耗时。
测量方法见
[技术参考](docs/REFERENCE.md#9-性能指标)，设计思路见 `docs/DESIGN.md` §8。

## 测试集许可

TypeScript 编译器测试集（`microsoft/TypeScript` 的 `tests/cases` 和结果文件）
采用 Apache-2.0 许可，本仓库在 CI 运行时读取这些测试集。
本仓库自身的代码与数据同样采用 Apache-2.0 许可，见 [LICENSE](LICENSE)
和 [NOTICE](NOTICE)。
