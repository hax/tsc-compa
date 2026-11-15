# 接收检查器二进制并跑兼容性套件（native-suite）

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

2. `workflow_dispatch`（手动回退）：填 `release_tag` + `asset_name` 从本仓 release 下载；或给 `binary_url` 直接下载任意实现的二进制。可指定 `baseline` / `mode` / `limit`。

## 做什么

1. 按 `baseline` 从 `config/baselines.json` 解析对应语料 tag，checkout 官方语料到 `reference/corpus`；
2. 下载 release asset 并校验可执行；
3. 用 `checker-batch` 适配器跑该基线的冒烟集（`config/smoke-cases.json`，28 例）；
4. 上传 `metrics-<impl>-<baseline>` artifact，并在 job summary 里贴 fp / miss / coverage / skip / verdictEligible 摘要。

## CI 兼容性门禁（`smoke.yml`）

`smoke.yml` 在每次 push / PR 上跑「单元测试 + 门禁式冒烟」（每次提交都要有兼容性结论）。
每日 cron（`23 19 * * *`，UTC 19:23 / 北京时间 03:23，避开整点）是**变化驱动**的：
先只跑 `detect` job（约半分钟），输入没变就输出「no changes, skip」并结束、不跑套件；
有变化才跑下面的矩阵。冒烟矩阵五档：

| 档位 | 基线 | 语料 | 期望源 | 门禁口径 |
| --- | --- | --- | --- | --- |
| 自比 | 5.9.3 / 6.0.3 / 7.1.0-beta | 各自语料 tag | 现场 tsc | `--gate` 零差异自检：假阳性、漏报、错锚都为 0 |
| TS7 官方基线 | 7.1.0-beta-official（28 例） | TS7 Go 布局（pin 取自 `config/baselines.json`） | 官方 `.errors.txt` | ratchet 清单 `config/ratchet-ts71-official.tsv`，按用例 T0–T2 只升不降 |
| 6.0 官方基线子集 | 6.0.3（191 例） | strada（pin 取自 `config/baselines.json`） | 官方 `.errors.txt` | `--gate-max-fp 12 --gate-max-miss 4 --gate-min-coverage 0.99`，容忍 npm 补丁与仓库快照的已知偏差（2 例假阳性共 12 条、4 条漏报，见 docs/RESULTS.md 结论 6） |

`--gate` 的检查项（任一失败即非零退出，逐项结论同时写进 stdout 与
`metrics.meta.gate`）：

1. **口径**：本次运行必须是兼容性结论（`--mode official` 且适配器接受外部选项）；
   `--mode fixed` 或 `checker-batch` 这类实现忽略指令的运行会被门禁拒绝；
2. **执行**：至少跑完一个用例（全 skip / 空 manifest 不算绿）；
3. **ratchet**：配置了清单（`--ratchet` / `--ratchet-impl`）时任何用例的 **T0–T2 门禁档位**
   回落即失败（T3 full 是报告档，读入/写回时归一为 `text`，不参与门禁）。
   门禁模式要求清单已入库且非空：不会自动初始化、拒绝空清单（避免 CI 里凭空生成一份
   全绿清单），也不写回改善（CI 检出上的写回不持久，改善由本地跑完后提交）；
4. **阈值**：`--gate-max-fp` / `--gate-max-miss` / `--gate-max-misanchor` /
   `--gate-min-coverage`。没有 ratchet 时前三个默认 0；配了 ratchet 时默认不设
   条数上限（逐例严格性由清单承载），显式参数仍可叠加。阈值参数必须配合 `--gate`
   使用，单独给出会直接报错。

**门禁档位**：只有 T0 location / T1 category / T2 text 进门禁，经 ratchet 清单按用例兜底；
ratchet 文件里只记这三档（旧的 full 条目读入时归一为 text）。**T3 full（整份
`.errors.txt` 摘要块字节相等）仍是报告档**——未达只进 `totals.byTier` /
`totals.t3Failures` / `samples.t3`，不判红。

### 每日 cron 的变化检测（`scripts/detect-changes.ts`）

detect 把当前状态与「上次套件全部通过后」记录的状态（`actions/cache` 里的
`state.json`）比较，任一变化即跑套件：

