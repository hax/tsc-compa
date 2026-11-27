# 持续集成与兼容性报告

按用途选择任务见[工作流索引](../.github/workflows/README.md)。本文说明如何运行门禁、查看公开评测和发布报告。
通过受控 Release 接入自有检查器的流程见
[接入自有检查器](NATIVE-CHECKERS.md)；该入口不参与公开报告部署。
设计与术语见 [DESIGN.md](DESIGN.md)，参数和比较规则见 [REFERENCE.md](REFERENCE.md)。

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

- `smoke.yml` 的六档运行纳入 `compat-gate`。手动运行 `third-party.yml` 时，仅在官方结果对照已有
  「实现 × 参考配置」回归记录且 `limit=0` 时启用门禁。
- 每日 cron 的变化检测只覆盖上表列出的输入：范围版本、非 GitHub 获取源、无网络/API
  限流时按「未变化」处理；上游发了新版本但 pin 未改不会触发重跑（需要人工改 pin，
  走推送门禁）。无变化时当天不产出新的兼容性指标，历史指标以最近一次运行为准。
- 本地实测不等于远端 CI 通过。远端结果以对应运行的 Summary 和 artifact 为准。

## 本地 TS7 官方结果文件对照

要在 GitHub Actions 重跑默认的 28 例官方结果文件门禁，手动运行 [`smoke`](../.github/workflows/smoke.yml)
并勾选 `force`；该档的报告产物是 `report-7.1.0-beta-official`。只想跑这一档、限制用例数或换适配器时，
在仓库根目录安装依赖，并检出 [`config/baselines.json`](../config/baselines.json) 中 `ts71-official` 固定提交的
测试集。下面的命令只取用例和对应的官方结果文件；后续两组命令均使用 `TS71_CASES`：

```sh
bun install --frozen-lockfile
TS71_CORPUS="$PWD/.cache/ts71-corpus"
TS71_REF=$(bun -e 'console.log(require("./config/baselines.json").corpora["ts71-official"].ref)')
mkdir -p "$TS71_CORPUS"
curl -fsSL "https://codeload.github.com/microsoft/TypeScript/tar.gz/$TS71_REF" |
  tar -xz -C "$TS71_CORPUS" --strip-components=1 \
    "TypeScript-$TS71_REF/tsc/testdata/tests/cases" \
    "TypeScript-$TS71_REF/tsc/testdata/baselines/reference"
TS71_CASES="$TS71_CORPUS/tsc/testdata/tests/cases"
```

```sh
# 只复现 smoke 的 TS7 官方结果文件门禁；读取已入库的回归记录，不写回
OUT=.cache/ts71-official/gate
bun src/run.ts --baseline 7.1.0-beta-official --corpus "$TS71_CASES" \
  --cases config/smoke-cases-ts71-official.json --expectation-source official-baseline \
  --mode official --option-strategy aligned --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc \
  --ratchet config/ratchet-ts71-official.tsv --gate --out "$OUT" --report-out "$OUT"

# 自选适配器和源用例数；仅出报告，不读写回归记录或启用门禁
ADAPTER=tsc-cli:node_modules/typescript-7-1/bin/tsc  # 可改为 tsc-cli:<二进制路径> 或其他已支持的适配器
LIMIT=5
OUT=.cache/ts71-official/preview
bun src/run.ts --baseline 7.1.0-beta-official --corpus "$TS71_CASES" \
  --cases config/smoke-cases-ts71-official.json --expectation-source official-baseline \
  --mode official --option-strategy aligned --adapter "$ADAPTER" \
  --limit "$LIMIT" --out "$OUT" --report-out "$OUT"
```

`--limit` 截取展开前的源用例（`meta.selectedCases`），不是展开后的配置数（`totals.cases`）。
要用自选适配器预览全部 28 例，去掉 `--limit` 即可。已登记实现也可用后面的手动第三方任务，按实现读取独立回归记录。
查看 `report.md`／`report.html` 和 `details.json`；运行提前失败时，可按上文的报告命令补生成失败占位报告。

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

## 本地固定版本双来源对照

