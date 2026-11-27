# 接收检查器二进制并运行兼容性测试（native-suite）

本文说明 CI 操作。设计与术语见 [DESIGN.md](DESIGN.md)，
参数和比较规则见 [REFERENCE.md](REFERENCE.md)，
当前能力和限制见 [STATUS.md](STATUS.md)，历史变化见 [HISTORY.md](HISTORY.md)。

实现侧 CI 构建二进制后，会把它作为本仓的 Release Asset 上传，并发送 `repository_dispatch`（`event_type = checker-binary`）触发本 workflow。本仓用自带的 `GITHUB_TOKEN` 下载自己的 release asset，不需要额外凭据。

## 触发

1. `repository_dispatch`（自动）：payload 形如

```json
{
  "implementation": "checker",
  "source_sha": "<源码提交 sha>",
  "release_tag": "binary-checker-<sha>-linux-x64",
  "asset_name": "checker-<sha>-linux-x64",
  "platform": "linux-x64",
  "baseline": "7.1.0-beta"
}
```

2. `workflow_dispatch`（手动回退）：填 `release_tag` + `asset_name` 从本仓 release 下载；
   或给 `binary_url` 直接下载任意实现的二进制。可指定 `baseline` / `mode` / `limit`。
   `limit=0` 表示该基线冒烟集全部；非 0 只取前 N 项，指标里用 `meta.selectedCases`
   和 `details.json` 记录实际范围，不能当作完整套件结果。

## 做什么

1. 按 `baseline` 从 `config/baselines.json` 解析测试集版本，将官方的
   `microsoft/TypeScript` 仓库检出到 `reference/corpus`；
2. 下载 release asset 并校验可执行；
3. 用 `checker-batch` 适配器跑该参考配置的默认冒烟集（`meta.selectedCases` 记录实际数量）；
4. 上传 `metrics-<impl>-<baseline>` artifact，并在 job summary 里贴
   多报错误／漏报／覆盖率／跳过／`verdictEligible` 摘要。

`native-suite.yml` 把 `--corpus` 固定指向 `reference/corpus/tests/cases`；
选择 `7.1.0-beta-official` 时，该 workflow 没有改写为 TS7 Go 的
`tsc/testdata/tests/cases` 布局，因此不能直接照搬为官方结果对照任务。
`checker-batch` 在工厂里固定 `supportsOptions=false`；`mode=official` 不会被这个
workflow 转成可作兼容性结论。该 workflow 当前没有接 `--gate`，也没有逐档
Markdown／HTML 报告：它上传的是 `metrics.json` / `details.json`，失败运行不会
回填报告占位。
`ts7-official.yml` 只在 `limit=0` 时使用清单和门禁；非零 `limit` 是评估范围，
不能拿来代替完整回归。

## CI 兼容性门禁（`smoke.yml`）

`smoke.yml` 在每次 push / PR 上跑「单元测试 + 门禁式冒烟」（每次提交都要有兼容性结论）。
`unit` job 先运行 `bun run typecheck`，再运行 `bun test ./test`；没有单独的
typecheck job。每日 cron（`23 19 * * *`，UTC 19:23 / 北京时间 03:23，避开整点）是
**变化驱动**的：
先只跑 `detect` job（约半分钟），输入没变就输出「no changes, skip」并结束、不跑测试；
有变化才跑下面的矩阵。冒烟矩阵六档：

