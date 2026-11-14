# CI：接收远程二进制并跑兼容性套件

本仓是**实现无关**的 TSC 兼容性测试套件。二进制由外部（私有仓或其他来源）构建，通过 Release Asset 或 URL 送进来；本仓只负责下载、运行、出指标。仓库公开，标准 runner 免费，不需要任何私有凭据。

## 两种触发方式

### 1) `repository_dispatch`（由私有仓发起）

私有仓（如 `hax/maat`）构建二进制后：

1. 把二进制上传为本仓的 Release Asset，tag 形如 `binary-<impl>-<sha>-<platform>`；
2. 发送 `repository_dispatch`，`event_type = run-compat-suite`，payload：

```json
{
  "implementation": "maat",
  "source_sha": "9962a4f",
  "release_tag": "binary-maat-9962a4f-linux-x64",
  "asset_name": "maat-9962a4f-linux-x64",
  "baseline": "7.1.0-beta",
  "mode": "official"
}
```

本仓用 workflow 自带的 `GITHUB_TOKEN` 下载自己的 release asset（无需额外 secret）。

### 2) `workflow_dispatch`（手动，面向任意实现）

Actions → **remote-suite** → Run workflow：

| 输入 | 说明 |
| --- | --- |
| `implementation` | 实现名（报告用） |
| `release_tag` + `asset_name` | 从本仓 release 下载；或 |
| `binary_url` | 直接给二进制下载 URL（外部 TSC 兼容实现用，优先于 release） |
| `adapter_kind` | `cli`（实现输出 maat 形状 JSON，默认参数 `--json`）或 `tsc-cli`（tsc 兼容 CLI，输出 `file(line,col): error TSxxxx:` 文本） |
| `cli_args` | `cli` 适配器的固定参数（默认 `--json`） |
| `baseline` | `7.1.0-beta` / `6.0.3` / `5.9.3`（决定期望 tsc 与语料 tag，见 `config/baselines.json`） |
| `mode` | `official`（尊重 case 指令）/ `fixed`（实现忽略指令时用固定口径） |
| `limit` | 只跑前 N 例；0 = 该基线的冒烟集全部 |

## 二进制协议

- `adapter_kind=cli`：实现按 argv 接收文件路径，stdout 输出诊断 JSON 数组，字段同 maat `--json`：`{file,start,end,line,col,end_line,end_col,severity,code,message}`（1-based 行列，退出码 0/1 均可）。
- `adapter_kind=tsc-cli`：实现输出标准 tsc 诊断文本（`--pretty false` 风格）。
- 复杂实现可以在本仓加 adapter（`src/adapters/`）后，把 workflow 的 `adapter_kind` 扩展一项即可。

## 产物

- `metrics-<impl>-<baseline>` artifact（保留 30 天）：`out/metrics.json` + `out/details.json`；
- job summary 里直接贴出 fp / miss / coverage / skip / verdictEligible / byClass 摘要。

## 当前限制与后续

- v0 没有门禁：运行成功即绿，指标只做记录与对比；接基线门禁（`--gate`）之后才会让回归失败。
- 默认跑各基线的**冒烟集**（28 例）。全量 12k 用例在 `cli` 适配器的逐案进程模式下过慢，等实现侧批量协议（maat 的 issue #8）落地后，增加 `batch` adapter 与全量档。
- 实现若不接受外部编译选项（如 maat 当前形态），`official` 模式会打印警告并标 `verdictEligible=false`——这类结果只能证明链路与协议，不能作为兼容性结论。
- 外部实现用 `binary_url` 时请确认来源可信：workflow 会直接执行下载的二进制（仓库为公开仓库，workflow 只在维护者触发/maintainers 触发的 dispatch 下运行）。
