# 在 CI 中评估受信任的原生检查器

`native-suite` 在 GitHub 托管 runner 上运行由本仓维护者授权、发布到本仓 Release 的
检查器。检查器的源码仓库可以是私有的，但**授权执行不等于保密**：本仓已经发布的
Release asset 可公开下载；Actions 日志、步骤摘要和报告 artifact 也不应视为私有。
报告可能包括原始诊断、版本输出和路径。发布前请确认二进制、标签、实现名、源码 SHA 和
可预见的输出均可公开；不要发送私有仓库地址、账户标识、凭据或签名 URL。
需要保密的二进制和结果应留在调用方自己的私有 CI，用本项目的 CLI 本地运行，见文末。

## 发布并触发

先把一个独立可执行的 Linux x64 检查器作为 asset 上传到 **`hax/tsc-compa`**
已发布的 Release（不是草稿）。然后由已获本仓授权的调用方发送
`repository_dispatch`，`event_type` 为 `checker-binary`。原有 `client_payload` 可继续使用：

```json
{
  "implementation": "checker",
  "source_sha": "0123456789abcdef0123456789abcdef01234567",
  "release_tag": "binary-checker-0123456-linux-x64",
  "asset_name": "checker-0123456-linux-x64",
  "platform": "linux-x64",
  "baseline": "7.1.0-beta"
}
```

- 标签与文件名必须准确匹配，区分大小写。两者以 ASCII 字母或数字开头，
  后续只接受字母、数字、`.`、`_`、`-`，不接受路径或通配符。
  `implementation` 同样遵守此规则，只用作公开显示名，不决定可执行文件路径。
- `source_sha` 是调用方提供的源码提交标识（7–40 位或 64 位十六进制，可省略），
  不是二进制与源码对应关系的证明。
  如需校验调用方预先计算的二进制摘要，新增 `sha256` 字段，填写 64 位十六进制值。
  有该字段就必须匹配；GitHub 返回 `sha256:` asset 摘要时也必须匹配。
  两者都没有时，仍计算并记录实际 SHA-256，并在执行前验证下载一致性；这不等同于
  根据调用方的独立摘要验证发布物，也不验证签名。
- 自动任务固定使用 `checker-batch`、`mode=fixed`、`limit=0`，默认参考配置仍为
  `7.1.0-beta`，也接受 `6.0.3`、`5.9.3`。`limit=0` 表示运行该参考配置的**默认冒烟集**
  全部源用例，不是完整 TypeScript 测试集。

维护者也可在默认分支通过 Actions 手动触发，填写 `release_tag` 和 `asset_name`，
并可提供 `source_sha`、`sha256`，或选择参考配置、`mode` 和 `limit`。
手动 `mode=official` 保留，但 `checker-batch` 不支持按用例切换编译选项，
两种模式的 `meta.verdictEligible` 都为 `false`；任务不启用兼容性门禁。
旧的手动 `binary_url` 入口不再提供：只检查 HTTPS 无法限定下载来源，也无法保证重定向满足本仓的信任边界。

## 下载、执行与结果

下载任务只用本仓自带的只读 `GITHUB_TOKEN` 查公开 Release 元数据，按名称精确选择已上传的
asset，再通过 GitHub API 按该 asset 的 ID 无凭据下载并计算摘要；不执行下载内容，也不会将
二进制写入 Actions cache 或上传为 artifact。执行任务在另一台 runner 上，不授予仓库权限，
按同一 ID 重新下载并验证长度和 SHA-256，通过后才赋予执行权限。同名替换不会改用新 asset；
原 ID 无法下载时任务失败。如果 API 返回 JSON 而不是文件内容，也不会回退到按名称下载。
检查器不继承下载凭据或 runner 命令文件的环境变量。
这不是沙箱，也不验证供应链可信度；只能使用维护者信任并允许公开发布的二进制。
这里的无凭据下载仅用于读取已选定的公开 asset，不会新增可供匿名用户发起执行的入口。

结果保留在本次 Actions 的 `metrics-<implementation>-<baseline>` artifact，
**不会自动发布到 GitHub Pages**：

| 文件 | 内容 |
| --- | --- |
| `metrics.json` / `details.json` | 汇总指标与逐案结果；`meta.selectedCases` 是所选源用例数 |
| `report.md` / `report.html` | `src/run.ts` 从同一次运行生成的报告，HTML 可离线打开 |
| `provenance.json` | 调用方声明的 `sourceSha`、Release 的 `assetId`、实际 `binarySha256` 及摘要校验标记 |
| `run-status.json` | 运行器状态，以及需要时的补生成报告状态 |

测试集目录缺失或运行器异常退出时，尝试补生成 Markdown 和 HTML 报告，任务仍失败。
日志和 `run-status.json` 分开记录运行器与补生成的状态，只包含固定状态和退出码；
不会将原始子进程输出转写到日志。
逐案崩溃或超时计入 `metrics.meta.executionFailures`，不作为门禁；请同时检查该字段和完成用例数。
如果输入校验或下载失败，检查器不会启动，也不会生成测试结果。

## 在私有 CI 中运行

在调用方私有 runner 上检出本项目、安装锁定依赖并准备参考配置对应的
[测试集版本](../config/baselines.json)。固定批量协议用 `CHECKER_BATCH_BIN` 和
`--adapter checker-batch --mode fixed`。对能接收 `tsc` 命令行选项的实现，
可直接选择 `tsc-cli:<本地可执行文件路径>`，例如：

```sh
bun install --frozen-lockfile
bun src/run.ts \
  --baseline 7.1.0-beta \
  --corpus /path/to/strada/tests/cases \
  --adapter tsc-cli:/path/to/checker \
  --mode official --option-strategy aligned \
  --out out --report-out out
```

原生工作流本次只接标准报告，不新增 `tsc-cli` 或 TS7 官方结果入口。
若要在私有 CI 使用 TS7 官方结果，改用 `7.1.0-beta-official` 及对应 pin 下的
`tsc/testdata/tests/cases`，加上 `--expectation-source official-baseline`；
参数与比较口径见 [REFERENCE.md](REFERENCE.md)。报告留存和访问控制由调用方的私有 CI 管理。