| 任务项（slug） | 参考配置 | 测试集 | 参考结果来源 | 门禁规则 |
| --- | --- | --- | --- | --- |
| 5.9.3 自比（`5.9.3-self`） | 5.9.3 | `v5.9.3` | 运行 tsc | `aligned`；已完成用例全部兼容，零多报／漏报／位置差异 |
| 6.0.3 自比（`6.0.3-self`） | 6.0.3 | strada | 运行 tsc | 同上 |
| 7.1.0-beta 自比（`7.1.0-beta-self`） | 7.1.0-beta | strada | 运行 tsc | 同上 |
| TS7 async API 自比（`7.1.0-beta-api-self`） | 7.1.0-beta-official | TS7 Go 布局 | `ts7-api`（参考与候选共用实现） | `aligned`，`--gate --gate-profile strict`，无 ratchet；严格档必须全部 `pass`，`unknown` 不能当通过 |
| TS7 官方结果文件（`7.1.0-beta-official`） | 7.1.0-beta-official | TS7 Go 布局 | 官方 `.errors.txt` | `config/ratchet-ts71-official.tsv` 保护已验证的兼容用例，默认兼容保护档 |
| 6.0 官方结果子集（`6.0.3-official-subset`） | 6.0.3 | strada | 官方 `.errors.txt` | `config/ratchet/typescript-6.0.3-official.tsv`，另检查 `--gate-max-fp 12 --gate-max-miss 4 --gate-min-coverage 0.99` |


`--gate` 默认保护兼容档。选择 `--gate-profile strict` 也阻断严格一致性回归；字段回归始终报告。
门禁需要可作结论的运行（`official` 模式且适配器支持选项），至少一个完成用例；用回归记录时不会写回。
在 `metrics.meta.gate` 可查看阻断原因，在 `metrics.meta.ratchet.regressionDetails` 可查看逐案回归。

API 档没有 ratchet 时，严格档要求本次已完成用例全部为 `pass`；`fail` 或 `unknown` 都阻断。
2026-11-27 用 Bun 1.4.4 复跑，本地报告 `.cache/goal/certified-final-2026-11-27/api-self` 显示严格通过 28/28。
远端结果以 Actions 产物为准。纯文本 CLI 的严格档 `unknown`
不计为通过，也不从旧 T3 或 API 自比结果反推。

### 人类可读报告

每项任务跑完都会从同一份 `metrics.json` / `details.json` 生成 `report.md` 与自包含
`report.html`（内联样式，不重跑测试）：

- `smoke.yml` 的「Smoke + gate」步骤带 `--report-md` / `--report-html`；随后
  `if: always()` 的「Generate report」再用 `bun src/report.ts --from .cache/run`
  补生成——运行提前崩溃、没写出 metrics 时生成「失败占位报告」。
  报告生成失败也会使相应任务失败。
- 每项任务上传 artifact `report-<slug>`（`report.md`、`report.html`、`metrics.json`、
  `details.json`；可据此查看明细），失败任务的 artifact 同样上传。
  这些步骤只在检测判定运行时执行；`detect` 判「无变化」时，smoke 与 report 都是
  `skipped`，不会有当天的报告产物。
- `report` job（依赖 `detect` 和 `smoke`，只在检测计划要求运行时尝试汇总）下载任务报告，用
  `scripts/merge-reports.ts` 合并成一份 Markdown 摘要写进本次 run 的 **Summary** 页，
  并把 `report/index.html`（分别链接到 `report.html`）上传为 artifact
  `report-summary`；失败或缺少 metrics 的任务在汇总表里直接标出。`report` 也纳入
  `compat-gate` 的聚合。`report` 只依赖 `detect` 与 `smoke`，不依赖 `unit`；单测失败时
  报告仍会生成，但 `compat-gate` 会汇总 `unit` 的失败并让最终检查失败。
- 没有做 PR 评论：本 workflow 只有 `contents: read`，写评论需要
  `pull-requests: write`，且 fork PR 的 token 只读；step summary + artifact 已经
  覆盖「在哪看」的需求，评论等 P1 再评估。
