# 公开仓：接收 maat 原生二进制并跑兼容性套件

maat 私有仓的 `release-native` workflow 构建二进制后，会把它作为本仓的 Release Asset 上传，并发送 `repository_dispatch`（`event_type = maat-binary`）触发本 workflow。本仓用自带的 `GITHUB_TOKEN` 下载自己的 release asset，不需要任何私有凭据。

## 触发

1. `repository_dispatch`（自动）：payload 形如

```json
{
  "implementation": "maat",
  "source_sha": "9962a4f",
  "release_tag": "binary-maat-9962a4f-linux-x64",
  "asset_name": "maat-9962a4f-linux-x64",
  "platform": "linux-x64",
  "baseline": "7.1.0-beta"
}
```

2. `workflow_dispatch`（手动回退）：填 `release_tag` + `asset_name` 从本仓 release 下载；或给 `binary_url` 直接下载任意实现的二进制。可指定 `baseline` / `mode` / `limit`。

## 做什么

1. 按 `baseline` 从 `config/baselines.json` 解析对应语料 tag，checkout 官方语料到 `reference/corpus`；
2. 下载 release asset 并校验可执行；
3. 用 `maat:<bin>` 适配器跑该基线的冒烟集（`config/smoke-cases.json`，28 例）；
4. 上传 `metrics-<impl>-<baseline>` artifact，并在 job summary 里贴 fp / miss / coverage / skip / verdictEligible 摘要。

## 适配器

`src/adapters/maat.ts` 把 maat 二进制的 `--json` 输出（字段 `file/start/end/line/col/end_line/end_col/severity/code/message`，1-based 行列）映射为套件协议：

- 跳过 `code === 0`（yuku early error，不对应 tsc 码）与非数字码；
- 路径按用例临时目录前缀裁剪成相对路径；
- 行列转 0-based，宽度取 `end - start`；
- 超时（30s）记为 skip，异常退出/非 JSON 输出记为 crash，不静默通过。

适配器不支持外部编译选项（`supportsOptions=false`），因此默认用 `--mode fixed`（固定 strict+esnext 口径）跑；`official` 模式会打印警告并标 `verdictEligible=false`。

## 当前限制

- 只跑冒烟集（28 例）；全量 12k 用例需要批量协议（maat issue #8），届时在 `src/adapters/` 加 batch shim 后复用本 workflow。
- v0 无门禁：运行成功即绿，指标只做记录与对比。
- 目前只接 linux-x64；其它平台在 maat 侧加构建矩阵即可，本 workflow 不区分平台。

## TS7 官方基线冒烟（`ts7-official.yml`）

与上面「接收二进制」的流程独立，手动触发，直接消费 TS7 官方仓库的 errors 基线：

- 语料 pin：`microsoft/TypeScript@aa814927`（Go 布局；cases 在
  `tsc/testdata/tests/cases`，基线在 `tsc/testdata/baselines/reference`）；
- 期望源：`--expectation-source official-baseline`（缺基线 = 该用例无期望错误）；
- 分档：`metrics.totals.byTier` 给 T0 location / T1 category / T2 text / T3 full
  的用例分布，`totals.messageMismatch` 给「位置命中但首行文案不同」的诊断条数；
- 门禁：`--ratchet config/ratchet-ts71-official.tsv`，回落即失败、改善写回
  （CI 里清单已入库，正常不应产生写回；若 artifact 显示有改善，维护者审阅后提交）。

## 第三方实现冒烟（`third-party.yml`）

手动触发，输入「实现名（config/implementations.json）× 基线 id（7.1.0-beta-official / 7.1.0-beta）」：

- 语料按基线从 `config/baselines.json` 的 corpus ref 现场 checkout（官方基线用 TS7 Go 布局，普通 7.1 用 strada）；
- 实现按 registry 的获取方式安装：`localEnv` 优先（本地调试），其次 npm 预编译（如 `tsrs`、`ts-rust`），最后 cargo 构建（`tsc-rs`、`tsz` 等无 npm 包的实现）；`scripts/install-impl.ts` 打印二进制路径；
- **cargo 路径（CI）**：workflow 按 `acquisition.cargo.git` 是否存在按需安装 Rust 1.99.1，并按登记的 git pin **浅拉取**源码到 `.tools/src/<impl>-<sha7>`，用外部 `CARGO_TARGET_DIR=.tools/target/<impl>` 构建，不写入仓库检出。`tsz` 额外通过 `cargo.env` 强制 `CI=1`（其仓库默认把 target 写进检出并改 `.git/config`）。cargo registry/git 与 `.tools/target` 走 actions/cache，job 超时 20 分钟、获取/构建步骤 15 分钟；
- 新增实现时：在 `config/implementations.json` 登记 `cargo.git.url/ref`（本地开发仍可直接用 `reference/<repo>` 检出）、构建命令、产物相对 `target/` 的路径与必要的 `env`；无需改 workflow 或 adapter；
- 自动带 registry 里的固定 CLI 参数（如 `tsrs` 的 `--singleThreaded`），用 `tsc-cli` 适配器驱动；
- 官方基线跑 `--ratchet config/ratchet-ts71-official.tsv`，metrics 作为 artifact 上传。

原则：不为第三方实现写内部 adapter、不改其源码；获取方式/相位字段/并行开关的差异登记在
`config/implementations.json` 与 `docs/RESULTS.md`。