| 检测项 | 怎么查 | 可查性 |
| --- | --- | --- |
| 本地输入 | `config/**`（baselines / corpora / manifest / implementations / ratchet）+ `package.json` + `bun.lock` 的内容 SHA-256 | 总能查 |
| 仓库 HEAD | 当前 `github.sha` vs 上次成功后记录的 headSha | 总能查 |
| npm pin | package.json 的 npm alias 与 implementations.json 的 npm 版本，查 registry 精确版本的 `dist.integrity`（重发布/撤包会变） | 需网络；查不到记 unavailable、按未变化处理 |
| 语料 pin | `config/baselines.json` 的 `corpora.*.ref` 经 GitHub API 解析成 commit sha（tag 被移动会变） | 需网络 / GitHub API；查不到记 unavailable |
| 第三方实现 cargo git pin | `tsc-rs` / `tsz` 的 pin commit 是否仍存在；非 GitHub 地址列为「不可比对」 | 需网络 / GitHub API；查不到记 unavailable |
| 上游默认分支 HEAD | 只写进 summary 报告，不触发（pin 固定，被测输入没变） | 信息项 |

补充约定：

- 首次运行 / 缓存缺失视为有变化；只有套件**全部通过**后 record job 才更新状态，
  失败的输入下次会被重新判为有变化并重跑（不会把失败输入记成「已跑过」）；
- push / PR 不走变化判定（门禁每次都要结论）；`workflow_dispatch` 默认同样先检测，
  勾 `force` 输入可跳过检测强制跑；
- 缓存按分支隔离：push / 手动 dispatch 的套件全部通过后保存状态（pull_request 不保存）；
  每日 cron 在默认分支只读得到默认分支保存的状态。7 天未使用的 cache 会被 GitHub
  清理，清理后下一次视为首次运行（多跑一次，不影响正确性）。

本地模拟两种输入（改 config 文件即等价于「输入变化」）：

```bash
# 第一次：无状态 → run=true；再跑一次：run=false；改 config 后 → run=true
GITHUB_EVENT_NAME=schedule GITHUB_SHA=$(git rev-parse HEAD) bun scripts/detect-changes.ts --out .cache/smoke-detect
GITHUB_EVENT_NAME=schedule GITHUB_SHA=$(git rev-parse HEAD) bun scripts/detect-changes.ts --out .cache/smoke-detect

# 强制跑（等价于 workflow_dispatch 勾 force）；--offline 可跳过网络查询
GITHUB_EVENT_NAME=schedule GITHUB_SHA=$(git rev-parse HEAD) bun scripts/detect-changes.ts --out .cache/smoke-detect --force
```

要把门禁真正用于「阻断合并」，需在仓库设置里把稳定聚合 job **`compat-gate`** 设为
required status check（它汇总 `detect` / `unit` / `smoke` 的结果：无变化时套件 skipped
也算通过，套件失败或 detect 失败都会红；也可同时要求 `unit` / `smoke`。分支保护是
仓库设置，不在 workflow 文件里）。

本地复现：

```bash
# 自比 + 零差异门禁
bun src/run.ts --baseline 6.0.3 --corpus /path/to/strada/tests/cases \
  --adapter tsc-cli:node_modules/typescript-6-0/bin/tsc --gate

# TS7 官方基线 + ratchet 门禁
bun src/run.ts --baseline 7.1.0-beta-official \
  --corpus /path/to/typescript/tsc/testdata/tests/cases \
  --expectation-source official-baseline \
  --cases config/smoke-cases-ts71-official.json \
  --ratchet config/ratchet-ts71-official.tsv \
  --adapter tsc-cli:node_modules/typescript-7-1/bin/tsc --gate
```

## 适配器

`src/adapters/checker-cli.ts` 把检查器二进制的 `--json` 输出（字段 `file/start/end/line/col/end_line/end_col/severity/code/message`，1-based 行列）映射为套件协议：

- 跳过 `code === 0`（实现自己的 early error，不对应 tsc 错误码）与非数字码；
- 路径按用例临时目录前缀裁剪成相对路径；
- 行列转 0-based，宽度取 `end - start`；
- 超时（30s）记为 skip，异常退出/非 JSON 输出记为 crash，不静默通过。

适配器不支持外部编译选项（`supportsOptions=false`），因此默认用 `--mode fixed`（固定 strict+esnext 口径）跑；`official` 模式会打印警告并标 `verdictEligible=false`。

## 当前限制

