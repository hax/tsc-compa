# tsc-compa 设计（v0）

本文是当前 skeleton 的权威设计说明：协议、口径与指标定义。实现位置的
「TODO / 留给后续」都在最后一节列明。

## 1. 目标与范围

tsc-compa 是一个**与实现无关**的 TSC 兼容性测试套件：输入是任意 TSC 兼容
检查器（二进制、进程内 API 或批量进程），输出是「误报率 / 覆盖率 / SKIP 分类」
这组指标，目标是在官方 TypeScript 测试语料上证明「近乎 100% 兼容」。

不绑定的东西：实现语言（Zig / Rust / Go / TS 均可）、tsc 基线版本（5.9.x /
6.0.3 / 7.1.0-beta，规划中）、语料来源（官方 `tests/cases`，后续可对接官方基线）。

v0 只做两件事：把协议、口径、指标固化下来；用一个小规模 smoke 集跑通全链路。
v0 不做门禁、不跑全量、不接 CI。

## 2. 流水线

```
语料 tests/cases
   │  发现（discover.ts：scanCorpus / manifest）
   ▼
用例（case.ts：指令解析 → 虚拟文件 + 有效编译选项）
   │
   ├──► 期望（tsc.ts：固定版本 tsc CLI + 选项 → 诊断列表，按内容哈希缓存）
   │
   └──► 适配器（adapters/*：把实现包成 check(input) → diagnostics）
   ▼
匹配（compare.ts：文件+行+列+码）
   ▼
指标（metrics.json / details.json + stdout 摘要）
```

运行器是 `src/run.ts`。用例集由 manifest 给出（`config/smoke-cases.json`），
manifest 用 `scripts/select-smoke.ts` 生成并可复现。

## 3. 用例语义

### 3.1 指令

官方用例的编译选项由行内指令声明（`// @strict: true`、`// @target: es2015`、
`// @filename: a.ts`……）。`@filename` 把文件切成多个虚拟文件；指令行不进入
源文本。

v0 分四类处理：

| 类别 | 处理 | 例子 |
| --- | --- | --- |
| 支持的选项指令 | 翻译成 tsc 选项，进入期望生成与适配器输入 | `@strict`、`@target`、`@lib`、`@module`、`@moduleResolution`、`@skipLibCheck`、`@noImplicitAny`…… |
| 跳过指令 | 整用例 SKIP，带原因 | `@allowJs`、`@checkJs`、`@jsx`、`@noTypesAndSymbols`、`@types`、`@paths`、`@symlink`…… |
| 忽略指令 | 不影响「码 + 位置」的 emit/文案类指令 | `@declaration`、`@outDir`、`@sourceMap`、`@noEmit`、`@pretty`…… |
| 未知指令 | 整用例 SKIP（保守：不拿不完整口径下结论） | 其它 |

完整表在 `src/case.ts` 的 `OPTION_DIRECTIVES` / `SKIP_DIRECTIVES` /
`IGNORED_DIRECTIVES`，改表即改口径，需同时更新本节与测试。

### 3.2 用例集范围

- 只取 `compiler/` 与 `conformance/`（类型检查口径）。`fourslash/` 是 IDE
  语言服务用例，`project(s)/`、`transpile/`、`unittests/` 不在类型检查口径内，
  默认排除；后续若要覆盖 IDE 面，单独立一套 runner，不混进兼容性指标。
- 虚拟文件只允许 `.ts` / `.mts` / `.cts`（`.d.ts` 以 `.ts` 结尾自然包含）；
  含 `.js` / `.jsx` / `.json` 的用例 v0 SKIP。
- 虚拟路径不得含 `..`（防越界），违者 SKIP。

### 3.3 默认编译选项（待对齐项）

v0 的 `OFFICIAL_DEFAULTS` 是空集：指令没写到的选项用 **tsc CLI 的默认值**。
官方 harness 的默认值（`testRunner` 里的 `defaultOptions`）与 CLI 默认值未必
一致，这是 v0 已知的待对齐项；在 smoke 阶段不构成本结论，等接官方基线时统一
核对（见 §7）。

## 4. 期望来源

v0 用「固定版本的 tsc CLI 现场生成」：

1. 把用例的虚拟文件写到临时目录，按用例选项拼 tsc 参数（`--noEmit
   --ignoreConfig --pretty false` + 指令选项），跑指定 `tsc`。
2. 解析 `file(line,col): error TSxxxx: msg` 输出，按「文件 + 行 + 列 + 码」记
   诊断，行列转 0-based；语法错误（TS1xxx、以及 17006/17007 这两个语法级限制码）
   整体归 `syntax`，因为此后没有可比的语义诊断。
3. 结果按 `(文件内容, 参数, tsc 版本)` 的哈希缓存到 `.cache/expectations/`
   （进程退出/超时不落缓存，避免临时故障被持久成 SKIP）。

后续对接官方基线（`.errors.txt` 等）时，只需新增一个期望来源实现，
`compare.ts` 与指标层不变。

### 4.1 两种期望模式

- `--mode official`：用**用例指令**推导选项（目标口径，兼容性结论只认这个模式）。
- `--mode fixed`：忽略用例指令，统一用适配器声明的 `fixedOptions`；只用于
  「实现还不接受外部选项」时的流水线冒烟。运行器会打印警告，指标里
  `verdictEligible=false`。

## 5. 适配器协议

适配器把实现统一成 `Adapter.check(CaseInput) → CaseOutcome`。三种形态：