- 本地生成、`--prev-report` 差异对比与报告内容见 README 的[「报告」一节](../README.md#报告)；单独补报告：

```bash
# 无门禁时也能出报告；delta 用上次运行的 metrics.json（或它的输出目录）
bun src/run.ts --baseline 6.0.3 --corpus /path/to/strada/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc \
  --report-out .cache/run/report --prev-report .cache/previous/metrics.json

# 跑完事后补一次：没给 --prev-report 时，与 run.ts 内直接生成的结果逐字节一致
# （两边都默认读 <from>/prev/metrics.json；run.ts 用了显式 --prev-report 时，
#  这里要传同一份才一致）
bun src/report.ts --from .cache/run --md .cache/run/report.md --html .cache/run/report.html
```

### 每日 cron 的变化检测（`scripts/detect-changes.ts`）

detect 把当前状态与「上次测试全部通过后」记录的状态（`actions/cache` 里的
`state.json`）比较，任一变化即跑测试：

| 检测项 | 怎么查 | 可查性 |
| --- | --- | --- |
| 本地输入 | `config/**`（baselines / corpora / manifest / implementations / ratchet）+ `package.json` + `bun.lock` 的内容 SHA-256 | 总能查 |
| 仓库 HEAD | 当前 `github.sha` vs 上次成功后记录的 headSha | 总能查 |
| npm pin | package.json 的 npm alias 与 implementations.json 的 npm 版本，查 registry 精确版本的 `dist.integrity`（重发布/撤包会变） | 需网络；查不到记 unavailable、按未变化处理 |
| 测试集固定提交 | `config/baselines.json` 的 `corpora.*.ref` 经 GitHub API 解析成 commit sha（tag 被移动会变） | 需网络 / GitHub API；查不到记 unavailable |
| 第三方实现 cargo git pin | `tsc-rs` / `tsz` 的 pin commit 是否仍存在；非 GitHub 地址列为「不可比对」 | 需网络 / GitHub API；查不到记 unavailable |
| 上游默认分支 HEAD | 只写进 summary 报告，不触发（pin 固定，被测输入没变） | 信息项 |

补充约定：

- 首次运行 / 缓存缺失视为有变化；只有测试**全部通过**后 record job 才更新状态，
  失败的输入下次会被重新判为有变化并重跑（不会把失败输入记成「已跑过」）；
- push / PR 不走变化判定（门禁每次都要结论）；`workflow_dispatch` 默认同样先检测，
  勾 `force` 输入可跳过检测强制跑；
- 缓存按分支隔离：push / 手动 dispatch 的测试全部通过后保存状态（pull_request 不保存）；
  每日 cron 在默认分支只读得到默认分支保存的状态。7 天未使用的 cache 会被 GitHub
  清理，清理后下一次视为首次运行（多跑一次，不影响正确性）。

本地模拟两种输入（改 config 文件即等价于「输入变化」）：

```bash
# 第一次：无状态 → run=true；不改输入复跑同一条命令 → run=false；改 config → run=true
GITHUB_EVENT_NAME=schedule GITHUB_SHA=$(git rev-parse HEAD) bun scripts/detect-changes.ts --out .cache/smoke-detect

# 强制跑（等价于 workflow_dispatch 勾 force）；--offline 可跳过网络查询
GITHUB_EVENT_NAME=schedule GITHUB_SHA=$(git rev-parse HEAD) bun scripts/detect-changes.ts --out .cache/smoke-detect --force
```

要把门禁真正用于「阻断合并」，需在仓库设置里把稳定聚合 job **`compat-gate`** 设为
required status check（它汇总 `detect` / `unit` / `smoke` / `report` 的结果：无变化时
测试与报告 job skipped 也算通过，测试失败、detect 失败或报告生成/合并失败都会失败；
也可同时要求 `unit` / `smoke`。分支保护是仓库设置，不在 workflow 文件里）。

本地复现：

```bash
# 自比 + 零差异门禁
bun src/run.ts --baseline 6.0.3 --corpus /path/to/strada/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc --gate

# TS7 官方结果文件 + ratchet 门禁
bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus /path/to/typescript/tsc/testdata/tests/cases \
  --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json \
  --ratchet config/ratchet-ts71-official.tsv \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc --gate
```

## 适配器

`ts7-api` 是 TS7 async API 的参考／候选适配器：Bun 进程持有 API 客户端，TS7 后端是
持久子进程。它在单个 API 会话内串行处理用例，每个用例独立建 program 并 dispose，
保留 `width`、`messageChain`、`related`、`attributes` 与格式化后的 `fullText`；
没有逐案进程退出码。`--expectation-source ts7-api` 与 `--adapter ts7-api` 同时使用时，
两侧都走 API，各自建立 program。

`src/adapters/checker-cli.ts` 把检查器二进制的 `--json` 输出（字段 `file/start/end/line/col/end_line/end_col/severity/code/message`，1-based 行列）映射为测试接口：

- 跳过 `code === 0`（实现自己的 early error，不对应 tsc 错误码）与非数字码；
- 路径按用例临时目录前缀裁剪成相对路径；
- 行列转 0-based，宽度取 `end - start`；
- 超时（30s）记为 skip，异常退出/非 JSON 输出记为 crash，不静默通过。

适配器不支持外部编译选项（`supportsOptions=false`），因此默认用 `--mode fixed`（固定 strict+esnext 设置）运行；`official` 模式会打印警告并标 `verdictEligible=false`。

## 当前限制

- `native-suite.yml` 的默认冒烟集来自参考配置；当前任务描述中的 28 例不能
  推广到所有基线或 `--limit`。全量样本仍走批量协议，尚未把 12k 用例作为本 workflow
  的默认输入。
- `smoke.yml` 的六档运行纳入 `compat-gate`。手动任务中，`ts7-official.yml` 在不限制
  用例数时启用兼容档门禁；`third-party.yml` 仅在官方结果对照已有「实现 × 参考配置」
  回归记录且 `limit=0` 时启用门禁。`native-suite.yml` 不启用门禁。
- 每日 cron 的变化检测只覆盖上表列出的输入：范围版本、非 GitHub 获取源、无网络/API
  限流时按「未变化」处理；上游发了新版本但 pin 未改不会触发重跑（需要人工改 pin，
  走推送门禁）。无变化时当天不产出新的兼容性指标，历史指标以最近一次运行为准。
- 目前只接 linux-x64；其它平台在实现侧加构建矩阵即可，本 workflow 不区分平台。
- 本地实测不等于远端 CI 通过。当前仓库记录没有证明 GitHub Actions 上已经跑过
  `smoke.yml` 的六档、`ts7-official.yml` 或 `third-party.yml`；远端状态需以对应 run
  的 Summary 与 artifact 为准。

## TS7 官方结果文件对照（`ts7-official.yml`）

与上面「接收二进制」的流程独立，手动触发，直接读取 TS7 官方仓库的 errors 结果文件：

- 测试集提交：`config/baselines.json` 的 `ts71-official` 配置（当前 `3e92363`，= npm
  `typescript@7.1.0-beta` 的 gitHead；workflow 现场解析 ref，不硬编码）。Go 布局：cases 在
  `tsc/testdata/tests/cases`，基线在 `tsc/testdata/baselines/reference`；
- 参考结果来源：`--expectation-source official-baseline`。具名配置没有 `.errors.txt` 时，
  必须有同配置的 `.types`、`.symbols`、`.js` 等产物佐证才记为零诊断；否则跳过，而非借用其他配置的结果；
- 报告分别统计兼容和严格一致结果，保留逐案诊断及字段差异；
- 门禁：`limit=0` 时用 `--ratchet config/ratchet-ts71-official.tsv` + `--gate`，
  采用默认兼容保护档。门禁不初始化、不写回；改善由维护者本地运行、审阅后提交；
- `limit` 非 0 时只传 `--limit`，不传 `--ratchet` / `--gate`。它限制展开前的源文件数
  （`meta.selectedCases`），不是展开后的记录数（`totals.cases`）；具名记录可用
  `details.json` 的 `caseId` 与 `configuration` 追到源文件和配置；
- 报告：跑完（含门禁红）生成 `out/report.md` / `out/report.html`，job summary 贴出
  Markdown 全文，`ts7-official-metrics` artifact 里可直接打开 HTML；没有 metrics 时
  由 `src/report.ts` 出失败占位报告；
- 首次使用时先手动触发并检查结果，再决定是否单独配置定时任务；
  `smoke.yml` 的每日变化检测在判「有变化」时会覆盖同一组 28 例官方结果文件对照测试。
  两个 workflow 的远端执行都尚未从现有记录得到证明。

## 第三方实现冒烟（`third-party.yml`）

手动触发，输入「实现名（config/implementations.json）× 基线 id（7.1.0-beta-official / 7.1.0-beta）」：

- 按参考配置从 `config/baselines.json` 取得测试集引用并检出（官方结果文件使用 TS7 Go 布局，普通 7.1 使用 strada）；
- 实现按 registry 的获取方式安装：`localEnv` 优先（本地调试），其次 npm 预编译（如 `tsrs`、`ts-rust`），最后 cargo 构建（`tsc-rs`、`tsz` 等无 npm 包的实现）；`scripts/install-impl.ts` 打印二进制路径；
- **cargo 路径（CI）**：workflow 按 `acquisition.cargo.git` 是否存在按需安装 Rust 1.99.1，并按登记的 git pin **浅拉取**源码到 `.tools/src/<impl>-<sha7>`，用外部 `CARGO_TARGET_DIR=.tools/target/<impl>` 构建，不写入仓库检出。`tsz` 额外通过 `cargo.env` 强制 `CI=1`（其仓库默认把 target 写进检出并改 `.git/config`）。cargo registry/git 与 `.tools/target` 走 actions/cache，job 超时 20 分钟、获取/构建步骤 15 分钟；
- 新增实现时：在 `config/implementations.json` 登记 `cargo.git.url/ref`（本地开发仍可直接用 `reference/<repo>` 检出）、构建命令、产物相对 `target/` 的路径与必要的 `env`；无需改 workflow 或 adapter；
- 自动带 registry 里的固定 CLI 参数（如 `tsrs` 的 `--singleThreaded`），用 `tsc-cli` 适配器驱动；
- 官方结果对照在已入库 `config/ratchet/<impl>-7.1.0-beta-official.tsv` 且 `limit=0` 时
  使用 `--ratchet` + `--gate`；没有记录或限制样本时进入评估报告模式，不写回 tracked 清单；
- 报告与指标作为产物上传；任务摘要标出适配器、模式、`limit`、回归记录路径及选中的源文件数。
  比较完成数须看 `totals.ran`；展开配置后它不一定等于源文件数。

当前流程通过 CLI 驱动第三方检查器，不改其源码；获取方式、阶段字段和并行开关的差异登记在
`config/implementations.json` 与 `docs/RESULTS.md`。Bun 内置检查器使用 `bun-check`
适配器，其余 TSC 兼容实现仍走 `tsc-cli:<bin>`，不把不同实现的默认参数混成一套。

本地记录中 `tsrs` 的 28/28、100% 覆盖率来自 macOS 固定版本实测，不能推出
`third-party.yml` 已在远端跑过。`tsrs` 的 npm 二进制自报的 TypeScript 提交仍是 TS7
测试集 pin，不是 tsrs 自己的源码提交；报告里的二进制 sha256 与 provenance 需要分开读。

## 候选检查器的适配器冒烟（`candidate-adapter-smoke.yml`）

同一份 TS7 官方 28 例列表也用于候选适配器的端到端验证。工作流从
`config/implementations.json` 选出支持 `7.1.0-beta-official` 的固定版本，
用各自登记的适配器逐一运行，对照同一提交里的官方 `.errors.txt`。它在改到适配器、
运行器或相关配置的 PR 上触发，也可以手动运行，不纳入 `smoke.yml` 的 `compat-gate`。

下载／构建失败、执行崩溃／超时或所有用例都跳过会使对应任务失败。单案跳过和原因
单列（例如 Bun 1.4.x 不支持继承的 `target=es2026`），诊断差异写入报告但不阻断。
执行失败说明候选与适配器的组合出现问题，不能只凭这一步断定是哪一侧的缺陷。
每个候选在 Actions Summary 和 `adapter-smoke-<id>` artifact 留下结果，后者包含
`metrics.json`、`details.json` 和 Markdown／HTML 报告。需要评估候选兼容性时，
看后文的全量报告而不是这 28 例。

## 固定版本兼容性报告（`compatibility-reports.yml`）

手动运行。矩阵分别执行 TypeScript 7.1.0-beta、`bun check` 1.4.4 和 1.4.5、`oxc-project/tsrs`。
每项使用 `config/official-baseline-cases-ts71.json` 的 120 例列表，分别与现场生成的
tsc 结果和官方 `.errors.txt` 对照。诊断差异用于评估，不作为门禁；没有完成任何比较、
执行失败或适配器不能接受用例选项则任务失败。

`scripts/validate-compatibility.ts` 从 manifest 读取固定样本数，并要求
`meta.verdictEligible === true`、`totals.ran === 用例总数` 且没有执行失败；120 例
运行必须全部完成，少跑或跳过不会静默通过。每项上传 Markdown、HTML 和两份 JSON，
供逐案复核。脚本在本地按同一候选逐次执行，避免多个候选并行影响性能样本。
手动 workflow 的远端运行同样需要查看实际 artifact，不能仅凭 YAML 判定已通过。

Bun 1.4.4／1.4.5 的 `bun check` 拒绝 `target=es2026`；当前 120 例都显式覆盖
target，因此不能把通过率外推到 Bun 默认 target 或项目配置。`bun-check` 对启用
`declaration`、`emitDeclarationOnly` 或 `composite` 的配置显式跳过，不用普通类型检查
代替声明生成阶段的诊断。两个 Bun 的
`process.versions.typescript` 都是 `7.0.2`，不是参考 tsc 版本。`tsrs` 的二进制
自报 TypeScript pin `3e9236361fa9`，这是它跟踪的上游提交，不是 tsrs 自身源码提交；
报告需同时保留 npm provenance 和二进制 sha256。

## TS7 全量类型检查对照（`full-compatibility.yml`）

这项评估与 `smoke.yml` 的 PR 门禁分开。合入后可从 Actions 手动运行；改变该工作流、分片脚本或其测试的 PR 也会触发默认评估。默认使用固定提交的官方 `.errors.txt`，因为参考结果不用逐案重新生成；需要独立检查官方测试框架与现场 CLI 的差异时，手动选择 `reference=tsc`。全量对照不是速度基准。

计划任务清点 `compiler/` 和 `conformance/` 下的 `.ts`、`.tsx`、`.mts`、`.cts` 源文件。转译、IDE 和辅助文件不算作检查用例。默认每个候选 8 片，4 个候选共 32 个任务，最多同时跑 8 个。按源文件分片：同一源文件的配置不拆开；按配置数、测试源大小和估计的进程启动开销平衡负载。工作流使用固定的语料提交，只检出所需子目录，并优先直接调用原生 tsc，避免每案再启动 npm 的 JavaScript 启动器。

- `compatibility-shard-plan`：按候选共享的源文件及配置清单。
- `full-<候选>-<分片>`：该片的 `cases.json`、`metrics.json`、`details.json`。
- `full-summary`：汇总 Markdown 和 JSON，列出每个候选的完成、跳过、两档结果、诊断命中与异常。覆盖率按所有分片的命中数除以期望数，不平均各片百分比。

汇总按计划逐片核对源文件和配置记录；缺片、重计、候选二进制不一致、崩溃或超时都会标为不完整，任务失败。可采集的不兼容结果照常报告，不是工作流故障。当前不支持的配置仍按原因跳过，不能计入兼容通过。若重跑失败的任务，成功分片的产物可继续用于汇总。