- 只跑冒烟集（28 例）；全量 12k 用例走批量协议（`checker-batch`，见 `src/adapters/batch.ts`），复用本 workflow。
- 门禁目前只接 `smoke.yml`（自比 + 官方基线子集）：`native-suite.yml` / `third-party.yml` 仍是手动触发、跑成功即记录指标；third-party 的官方基线档配了 ratchet（回落会非零退出），但没有叠加 `--gate` 的条数/覆盖率阈值。
- 每日 cron 的变化检测只覆盖上表列出的输入：范围版本、非 GitHub 获取源、无网络/API 限流时按「未变化」处理；上游发了新版本但 pin 未改不会触发重跑（需要人工改 pin，走推送门禁）。无变化时当天不产出新的兼容性指标，历史指标以最近一次运行为准。
- 目前只接 linux-x64；其它平台在实现侧加构建矩阵即可，本 workflow 不区分平台。

## TS7 官方基线冒烟（`ts7-official.yml`）

与上面「接收二进制」的流程独立，手动触发，直接消费 TS7 官方仓库的 errors 基线：

- 语料 pin：`config/baselines.json` 的 `ts71-official` corpus（当前 `aa814927`；pin 对齐
  #7 后自动跟随，workflow 现场解析 ref）。Go 布局：cases 在 `tsc/testdata/tests/cases`，
  基线在 `tsc/testdata/baselines/reference`；
- 期望源：`--expectation-source official-baseline`（缺基线 = 该用例无期望错误）；
- 分档：`metrics.totals.byTier` 给 T0 location / T1 category / T2 text / T3 full
  的用例分布，`totals.messageMismatch` 给「位置命中但首行文案不同」的诊断条数；
- 门禁：`--ratchet-impl <impl>`（路径 `config/ratchet/<impl>-<baseline>.tsv`，首次自动初始化），回落即失败、改善写回
  （CI 里清单已入库，正常不应产生写回；若 artifact 显示有改善，维护者审阅后提交）；workflow 里用显式
  `--ratchet config/ratchet-ts71-official.tsv` + `--gate`（与 `smoke.yml` 的 28 例档同口径；
  ratchet 只记 T0–T2，T3 不判红）。
- **尚未在 GitHub Actions 上实际跑过**：先手动 dispatch 跑绿一次，再决定是否给它单独挂 cron；
  在那之前，`smoke.yml` 的每日变化检测在判「有变化」时会覆盖同一组 28 例官方基线冒烟。

## 第三方实现冒烟（`third-party.yml`）

手动触发，输入「实现名（config/implementations.json）× 基线 id（7.1.0-beta-official / 7.1.0-beta）」：

- 语料按基线从 `config/baselines.json` 的 corpus ref 现场 checkout（官方基线用 TS7 Go 布局，普通 7.1 用 strada）；
- 实现按 registry 的获取方式安装：`localEnv` 优先（本地调试），其次 npm 预编译（如 `tsrs`、`ts-rust`），最后 cargo 构建（`tsc-rs`、`tsz` 等无 npm 包的实现）；`scripts/install-impl.ts` 打印二进制路径；
- **cargo 路径（CI）**：workflow 按 `acquisition.cargo.git` 是否存在按需安装 Rust 1.99.1，并按登记的 git pin **浅拉取**源码到 `.tools/src/<impl>-<sha7>`，用外部 `CARGO_TARGET_DIR=.tools/target/<impl>` 构建，不写入仓库检出。`tsz` 额外通过 `cargo.env` 强制 `CI=1`（其仓库默认把 target 写进检出并改 `.git/config`）。cargo registry/git 与 `.tools/target` 走 actions/cache，job 超时 20 分钟、获取/构建步骤 15 分钟；
- 新增实现时：在 `config/implementations.json` 登记 `cargo.git.url/ref`（本地开发仍可直接用 `reference/<repo>` 检出）、构建命令、产物相对 `target/` 的路径与必要的 `env`；无需改 workflow 或 adapter；
- 自动带 registry 里的固定 CLI 参数（如 `tsrs` 的 `--singleThreaded`），用 `tsc-cli` 适配器驱动；
- 官方基线跑 `--ratchet-impl <impl>`（按实现分账；首次接入的清单只登记当前档位，不判红），metrics 作为 artifact 上传。

原则：不为第三方实现写内部 adapter、不改其源码；获取方式/相位字段/并行开关的差异登记在
`config/implementations.json` 与 `docs/RESULTS.md`。