[`scripts/validate-compatibility.ts`](../scripts/validate-compatibility.ts) 在同一份
[固定 120 例列表](../config/official-baseline-cases-ts71.json)上，分别用现场生成的 tsc 诊断和官方
`.errors.txt` 作参考。先按[本地 TS7 官方结果文件对照](#本地-ts7-官方结果文件对照)安装依赖、获取固定测试集并设置
`TS71_CASES`。以下命令每次运行一个候选；使用有对应固定版本二进制的 Linux 或 macOS 环境：

```sh
OUT=.cache/compatibility
bun scripts/validate-compatibility.ts "$TS71_CASES" "$OUT/typescript" typescript

# Bun：改成 1.4.4 或 1.4.5，分别运行
V=1.4.4
BIN=$(bun scripts/install-impl.ts --name "bun-check-$V" --source release --dest .cache/checkers) &&
  bun scripts/validate-compatibility.ts "$TS71_CASES" "$OUT/bun-$V" "bun-$V" "$BIN"

# tsrs：安装器最后一行是二进制路径
TSRS=$(bun scripts/install-impl.ts --name tsrs --source npm --dest .cache/checkers | tail -n 1)
test -x "$TSRS" && bun scripts/validate-compatibility.ts "$TS71_CASES" "$OUT/tsrs" tsrs "$TSRS"
```

每个候选在 `tsc/` 和 `official-baseline/` 分别写出 `report.md`、`report.html`、`metrics.json`
和 `details.json`。诊断差异不作为门禁，但两次运行都必须完成清单中的全部比较：版本不符、选项不支持、
跳过或执行失败都不会被当作成功。120 例都显式指定 `target`，不能据此推断 Bun 对默认 `target=es2026`
或声明生成配置的支持。平台会影响二进制指纹和耗时；历史实测及其条件见 [RESULTS.md](RESULTS.md)。

要生成可发布的固定样本报告，使用[公开评测](#公开评测与报告目录public-evaluationyml)的 `fixed-120`；
它只对照官方结果文件。已发布结果见 [公开报告目录](https://johnhax.net/tsc-compa/)。

## TS7 全量类型检查对照（`full-compatibility.yml`）

这项评估与 `smoke.yml` 的 PR 门禁分开。合入后可从 Actions 手动运行；改变该工作流、分片脚本或其测试的 PR 也会触发默认评估。默认使用固定提交的官方 `.errors.txt`，因为参考结果不用逐案重新生成；需要独立检查官方测试框架与现场 CLI 的差异时，手动选择 `reference=tsc`。全量对照不是速度基准。

计划任务清点 `compiler/` 和 `conformance/` 下的 `.ts`、`.tsx`、`.mts`、`.cts` 源文件。转译、IDE 和辅助文件不算作检查用例。默认每个候选 8 片，4 个候选共 32 个任务，最多同时跑 8 个。按源文件分片：同一源文件的配置不拆开；按配置数、测试源大小和估计的进程启动开销平衡负载。工作流使用固定的语料提交，只检出所需子目录，并优先直接调用原生 tsc，避免每案再启动 npm 的 JavaScript 启动器。

- `compatibility-shard-plan`：按候选共享的源文件及配置清单。
- `full-<候选>-<分片>`：该片的 `cases.json`、`metrics.json`、`details.json`。
- `full-summary`：汇总 Markdown 和 JSON，列出每个候选的完成、跳过、两档结果、诊断命中与异常。覆盖率按所有分片的命中数除以期望数，不平均各片百分比。

汇总按计划逐片核对源文件和配置记录；缺片、重计、候选二进制不一致、崩溃或超时都会标为不完整，任务失败。可采集的不兼容结果照常报告，不是工作流故障。当前不支持的配置仍按原因跳过，不能计入兼容通过。若重跑失败的任务，成功分片的产物可继续用于汇总。

## TS6 / TS7 版本差异探针（`version-probes.yml`）

`bun run probes:versions` 在同一源码、相同显式选项下，断言官方 TypeScript
`6.0.3` 和 `7.1.0-beta` 各自的逐例行为。独立 CI 任务在 PR、`main` push 和手动运行时校准
这两个锚点，不改 28 例冒烟集合或 `compat-gate`。报告保存为 `ts-version-probes-official` artifact。

探针源码和来源见 [`config/version-probes`](../config/version-probes)：从两个固定官方测试集的
诊断差异里找样本，再用固定编译器在同一配置下实测。样本分别覆盖递归 mixin 不再报错、
泛型回调的解构新增隐式 `any`，以及两版均报错但诊断码、位置或条数变化。样本不读取外部
fixture；显式选择 ES2022 标准库、目标和模块选项，用空类型根隔离环境声明。

已有候选二进制时，可用 `config/implementations.json` 的登记名走同一套探针：

```sh
bun install --frozen-lockfile
BIN=$(bun scripts/install-impl.ts --name tsrs --dest .cache/tools --source npm)
bun run probes:versions --candidate tsrs --bin "$BIN"
```

`--bin` 也可以直接指向已有的固定版本二进制。一次运行一项候选，复用其登记的 adapter；
默认把 `report.json` 和 `report.md` 写到 `.cache/version-probes/<候选名>`，也可用 `--out`。
报告记录源码指纹、选项、工具身份、期望与实测。按用例内文件、UTF-16 行列（从 1 开始）、
严重度、诊断码比较诊断多重集，保留重复诊断，不比较顺序或措辞，也不合并等价码。
`ts6` / `ts7` 指完整指纹吻合一侧；`neither` 是实际完成、与两侧均不同，正常的空诊断也参与比较。
`unsupported` 是配置或诊断不可比较，`execution-error` 是执行或采集失败，均保留原因和已有的原始输出，
不当作空诊断。没有校准成功的探针不会给候选贴版本标签。只有官方断言失败会令命令非零退出；
候选结果供诊断，不进入兼容性门禁，也不拿几例探针推断候选的整体版本或兼容性。

## 公开评测与报告目录（`public-evaluation.yml`）

公开候选与固定版本见[候选检查器一览](CHECKERS.md)。`typescript`、`bun-1.4.4`、
`bun-1.4.5` 和 `tsrs` 可以选 `fixed-120`（120 个固定诊断样本）。六个固定候选均可选 `full`
或 `curated-difference-v1`；`ts-rust` 和 `tsz` 不支持 `fixed-120`。`full` 覆盖 `compiler/` 与 `conformance/`
下的 TS 源用例，按配置展开后分 8 片。所有组合都对照固定提交的 TS 7.1.0-beta 官方
`.errors.txt`。Bun 走 `bun-check`，其余走 `tsc-cli`；不用填写二进制地址或 adapter。

有仓库写权限的维护者在 **Actions → public-evaluation → Run workflow** 选默认分支、候选和测试集；
也可以用 CLI（下面以本仓 `main` 为例）：

```sh
gh workflow run public-evaluation.yml -R hax/tsc-compa --ref main \
  -f candidate=typescript -f suite=fixed-120
```

默认不勾选 `force`（`false`）：命中完全相同的已完成报告时，跳过用例和写入。
要重新执行这些用例，勾选 `force`，或运行：

```sh
gh workflow run public-evaluation.yml -R hax/tsc-compa --ref main \
  -f candidate=typescript -f suite=fixed-120 -f force=true
```

选非默认分支时，只有勾选 `preview` 才允许运行；预演产物留在本次 Actions，永远不写公开报告分支。
要在预演中重跑用例，可同时传 `-f preview=true -f force=true`。运行摘要会说明是命中后跳过、
未命中后执行，还是启用 `force` 后执行。
公开评测 workflow 须先存在于默认分支，才能从 GitHub 手动派发。修改评测 workflow 或相关脚本、测试的 PR
会自动用 `typescript` / `fixed-120` 做只读验证，不读写公开数据分支。

`plan` 用固定版本与可执行文件指纹、语料提交、用例清单／分片计划、参考来源、执行器代码、
平台、关键选项和结果计数规则计算请求 ID。规划与执行都校验检出的语料和官方基线字节；请求还绑定各分片的输入摘要及
TS7／tsrs 的原生发行包（包含声明库）指纹。无论是否勾选 `force`，都核对输入和二进制身份；
`force` 不参与请求 ID 计算。只有目录有效，且同一 ID 的索引、HTML 和精简 JSON 都一致，默认才会跳过用例。
执行器或 workflow 代码变更后，旧结果不再命中新指纹；已有报告仍可浏览，不需要迁移。

只有分片和配置记录全部核对，且没有参考侧、启动或基础设施故障，才保存公开报告。默认分支的非预演强制重跑通过核对后，
沿用同一请求 ID 和报告地址，在一个 Git 提交中更新精简 JSON、HTML 和索引。旧版本保留在 Git 历史中，
不同请求的报告不变。执行器和候选扩展可能为后续运行生成新的请求 ID，既有报告的 ID 和链接不变。
`src/` 下的 Markdown 和 README 不进入执行器指纹。以后换候选固定版本或参数时，在
`scripts/public-evaluation-policy.ts` 追加一代策略，不覆盖历史候选与来源。用现有数据分支验证历史报告仍可暂存和发布，再调整目录。
并行写入时，`persist` 拉取最新分支再重试；对同一请求先比较 workflow 运行编号，
同一编号再比较尝试次数，较早发起的运行不会因完成得晚而覆盖较新的已保存结果。普通运行仍不替换已有结果。
逐案候选进程崩溃或超时且证据齐全时，该配置计为失败，其他配置照常运行。报告分别列出
普通诊断不匹配、崩溃、超时和跳过；兼容与严格一致的失败总数都包含崩溃和超时。诊断命中率只按
实际比较的配置计算。全部配置都是已核实的候选执行失败时仍出报告；只有跳过时不出报告。
缺分片、参考侧执行失败、无法启动候选、进程结果无法确认或证据与计数不一致时，不新增或刷新公开报告。
公开报告列出失败配置的 ID 和简化的进程状态；含 stdout、stderr 等信息的原始明细仅保留在本次 Actions 产物。

### 精选差异样本 v1：单候选重跑与六方对照

在评测选择器或 `public-evaluation.yml` 中选择 `curated-difference-v1`，即可查看单候选报告或派发运行。
本测试集固定使用 TypeScript 提交 `3e9236361fa97a9e6c685f4833ac457ae2d8c50a` 的官方 `.errors.txt`，
只跑 [#27 标记的 33 个「源文件 + 配置」](../config/curated-difference-v1/README.md)；不会执行同源的其他配置。
请求 ID 还绑定这份规范列表的 SHA-256，与 `fixed-120` 和 `full` 分开。旧报告和旧请求仍可核验；执行器变更后的新请求按原有指纹规则判断是否能复用。

```sh
# 具有仓库写权限的维护者可派发；预演只产出 Actions 报告。
gh workflow run public-evaluation.yml -R hax/tsc-compa --ref main \
  -f candidate=typescript -f suite=curated-difference-v1 -f preview=true

# 本地重跑：先安装依赖，并按上文设置指向固定测试集的 TS71_CASES。
OUT=.cache/curated-v1-local
mkdir -p "$OUT"
bun scripts/public-evaluation-curated.ts > "$OUT/targets.json"
TSC_COMPA_ADAPTER_ARGS='' bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus "$TS71_CASES" --case-targets "$OUT/targets.json" \
  --expectation-source official-baseline --option-strategy aligned \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc --out "$OUT" --report-out "$OUT"
```

单候选报告区分通过、差异、未确认和跳过；这组刻意选出的用例不能用来估计总体兼容率或排名。
五个官方 TS6／TS7 校准探针不计入这 33 条，可用 `bun run probes:versions` 单独重跑。
首页的六方对照页仍是固定全量运行的只读摘录（含两份只读预演）；派发单候选不会更新它。
要本地暂存六方页面，可运行 `bun scripts/curated-comparison.ts .cache/curated-web`，输出在
`reports/curated-difference-v1/index.html` 和 `comparison.json`；不会写公开数据分支或部署。

### 新增候选：全量评测顺序

1. `ts-rust`（pingdotgg）：npm `tsc-rs@0.8.0`，校验启动器包和 Linux x64 平台包的 SHA-256 与 npm SHA-512 完整性值，
   用包自己的路径解析器确认原生 CLI，保留平台包和声明库的目录结构。自报 `7.1.0-dev` 不是 npm 版本。
2. `tsz`：正式发行 `v0.1.75`（`0c0e53f`），校验发布的 `SHA256SUMS` 与 Linux x64 GNU 归档。
   只提取 `tsz` CLI（不运行同包的 LSP），强制使用二进制内置的声明库。

以上按顺序选择 `full`。合并前可在分支上用 `preview=true` 验证；合并后由有权限的维护者在
默认分支按同一顺序执行非预演，检查分片和报告后，再手动部署 Pages。预演不写公开数据。
两项都只在只读 Ubuntu 24.04 规划任务准备一次发行目录。分片只下载同一份产物，不向上游重新获取发行包。
每个分片核对候选可执行文件、发行目录、宿主动态库和固定的 CLI 参数；不一致时任务失败，不会产生可发布报告。
发行来源和 CLI 自报版本分别记录。公开发行固定策略与冒烟版本独立维护。

`tsc-rs`（kazhiramatsu）不是公开选项：其正式发行的[全量预演未完成](RESULTS.md#tsc-rs-v010-全量预演未完成)。
登记的源码快照仍用于适配器冒烟，不替代公开发行。

### 首次发布与更新

1. 在默认分支非预演运行一次 `typescript` / `fixed-120`。评测通过后，`persist` job
   用仓库 `GITHUB_TOKEN` 初始化或快进更新 `public-report-data`。不用手工创建空分支，
   也不用把仓库的默认 token 权限调为可写；组织策略若阻止该 job 推送，先检查策略。
   写入冲突时会以最新分支为基础重试，不使用强推。数据分支只保存 `reports/` 下的公开目录、
   结果索引、HTML 和精简 JSON；目录列出已支持的组合，索引只列出完成的结果。
2. 管理员在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
   发布 workflow 不会替维护者启用 Pages；不把 `public-report-data` 设为「Deploy from a branch」。
   在 `github-pages` 部署环境的分支策略中只允许默认分支（本仓为 `main`），不需要为此改动 PR 分支保护策略。
3. 在默认分支手动运行 **Publish public reports to Pages**（`publish-public-reports.yml`）。
   它将默认分支的站点与数据分支的 `reports/` 一起部署，站点地址见部署结果。
   新增或刷新报告后需再运行该发布任务，评测不会自动部署。

### 验收

- 在独立测试仓库，选择包含 workflow 的非默认分支：不勾 `preview` 应在规划前退出；
  同时勾选 `preview` 和 `force` 后，用 `typescript` / `fixed-120` 应只生成 Actions 产物，
  不改变 `public-report-data`。
- 默认分支首次运行 `typescript` / `fixed-120`：检查只有 1 个执行任务，`persist` 写入 1 条索引，
  `catalog.json` 有 10 个组合。在相同输入条件下勾选 `force` 再派发：检查用例确实重跑，
  同一 ID 的索引和报告指向新运行，没有新增同 ID 的索引。最后不勾选 `force` 再派发，
  检查 `plan` 命中、不启动执行分片，数据分支不变。
- 再用 `full`：检查只跑所选候选、总共 8 片。缺片、参考侧或基础设施故障时，检查无新增索引；
  齐全时检查计划、已比较、跳过和候选执行失败的计数，以及仅基于已比较配置的诊断命中数。
- 部署后，在 Pages 选择已运行与未运行的组合，分别看到报告入口和「未运行」。

自有检查器建议在本地或自己的仓库用 `bun src/run.ts` 生成报告，不需要运行公开评测 workflow。
检查器按协议选择 adapter：兼容 `tsc` 命令行的二进制可以用 `tsc-cli:<bin>`，
实现批量协议的可以用 `checker-batch`。自行托管结果时，只发布你确定可公开的文件。
本仓受控的 `native-suite` Release 入口仍独立运行，不接入公开评测、报告索引或 Pages。
