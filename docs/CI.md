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