- `per-case`：每案起一次实现进程（v0 的 CLI 适配器）；
- `batch`：一个进程吃多案，NDJSON 双向流（推荐）；
- `api`：实现本身是 JS/TS，进程内调用。

### 5.1 批量协议（推荐形态）

一行一个 JSON 对象，stdin/stdout。请求：

```json
{"protocol":1,"type":"check","id":"<唯一 id>","files":[{"path":"a.ts","text":"..."}],
 "options":[{"name":"strict","value":true}],"args":["--strict","true"]}
{"protocol":1,"type":"shutdown"}
```

响应：

```json
{"protocol":1,"type":"result","id":"<同一 id>","status":"ok",
 "diagnostics":[{"file":"a.ts","line":0,"col":4,"code":2322,"severity":"error","message":"..."}]}
{"protocol":1,"type":"result","id":"...","status":"skip","skipReason":"@jsx"}
{"protocol":1,"type":"result","id":"...","status":"crash","message":"..."}
{"protocol":1,"type":"hello","implementation":{"name":"maat-zig","version":"..."}}
```

约定：行列 0-based；诊断文件路径用请求里的 `path`；`severity` 缺省 `error`；
一行只对应一个用例；`shutdown` 后退出。参考实现：
`src/adapters/mock-batch.ts`；客户端：`src/adapters/batch.ts`。

### 5.2 选项协商

`Adapter.supportsOptions` 表示实现是否接受外部编译选项。为 `false` 时，运行器
在 `official` 模式会给出警告（结论降级），并可用 `fixed` 模式做管线冒烟。

### 5.3 非 ok 状态

实现返回 `skip` / `crash` / `timeout` 时，该用例记为 SKIP 并按原因分类，
**不进入兼容性分母**（避免把实现不支持的能力伪装成兼容性数字）。

## 6. 指标

一次运行的 `metrics.json`：

- `totals.fpCases` / `fpTotal`：期望之外多报的用例数 / 诊断条数；
- `totals.expectTotal` / `hitTotal` / `coverage`：官方期望诊断数、命中数、
  覆盖率（`hit / expect`，无期望时 `null`）；
- `totals.passCases`：fp 与漏报都为 0 的用例数；`fpFreeCases`：只要求不误报；
- `totals.misanchorTotal`：同文件同码但位置不同的条数（错锚噪声，同时体现在
  fp 与 miss 两侧）；
- `byCode`：fp / miss 的码族 Top 15；
- `skips`：跳过原因分类计数；
- `meta.verdictEligible`：本次运行能否作为兼容性结论（`fixed` 模式、实现忽略
  选项时为 false）。

v0 判定粒度：**错误码 + 文件 + 行 + 列**（L1）。宽度只有部分实现给得出，缺省
时跳过比较；消息文案（L3）不比较。后续按需要增加 L2（位置/宽度）与 L3（文案）
档位，并作为指标输出的一部分。

`details.json` 保留逐用例的 fp/miss 点位，便于归因。

## 7. 基线与多版本（后续）

- 基线文件按 `tsc 版本 × 语料版本 × 子集` 组织（`baselines/<tsc>-<corpus>.json`），
  记录在册假阳性用例与码计数；`--gate` 用基线守门（新增 fp 即失败），
  `--update-baseline` 收编。
- 多 tsc 基线：5.9.x / 6.0.3 / 7.1.0-beta。同一份 harness 通过 `--tsc` 切换
  期望来源；语料 tag 与 tsc 版本是两条独立配置轴，是否长期保留 5.9 需按差异
  分析结果决定。
- 官方基线对接：优先消费官方 `tests/baselines` 中的期望，逐步评估与「现场生成」
  的差异，再决定正式口径。

## 8. 二进制分发

源码在私有仓库，二进制在这里分发（公开仓只有「被测输入」）：

1. 私有仓库 CI 构建平台二进制（linux-x64 起步），打 tag
   `binary-<impl>-<srcSha>-<platform>`；
2. 上传为本仓库的 Release Asset；
3. 通过 `repository_dispatch` 触发本仓库 workflow，参数里带实现名与 tag；
4. 本仓库下载 asset 后跑套件，指标作为 artifact 或 issue 评论回写。

公开仓不需要读私有源码的凭据；实现名与版本进入 metrics 的 `meta`。

## 9. 目录

```
src/case.ts            指令解析 / 选项推导 / 虚拟文件
src/discover.ts        manifest 与语料扫描
src/tsc.ts             期望生成（tsc CLI + 缓存）
src/compare.ts         匹配与指标
src/run.ts             运行器入口
src/adapters/          cli / batch / mock-batch / 工厂
scripts/select-smoke.ts  生成冒烟 manifest
config/smoke-cases.json  冒烟用例集（入库、可复现）
test/                  单测（bun test）
```

## 10. v0 限制与 TODO

- [ ] 批量适配器接真实实现（maat-zig 需要先提供 batch 模式或 shim）；
- [ ] 官方 harness 默认选项对齐（§3.3）；
- [ ] 官方基线作为期望来源（§7）；
- [ ] 多 tsc 基线与语料 tag 组合（§7）；
- [ ] 基线守门 `--gate` / `--update-baseline`；
- [ ] 更大规模的用例选择策略（按码族/目录分层抽样，避免只覆盖编译器用例）；
- [ ] 并行执行与结果合并（shard / merge）；
- [ ] L2/L3 判定粒度（宽度、消息文案）；
- [ ] 实现声明「已知不支持的错误码/能力」，用于 SKIP 而非算漏报；
- [ ] CI workflow（私仓 build → release asset → dispatch，见 §8）。
