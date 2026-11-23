# tsc-compa

面向 TypeScript 类型检查器、与具体实现无关的兼容性测试套件。

本仓库不绑定任何一种实现：只要检查器提供 TSC 兼容的二进制程序，就可以通过适配器
驱动它，在官方 TypeScript 测试语料上与多个 tsc 基线对照，并报告：

- **假阳性（误报）** — 实现报告了诊断，而 tsc 没有；
- **覆盖率** — 官方期望的诊断中，实现实际报告了多少；
- **错锚** — 文件和诊断码相同，但位置不同（单独计数，不混入假阳性或漏报）；
- **跳过** — 对不支持的构造分类并说明原因，而不是静默忽略。

目标是在官方测试语料上证明检查器「近乎 100% 兼容」，并让任意 TSC 兼容实现
都能使用同一套测试。

## 当前状态

warning 兼容比较及“完整记录、默认 T0 回归门槛”的新设计尚待实现；
下面的命令与门禁说明仍对应现有代码，迁移工作见
[docs/STATUS.md](docs/STATUS.md#53-新的诊断比较与回归策略待实现)。

v1（2026-11）已具备：

- 用例指令解析、分类与过滤；
- 两种期望来源：由 tsc 现场生成并缓存，或通过
  `--expectation-source official-baseline` 读取官方 `tests/baselines` 子集；
- 三个 tsc 基线（5.9.3 / 6.0.3 / 7.1.0-beta），在 `config/baselines.json` 中
  分别配对语料版本，基础参数显式编码官方测试框架（harness）的默认值；
- 逐案 CLI 适配器、批量适配器协议及其参考实现，以及
  **运行真实 `tsc` 的参考适配器**（`--adapter tsc-cli`，用于测试框架自检）；
- 假阳性、覆盖率、错锚及按用例分类细分的指标；
- 直接读取 TypeScript 7 官方仓库布局（`tsc/testdata/...`）中的 `.errors.txt` 基线，
  按 T0–T3 一致性阶梯评估每个用例（位置与码 → 严重级别 → 首行文本 → 诊断摘要文本），
  并按「实现 × 基线」维护只升不降的 `--ratchet` 清单；
- GitHub Actions 在每次推送和 PR 上运行单测及带门禁的冒烟测试；每日变化检测仅在
  输入变化（配置／锁文件哈希、仓库 HEAD、外部固定版本或提交）时重跑套件；
- `--gate` 将假阳性、漏报、错锚超限或 ratchet 回落转为非零退出码
  （T0–T2 参与门禁，T3 仅报告）；各 CI 档位生成 Markdown／HTML 报告并合并到运行摘要；
- 手动触发的 TS7 官方基线冒烟 workflow。

设计思路与报告解读见 [docs/DESIGN.md](docs/DESIGN.md)；
参数、字段和适配器协议见 [docs/REFERENCE.md](docs/REFERENCE.md)；
能力、已知限制与待办见 [docs/STATUS.md](docs/STATUS.md)；
历史演进与认识修正见 [docs/HISTORY.md](docs/HISTORY.md)；
自比与跨版本结果（包括不同 tsc 版本的默认选项漂移）见 [docs/RESULTS.md](docs/RESULTS.md)；
任务通过本仓库的 [Issue 列表](https://github.com/hax/tsc-compa/issues) 跟踪。

## 快速开始

环境要求：[Bun](https://bun.com) ≥ 1.3、`microsoft/TypeScript` 测试语料检出，
以及通过 npm 别名安装的 `tsc` 二进制（见 `package.json`）。

```bash
bun install

# 语料路径：指向检出的 tests/cases，语料版本须与基线配置匹配
export TSC_COMPA_CORPUS=/path/to/typescript/tests/cases

# 基线自比：同一个 tsc 既生成期望，也作为被测实现
bun src/run.ts --baseline 6.0.3 \
  --corpus "$TSC_COMPA_CORPUS" \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# 从官方 .errors.txt 基线读取期望（筛选后的子集）
bun src/run.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --expectation-source official-baseline --cases config/official-baseline-cases.json --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc

# TS7 官方基线（Go 仓库布局，T0–T3 分档 + ratchet）
export TSC_COMPA_CORPUS=/path/to/typescript-go/tsc/testdata/tests/cases
bun src/run.ts --baseline 7.1.0-beta-official --corpus "$TSC_COMPA_CORPUS" \
  --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json \
  --ratchet-impl tsc-7-1 \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc

# 用同一套件测试另一个检查器实现（批量适配器）
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

## 基线

`config/baselines.json` 将通过 npm 别名安装的 `tsc` 版本与语料版本、默认用例清单、
基础 CLI 参数配对（例如 5.9 不接受 `--ignoreConfig`）：

| 基线 | tsc | 语料 | 默认用例清单 |
| --- | --- | --- | --- |
| `5.9.3` | `typescript-5-9` | `v5.9.3` 标签 | `config/smoke-cases-5.9.json` |
| `6.0.3` | `typescript-6-0` | strada，v6.0.3 标签 `050880ce` | `config/smoke-cases.json` |
| `7.1.0-beta` | `typescript-7-1` | strada，v6.0.3 标签 `050880ce` | `config/smoke-cases.json` |
| `7.1.0-beta-official` | `typescript-7-1` | TS7 Go 语料，固定提交 `3e92363` | `config/smoke-cases-ts71-official.json` |

两套官方基线语料的固定提交均与对应 npm 包（`typescript@6.0.3` /
`typescript@7.1.0-beta`）的 `gitHead` 一致；`test/baseline-pins.test.ts` 检查这一
对齐关系，CI workflow 从 `config/baselines.json` 解析语料引用，不硬编码 SHA。

每个基线的 `baseArgs` 显式编码**官方测试框架的默认值**（参数顺序见
[技术参考](docs/REFERENCE.md#13-选项来源与优先级)，这样设计的原因见 `docs/DESIGN.md` §3.3）：

- 5.9：target ES5 / module CommonJS / moduleResolution Node10 / strict 关闭；
- 6.0：target ES2025 / module ES2022 / moduleResolution Bundler / strict 开启；
- 7.1：target ES2026 / 模块相关设置与 6.0 相同 / strict 开启。

这些默认值**只作用于期望侧**。适配器接收用例指令及显式传入的
`--base-arg` / `--adapter-arg`，其余选项使用实现自己的默认值。
跨版本比较若要单独观察语义差异，必须显式对齐选项：

```bash
# 5.9 期望与 6.0.3 适配器对照，两侧显式使用相同选项
bun src/run.ts --baseline 5.9.3 --corpus /path/to/v5.9.3/tests/cases --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc --base-arg strict=false --base-arg target=es2015 --base-arg module=es2015 --base-arg moduleResolution=bundler
```

基线间的差异以及固定版本／提交的重要性，见 [docs/RESULTS.md](docs/RESULTS.md)。

## 报告

每次运行都可以从生成的 `metrics.json` / `details.json` 输出人类可读报告，
无需为生成报告重复执行套件：

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

- 运行信息：时间、语料／tsc 固定版本或提交、实现名称及二进制 sha256、基线／模式；
- 指标摘要：覆盖率、假阳性、漏报、错锚、跳过、完全通过的用例数；
- T0–T3 一致性阶梯，以及启用 `--gate` 时的门禁结论；
- 与上次运行的差异：通过 `--prev-report` 指定；未指定时，若存在
  `<out>/prev/metrics.json` 则自动使用；
- 失败与回归提示。

HTML 报告包含相同内容，使用内联 CSS 和内联 SVG 阶梯图，不依赖外部资源。
生成过程具有确定性（相同输入生成相同字节），因此可缓存或比较差异。
报告渲染或写入失败会以非零退出码结束，不会把失败的运行变成通过。

独立报告 CLI 与 `run.ts` 默认使用相同的 `<out>/prev/metrics.json` 作为上次运行数据，
因此在使用默认对比数据时，`bun src/report.ts --from <out>` 可以逐字节复现运行时的报告
（若 `run.ts` 显式指定了 `--prev-report`，重新生成时也要传相同路径）。

CI 中，`smoke.yml` 的每个矩阵档位写入 `report.md` / `report.html`，与
`metrics.json` / `details.json` 一起上传为 `report-<entry>` 产物。
即使门禁失败也会生成报告；若运行在写入指标前崩溃，则生成失败占位报告。
`report` 任务将所有档位合并到该次运行的 **Summary** 页面，并上传
`report-summary` 产物；下载后打开 `report/index.html` 即可浏览各档位的 HTML 报告。
workflow 令牌为只读（`contents: read`），因此只通过步骤摘要和产物发布报告，
不向 PR 发送评论。

## CI 与兼容性门禁

`.github/workflows/smoke.yml` 在每次推送和 PR 上运行，下表中的矩阵构成兼容性门禁；
同时每日定时触发一次（`cron 23 19 * * *`，即 UTC 19:23／北京时间次日 03:23，
避开整点）。**每日任务由变化驱动，并非每日全量运行**：先运行 `detect` 任务
（约 30 秒），只有检测到变化才执行套件。没有变化时不运行套件，
以「无变化，跳过」摘要结束，状态为通过。

变化检测（`scripts/detect-changes.ts`）将当前状态与上次**成功**运行套件后记录的状态
比较，状态通过 `actions/cache` 保存：

| 检测信号 | 检测方式 | 查询条件／用途 |
| --- | --- | --- |
| 本地输入 | `config/**`（基线／语料／用例清单／实现／ratchet）、`package.json` 和 `bun.lock` 的 SHA-256 | 始终可查 |
| 仓库 HEAD | 当前 `github.sha` 与上次成功运行记录的 HEAD 比较 | 始终可查 |
| npm 固定版本 | 从 npm registry 查询各精确固定版本的 `dist.integrity`（tsc 别名及 `implementations.json` 中的 npm 版本） | 需要网络；不可查询时视为未变化 |
| 语料固定引用 | 通过 GitHub API 解析 `config/baselines.json` 中的各个 `corpora.*.ref`（标签移动会改变提交） | 需要网络／GitHub API；不可查询时视为未变化 |
| 第三方 cargo git 固定提交 | 检查固定提交是否仍存在于 GitHub（`tsc-rs`、`tsz`）；非 GitHub URL 标记为不可比较 | 需要网络／GitHub API；不可查询时视为未变化 |
| 上游默认分支 HEAD | 只报告，不触发运行（版本／提交已固定，输入不随上游 HEAD 改变） | 仅供参考 |

定时或手动触发时，若首次运行没有缓存状态，则视为有变化。
`workflow_dispatch` 默认也经过变化检测；设置 `force` 输入可跳过检测、强制运行套件。
只有所有套件通过后才更新已保存的状态，因此失败会在后续检测中重试，直到通过。

套件矩阵（仅在检测判定需要运行时执行）：

| 档位 | 期望来源 | 门禁 |
| --- | --- | --- |
| 自比 × `5.9.3` / `6.0.3` / `7.1.0-beta` | 固定版本 tsc | `--gate` 零差异自检：不允许假阳性、漏报或错锚 |
| `7.1.0-beta-official`，28 例 | TS7 官方 `.errors.txt` | 逐案 ratchet（`config/ratchet-ts71-official.tsv`）：任何门禁档位回落均失败 |
| `6.0.3` 官方基线子集，191 例 | strada `.errors.txt` | 容忍已知的测试框架保真度缺口（12 条假阳性／4 条漏报；见 `docs/RESULTS.md` 结论 11），参数为 `--gate-max-fp 12 --gate-max-miss 4 --gate-min-coverage 0.99` |

启用 `--gate` 后，必须满足以下所有条件，否则运行失败并以非零退出码结束；
逐项结果会打印并保存到 `metrics.meta.gate.checks`：

1. 本次运行可作为兼容性结论（`--mode official`，且适配器接受外部选项；
   `--mode fixed` 会被拒绝，不会判为通过）；
2. 至少运行一个用例；
3. 配置 ratchet 清单时，T0–T2 门禁档位无回落，且清单必须非空、已提交入库
   （门禁模式不自动初始化，也不写回改善；空清单会被拒绝，不会判为通过）；
4. 假阳性／漏报／错锚不超过 `--gate-max-fp` / `--gate-max-miss` /
   `--gate-max-misanchor`，覆盖率不低于 `--gate-min-coverage`。

未配置 ratchet 清单时，三个计数上限默认为 0（自检口径）；配置清单后，
默认不限制总条数，由清单逐案约束，仍可叠加显式上限。

**门禁档位**：只有 T0 位置与码／T1 严重级别／T2 首行文本通过 ratchet 清单逐案参与门禁。
清单存储 `location|category|text`，旧的 `full` 条目在读取时归一为 `text`。
**T3 诊断摘要文本一致（换行归一后的 `.errors.txt` 摘要块）仅用于报告**：
T3 未达记录在 `totals.byTier` / `totals.t3Failures` 中，不会导致门禁失败。

配置分支保护时，应将稳定的聚合任务 **`compat-gate`** 设为必需状态检查。
它汇总 `detect` / `unit` / `smoke` / `report`：无变化而跳过时通过；
套件、检测或报告任务失败时失败。
必需状态检查属于仓库设置，不能仅通过 workflow 文件声明。
`ts7-official.yml` 仍是手动 workflow，虽已带 `--gate`，但按现有记录尚未在
GitHub Actions 上运行；应先手动触发并确认通过，再考虑为其增加独立定时任务
（变化驱动的 `smoke.yml` 定时任务已在输入变化时重跑相同的 28 个官方基线用例）。

## 用例分类

`src/classify.ts` 为每个用例添加多个正交标签，例如 `suite:compiler`、
`files:multi`、`lang:js`、`lang:jsx`、`shape:parser`、`options:module`、
`options:lib`、`options:emit`、`env:skip`，以及运行时标签
`expect:syntax`、`expect:no-errors`。指标包含 `byClass` 分类明细；
标签可能重叠，因此各分类数字不能直接相加。

通过 `--exclude-class a,b` / `--only-class` 过滤。被排除的用例会记录为
SKIP，原因为 `类排除:<tag>`，不会静默消失。

重新生成冒烟用例清单（按类过滤，再由基线 tsc 剔除语法错误用例）：

```bash
bun scripts/select-smoke.ts --baseline 6.0.3 --corpus "$TSC_COMPA_CORPUS" --out config/smoke-cases.json
```

## 其他适配器

- `tsc-cli`：参考实现，见 [docs/RESULTS.md](docs/RESULTS.md)；
- `none`：不报告任何诊断；
- `mock-batch`：批量协议参考实现，见 `src/adapters/mock-batch.ts`；
- `cli:<bin>`：通用逐案 CLI，通过 `TSC_COMPA_CLI_ARGS` 传额外参数；
- `checker-cli`：驱动支持 `--json` 输出的检查器二进制，逐案运行、使用固定选项集，
  通过 `CHECKER_BIN` 或 `checker-cli:<bin>` 指定二进制；
- `checker-batch`：同一二进制的批量 NDJSON 模式，使用 `CHECKER_BATCH_BIN`，
  未设置时回退到 `CHECKER_BIN`。

`--mode fixed` 忽略用例指令，强制使用适配器的固定选项集，因此其数字只用于验证流水线。
`--mode official` 遵循用例指令；只有适配器也接受外部选项时，
本次运行才可作为兼容性结论（`verdictEligible`）。

## 第三方实现

任何提供 TSC 兼容 CLI 的检查器都可通过现有 `tsc-cli` 适配器驱动，
无需为其编写内部适配器。获取方式（npm 预编译包／cargo 构建／本地二进制）、
固定 CLI 参数、上游固定提交及相位指标登记在
[`config/implementations.json`](config/implementations.json)：

```bash
# 按登记信息获取实现，并打印二进制路径
BIN=$(bun scripts/install-impl.ts --name tsrs --dest .tools | tail -1)

# 在 TS7 官方基线上对该实现运行同一套冒烟测试
TSC_COMPA_ADAPTER_ARGS="--singleThreaded" \
bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus /tmp/ts71-corpus/tsc/testdata/tests/cases \
  --adapter "tsc-cli:$BIN" --mode official \
  --expectation-source official-baseline \
  --ratchet-impl "$IMPL"
```

`.github/workflows/third-party.yml` 在 CI 中执行相同流程（手动触发，
按「实现 × 基线」运行）。已记录的结果：`tsrs` 在 TS7 官方基线和 strada 7.1 基线上
均为 28/28 通过、0 假阳性、100% 覆盖率，见 [docs/RESULTS.md](docs/RESULTS.md)。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `src/case.ts` | 用例指令解析、虚拟文件、编译选项推导 |
| `src/classify.ts` | 正交用例标签与过滤 |
| `src/baselines.ts` | 基线配置（tsc × 语料版本） |
| `src/discover.ts` | 语料扫描与用例清单 |
| `src/tsc.ts` | 通过固定版本 tsc CLI 生成并缓存期望诊断 |
| `src/officialBaseline.ts` | 读取官方 `.errors.txt` 基线作为期望源（strada 平铺布局 + TS7 Go 布局，含平铺套件；缺基线视为无错误） |
| `src/compare.ts` | 诊断匹配（含错锚配对）、T0–T3 一致性阶梯与指标；T3 比较 `.errors.txt` 中 `====` 前的摘要块，并记录逐案未达原因 |
| `src/ratchet.ts` | `--ratchet` / `--ratchet-impl` 清单：按「实现 × 基线」只升不降，回落则运行失败 |
| `src/gate.ts` | `--gate`：ratchet／假阳性／漏报／错锚／覆盖率检查及门禁摘要 |
| `src/report.ts` | 从运行指标和明细生成 Markdown + 自包含 HTML 报告；支持 `run.ts --report-md/--report-html/--report-out` 及独立命令 `bun src/report.ts --from <out>`，指标缺失时生成失败占位报告 |
| `src/run.ts` | 冒烟运行入口 |
| `src/adapters/` | 参考 `tsc-cli` 适配器（保留多行阐述和关联信息用于 T3）、`checker-cli` 逐案适配器、通用 `cli:<bin>` 适配器、批量协议客户端及模拟实现 |
| `config/baselines.json` | 基线配置（参考 tsc、期望侧参数、语料引用与默认用例清单） |
| `config/implementations.json` | 第三方实现登记（获取方式、CLI 参数、固定版本／提交） |
| `config/smoke-cases*.json` | 按语料维护的可复现冒烟用例清单 |
| `config/anchor-cases.json` | 已知跨版本锚点差异的用例 |
| `config/official-baseline-cases.json` | 可读取官方基线的样本用例清单 |
| `config/smoke-cases-ts71-official.json` | TS7 官方基线冒烟清单（18 个报错用例 + 10 个无错用例） |
| `config/official-baseline-cases-ts71.json` | 120 个带错误的 TS7 用例（扩展本地样本） |
| `config/ratchet/` | 按实现分账的 T0–T2 门禁 ratchet 清单（`<impl>-<baseline>.tsv`；T3 full 仅报告，清单中归一为 text）；`config/ratchet-ts71-official.tsv` 为旧版共用清单 |
| `scripts/select-smoke.ts` | 重新生成按类过滤的冒烟用例清单 |
| `scripts/select-official-baseline-cases.ts` | 扫描语料，筛选可读取官方基线的用例 |
| `scripts/install-impl.ts` | 按登记信息获取第三方实现 |
| `scripts/detect-changes.ts` | 每日定时变化检测：本地输入哈希、仓库 HEAD、外部固定引用漂移 → 运行套件或「无变化，跳过」 |
| `scripts/merge-reports.ts` | 将各 CI 档位报告合并为步骤摘要（Markdown）和 HTML 索引 |
| `.github/workflows/smoke.yml` | 推送／PR 的 CI 门禁：单测 + 自比 `--gate` 冒烟 + 官方基线门禁；逐档报告及合并摘要／产物；每日任务先检测变化 |
| `.github/workflows/ts7-official.yml` | 手动 CI：TS7 官方基线冒烟（T0–T3 + ratchet + `--gate`） |
| `.github/workflows/third-party.yml` | 手动 CI：第三方实现 × 基线冒烟 |
| `docs/DESIGN.md` | 设计思路、报告解读与术语 |
| `docs/REFERENCE.md` | 参数、字段、比较规则和适配器协议 |
| `docs/STATUS.md` | 实现状态、版本配置、已知限制与待办 |
| `docs/HISTORY.md` | 重要演进及历史认识修正 |
| `docs/RESULTS.md` | 自比、默认值漂移及跨版本结果 |
| `src/perf.ts` | 可选性能附录：固定样本与官方 tsc 的参考比值 |
| `test/` | 单元测试（`bun test ./test`） |

## 可选性能附录

`--perf-ratio` 为常规兼容性运行增加性能**附录**，不改变通过／失败结论。
常规运行时直接记录实现的逐案墙钟时间，并在同一次运行中用官方 tsc
带 `--extendedDiagnostics` 执行固定分层样本（默认 300 例），生成性能比值。

```bash
bun src/run.ts --baseline 7.1.0-beta-official --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json --adapter checker-cli:<bin> --perf-ratio
```

参考 tsc 使用固定分层样本（套件 × 行数分桶 × 期望错误，默认 300 例，
通过 `--perf-sample` 调整）。每个用例两侧各运行一次，一半样本先运行参考 tsc，
另一半先运行被测实现。两侧都报告 `--extendedDiagnostics` 时，
主比值使用累计 Check 相位时间；否则使用扣除空程序基线后的墙钟时间
（若参考侧固定成本占主导，则保护性地返回 null）。
数字写入 `metrics.json` 的 `perf` 字段；测量方法见
[技术参考](docs/REFERENCE.md#9-性能指标)，设计思路见 `docs/DESIGN.md` §8。

## 测试语料许可

TypeScript 编译器测试套件（`microsoft/TypeScript` 的 `tests/cases` 和基线）
采用 Apache-2.0 许可，本仓库在 CI 运行时读取这些语料。
本仓库自身的代码与数据同样采用 Apache-2.0 许可，见 [LICENSE](LICENSE)
和 [NOTICE](NOTICE)。
