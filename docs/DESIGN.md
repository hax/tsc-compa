# tsc-compa 设计（v0）

本文是当前 skeleton 的权威设计说明：协议、口径与指标定义。实现位置的
「TODO / 留给后续」都在最后一节列明。

## 1. 目标与范围

tsc-compa 是一个**与实现无关**的 TSC 兼容性测试套件：输入是任意 TSC 兼容
检查器（二进制、进程内 API 或批量进程），输出是「误报率 / 覆盖率 / SKIP 分类」
这组指标，目标是在官方 TypeScript 测试语料上证明「近乎 100% 兼容」。

不绑定的东西：实现语言（Rust / Go / TS 等均可）、tsc 基线版本（5.9.x /
6.0.3 / 7.1.0-beta，规划中）、语料来源（官方 `tests/cases`，后续可对接官方基线）。

v0 把协议、口径、指标固化下来并用小规模 smoke 集跑通全链路；当前版本加入
用例分类、多 tsc 基线（5.9.3 / 6.0.3 / 7.1.0-beta）、错锚口径、官方基线期望源
与 CI 门禁（`--gate`，§4.3）。门禁已接 `smoke.yml` 的 push/PR；每日 cron 是变化驱动的
（先跑 `scripts/detect-changes.ts` 判断输入是否变化，未变则跳过套件），全量运行仍未做，见 §10。

## 2. 流水线

```
语料 tests/cases
   │  发现（discover.ts：scanCorpus / manifest）
   ▼
用例（case.ts：指令解析 → 虚拟文件 + 有效编译选项；classify.ts：分类标签）
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

### 3.2 用例集范围与分类

- 只取 `compiler/` 与 `conformance/`（类型检查口径）。`fourslash/` 是 IDE
  语言服务用例，`project(s)/`、`transpile/`、`unittests/` 不在类型检查口径内，
  默认排除；后续若要覆盖 IDE 面，单独立一套 runner，不混进兼容性指标。
- 虚拟文件只允许 `.ts` / `.mts` / `.cts`（`.d.ts` 以 `.ts` 结尾自然包含）；
  含 `.js` / `.jsx` / `.json` 的用例 SKIP。
- 虚拟路径不得含 `..`（防越界），违者 SKIP。

用例按**正交标签**分类（`src/classify.ts` 的 `CASE_TAGS`）：

| 标签 | 含义 |
| --- | --- |
| `suite:compiler` / `suite:conformance` / `suite:other` | 语料大类（互斥，可覆盖全部用例） |
| `files:single` / `files:multi` | 虚拟文件数 |
| `lang:js` / `lang:jsx` | 含 JS/JSX 虚拟文件，或带 `@jsx` 指令 |
| `shape:parser` | parser 目录/文件名（语法错误高发） |
| `options:module` / `options:lib` / `options:emit` | 指令涉及模块解析 / lib / emit |
| `env:skip` | 依赖 @types、工程布局的环境类用例 |
| `expect:syntax` / `expect:no-errors`（运行期） | tsc 期望是语法错误 / 零诊断 |

标签可重叠，`byClass` 里各标签的数字**不能相加**（`suite:*` 三类除外）。
过滤用 `--exclude-class a,b`（命中任意即排除）与 `--only-class`（要求全部命中）；
被排除的用例记 SKIP，原因写 `类排除:<tag>`，不进入兼容性分母。

冒烟 manifest 生成（`scripts/select-smoke.ts`）时排除
`shape:parser`、`lang:js`、`lang:jsx`、`options:*`、`env:skip`，并用目标基线的
tsc 现场核对、剔除 `expect:syntax` 用例。

### 3.3 版本默认值（已对齐官方 harness）

指令没写到的选项使用**官方 harness 的默认值**，逐条核对源码后显式写进
`config/baselines.json` 的 `baseArgs`（不再依赖各版本 CLI 的隐含默认，避免版本漂移）：

| 项 | 5.9 | 6.0（strada） | 7.1（Go） |
| --- | --- | --- | --- |
| 默认 target | ES5 | ES2025（`ScriptTarget.LatestStandard`） | ES2026（`ScriptTarget.LatestStandard`） |
| 默认 module | 由 target 推出 CommonJS | 由 target 推出 ES2022 | 由 target 推出 ES2022 |
| 默认 moduleResolution | Node10 | Bundler | Bundler |
| strict 系默认 | false | **true** | **true** |
| harness 固定项 | `noResolve=false`、`newLine=CRLF`、`noErrorTruncation=true`、`skipDefaultLibCheck=true` | 同左 | 同左（Go harness：`NewLine=CRLF`、`SkipDefaultLibCheck=true`、`NoErrorTruncation=true`） |

来源：
- 5.9 / 6.0（JS 实现）：`src/compiler/utilities.ts` 的 `_computedOptions`（target /
  module / moduleResolution 的计算与 `getStrictOptionValue`）、`src/compiler/types.ts`
  的 `ScriptTarget.LatestStandard`、`src/harness/harnessIO.ts` 的 `compileFiles`（固定项）。
  5.9 的 `getStrictOptionValue` 是 `!!compilerOptions.strict`（默认 false），6.0 改成
  `compilerOptions.strict !== false`（默认 true）。
- 7.1（Go 实现）：`reference/typescript/tsc/internal/core/compileroptions.go`
  （`GetEmitScriptTarget`、`GetEmitModuleKind`、`GetModuleResolutionKind`、
  `GetStrictOptionValue`）与 `tsc/internal/testutil/harnessutil/harnessutil.go` 的 `CompileFiles`。
- case 指令经 `setCompilerOptionsFromHarnessSetting`（JS）/ `SetOptionsFromTestConfig`
  （Go）覆盖上述默认值。

**参数只作用于期望侧**：`baseline.baseArgs` 喂给期望生成；适配器只接用例指令与显式的
`--base-arg` / `--adapter-arg`，用实现自己的默认值。跨版本对照时不能把期望版本的
`--target es5` 强加给 6.0/7.1（会被直接判成配置错误 TS5107/TS5108）。

注意 6.0 起默认 target 与 strict 同时翻转（5.9 → 6.0），官方基线因此**不能跨版本通用**：
跨版本对照要么同版本自比，要么显式对齐选项后再比（见 docs/RESULTS.md）。

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

### 4.2 官方基线期望源

`--expectation-source official-baseline` 直接消费官方 errors 基线的错误摘要块
（`file(line,col): error TSxxxx: msg`，位置 1-based），指标层不变。支持两种布局：

- **strada / 6.0 线**：基线在 `tests/baselines/reference/` 下按 basename 平铺；
- **TS7 官方 Go 布局**（pin `microsoft/TypeScript@aa814927…`，取自 reference/tsc-rs 的
  `vendor/typescript-native/7.1.0-dev-aa814927/manifest.json`）：cases 在
  `tsc/testdata/tests/cases/`，基线在 `tsc/testdata/baselines/reference/` 下。注意 Go
  布局内部并不统一：`compiler` 套件按用例相对目录分层（`compiler/Foo.errors.txt`），
  而 `conformance` 等套件把子目录**拍平**（`conformance/es6/Symbols/Foo.ts` →
  `conformance/Foo.errors.txt`）。因此查基线按三档候选：id 相对路径 → suite 目录压平
  （首段目录 + basename）→ 根目录压平。漏掉「suite 压平」这一档会把 6 个 conformance
  用例误判成「无基线 = 无期望错误」，进而在任何实现上产生同一批假阳性——2026-11-15
  用 tsrs 复现并修复。


官方 harness 只在用例有诊断时写 `.errors.txt`，因此**缺基线 = 期望零错误**（不是
跳过）：无错用例也进入指标，参与假阳性检查。仍跳过的子集：

- 多值指令（基线带 `(key=value)` 配置后缀）——需复刻官方 harness 的配置命名；
- 绝对路径 `@filename` 与 `.d.ts` 用例；
- 基线含配置错误（无位置）或语法错误（TS1xxx）。

`bun scripts/select-smoke.ts --corpus <tests/cases> --errors 18 --clean 10` 可按
「有 errors 基线 / 无错」分组生成官方基线冒烟集（TS7 版入库为
`config/smoke-cases-ts71-official.json`；120 例错误用例扩展样本见
`config/official-baseline-cases-ts71.json`）。

已知偏差：官方基线来自仓库源码快照，与 npm 上发布的补丁版本不一定逐条一致
（见 docs/RESULTS.md；同源编译器生成期望列为后续待办）。

### 4.3 T0–T3 一致性分档与 ratchet

对齐 reference/tsc-rs 的 Agreement 口径，每个用例在官方基线上的最深一致档位：

| 档位 | 含义 |
| --- | --- |
| T0 `location` | file / line / col / code 多重集相同 |
| T1 `category` | + severity（error/warning） |
| T2 `text` | + 首行 message 完全相同 |
| T3 `full` | 整份 `.errors.txt` 摘要块字节相等（含 elaboration、related 与顺序） |

无基线文件（官方无错用例）时，两侧都空记 `full`，否则最多到 `text`。
`totals.byTier` 给分布；`totals.messageMismatch` 给「位置命中但首行文案不同」的
诊断条数（诊断级 T0−T2 差）；`samples.messageDiff` 给逐条文案差异样例。

**T3 的整份渲染**：期望侧只取基线文件第一个 `====` 之前的摘要块（`====` 之后
是用例源码标注，不属于诊断文本）；实现侧优先用适配器提供的 `CaseOutcome.fullText`
（`tsc-cli` 适配器保留首行 + 缩进阐述/related 续行与顺序，`Diagnostic.fullText`
同步携带），缺失时退回由诊断首行拼接（只可能到 `text`）。`totals.t3Failures` 给
未达原因分布：`missing`（实现少报）/`extra`（多报）/`diagnostics`（集合不同）/
`order`（次序不同）/`elaboration`（首行一致、缩进阐述不同）/`related`
（related information 不同）/`other`；`samples.t3` 给样例。T3 是报告档不是门禁档。

`--ratchet <file>` 维护 TSV 清单（`<case id>\t<tier>`，只登记 ≥T0 的用例）：
改善自动写回、回落退出非零、先前登记的用例变成 SKIP 也视为回落。**清单只记门禁档
T0–T2**：T3 full 是报告档，读入/写回时归一成 `text`（`gateTierOf`），所以 full → text
不算回落，text → category 才算；旧清单里的 full 条目会被自动归一。

**按实现分账**：`--ratchet-impl <impl> --baseline <id>` 推导 `config/ratchet/<impl>-<baseline>.tsv`；
清单不存在时**自动初始化**（只登记当前档位，不产生回落判定），因此首次接入的实现（如目标版本更旧的
`tsz`）不会被判红，后续轮次严格只升不降。`--ratchet-impl` 与显式 `--ratchet` 二选一；
显式路径不存在时默认报错，需要首次创建时加 `--ratchet-init`。清单入库，CI 按实现分别传入。

**CI 门禁（`--gate`）**：把一次运行折算成通过/失败，失败时退出码非零，逐项结论
同时打印到 stdout 并写入 `metrics.meta.gate`（`smoke.yml` 的 push/PR，以及每日 cron
在 detect 判「有变化」时才带它跑，见 docs/CI.md）。检查项：

- 口径：本次运行必须是兼容性结论（`--mode official` 且适配器接受外部选项）；
- 执行：至少跑完一个用例；
- ratchet：配置了清单时不允许 T0–T2 门禁档位回落（T3 归一为 text、不参与）。门禁模式
  要求清单已入库且非空（不自动初始化、拒绝空清单，避免 CI 里凭空生成「全绿」清单），
  也不回写改善；
- 阈值：`--gate-max-fp` / `--gate-max-miss` / `--gate-max-misanchor` /
  `--gate-min-coverage`。没有 ratchet 时前三者默认 0（自比自检口径）；配了 ratchet
  时默认不设条数上限（逐例严格性由清单承载），显式参数可叠加；阈值参数不带
  `--gate` 时直接报错，不会静默忽略。

**门禁档位**：T0 location / T1 category / T2 text 由 ratchet 清单按用例兜底；
**T3 full 是报告档**——ratchet 清单不记 full（归一为 text），未达只记入
`totals.byTier` / `totals.t3Failures` / `samples.t3`，不判红。

### 4.4 第三方实现接入

原则：**第三方实现只通过公开 CLI 驱动**（复用 `tsc-cli` 适配器），不为其写内部
adapter、不改它的源码；获取方式与能力差异登记在 `config/implementations.json`：

```jsonc
{
  "tsrs": {
    "adapter": "tsc-cli",
    "acquisition": { "npm": { "package": "tsrs", "version": "…", "bin": "node_modules/.bin/tsrs" },
                     "cargo": { "repo": "reference/oxc-tsrs", "command": "…", "bin": "…" },
                     "localEnv": "TSRS_BIN" },
    "cliArgs": ["--singleThreaded"],          // 公平测量/确定性用的固定旗标
    "baselines": ["7.1.0-beta", "7.1.0-beta-official"],
    "phaseMetrics": { "flag": "--extendedDiagnostics", "checkField": "Check time" }
  }
}
```

`bun scripts/install-impl.ts --name tsrs --dest .tools` 按登记获取二进制并打印路径
（npm 优先，其次 `localEnv`，再次已有 cargo 产物）；`.github/workflows/third-party.yml`
用它跑某实现 × 某基线的冒烟（T0–T3 / ratchet）并上传 metrics。各实现的相位字段名、
并行度开关、上游 pin 差异都写进 registry 与 RESULTS，不假装完全同口径。


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
{"protocol":1,"type":"hello","implementation":{"name":"checker","version":"..."}}
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
- `totals.misanchorCases` / `misanchorTotal`：**错锚**——同文件、同错误码、
  位置不同。这类差异先成对抵消，**不计入 fp 也不计入 miss**，单独报告；
- `totals.byTier`：官方基线 T0–T3 一致性分布（只统计跑完的用例，见 §4.3）；
- `totals.t3Failures` / `samples.t3`：T3 未达用例的原因分布与样例（见 §4.3）；
- `totals.messageMismatch` / `samples.messageDiff`：位置命中但首行文案不同的
  诊断条数与逐条样例（诊断级 T0−T2 差）；
- `samples.textDiff`：用例级「T0/T1 达成、T2 未达」的样例；
- `byClass`：按 §3.2 标签聚合的同一组指标（含每类的覆盖率、fp、漏报、错锚）；
- `totals.passCases`：fp、漏报、错锚都为 0 的用例数；
- `byCode`：fp / miss 的码族 Top 15；
- `skips`：跳过原因分类计数；
- `meta.verdictEligible`：本次运行能否作为兼容性结论（`fixed` 模式、实现忽略
  选项时为 false）。

判定粒度：**错误码 + 文件 + 行 + 列**（L1）决定 fp/覆盖；官方基线另给 T0–T3
分档（§4.3）承载 category 与文案/整份基线的比较。宽度只有部分实现给得出，
缺省时跳过比较。

错锚的正式口径：同一文件、同一错误码、位置不同的 expected × actual 各取一条
成对抵消，计入 `misanchor`；剩余的 actual 才计 fp，剩余的 expected 才计 miss。
覆盖率分母仍是全部期望诊断，分子只数「位置也一致」的命中，所以错锚会让覆盖率
略低于 100%，差额由 misanchor 数字解释。自比时出现错锚即 harness 的 bug；
跨版本时错锚是「判定一致、锚点口径不同」的信号，不能算成兼容性差异。

`details.json` 保留逐用例的 fp/miss 点位，便于归因。

## 7. 基线与多版本

「tsc 版本 × 语料 tag」是两条独立配置轴，在 `config/baselines.json` 里成对定义
（另有 `7.1.0-beta-official`：同一 tsc 版本，但期望源为 `ts71-official` 语料的
官方 `.errors.txt`，用于 §4.2 的 TS7 官方基线路径）：

```json
{
  "corpora": { "strada": {"repo": "microsoft/TypeScript", "ref": "b465fdbf…"},
               "v5.9.3": {"repo": "microsoft/TypeScript", "ref": "v5.9.3"} },
  "baselines": [
    { "id": "5.9.3", "tsc": "node_modules/typescript-5-9/bin/tsc",
      "baseArgs": ["--noEmit", "--pretty", "false"],
      "corpus": "v5.9.3", "manifest": "config/smoke-cases-5.9.json" },
    { "id": "6.0.3", … },
    { "id": "7.1.0-beta", … }
  ]
}
```

- 三个 tsc 版本用 npm alias 并存安装（`typescript-5-9` / `typescript-6-0` /
  `typescript-7-1`），互不覆盖；`bun src/run.ts --baseline <id>` 自动取该版本的
  tsc、基础参数、语料来源（进 `metrics.meta.corpusRef`）与默认 manifest。
- 每个基线有自己的冒烟集（语料 tag 不同，用例 id 也不同）：strada 用
  `config/smoke-cases.json`，5.9 用 `config/smoke-cases-5.9.json`。
- 锚点专用用例集 `config/anchor-cases.json`：已知跨版本锚点不同的用例，用来
  验证 misanchor 口径。
- CI 用 workflow matrix 跑三档自比（每档 checkout 自己的语料 tag）。

**是否长期保留 5.9**：目前的差异分析（docs/RESULTS.md）显示 5.9 与 6.0/7.1 的
差异主要是默认值漂移（strict、target）加少量模块上下文差异，保留成本主要在
语料与期望维护。该决策留待接入官方基线、扩大样本后再定。

**官方基线对接**：已接 v0 子集（§4.2），与「现场生成」并列、指标层不变；
多值变体基线、语法/配置错误基线、`.d.ts` 用例仍待后续。

## 8. 二进制分发（可选）

被测实现的源码可以在本仓库之外，本仓库只接收构建出的二进制与测试输入：

1. 实现侧 CI 构建平台二进制（linux-x64 起步），打 tag
   `binary-<impl>-<srcSha>-<platform>`；
2. 上传为本仓库的 Release Asset；
3. 通过 `repository_dispatch` 触发本仓库 workflow，参数里带实现名与 tag；
4. 本仓库下载 asset 后跑套件，指标作为 artifact 或 issue 评论回写。

本仓库不读实现源码，只需要下载本仓 release asset 的权限；实现名与版本进入 metrics 的 `meta`。

## 9. 目录

```
src/case.ts            指令解析 / 选项推导 / 虚拟文件
src/discover.ts        manifest 与语料扫描
src/tsc.ts             期望生成（tsc CLI + 缓存）
src/officialBaseline.ts 官方基线期望源（.errors.txt 子集）
src/compare.ts         匹配与指标（含错锚配对、按类聚合）
src/classify.ts        用例分类标签与过滤
src/baselines.ts       多基线配置（tsc × 语料 tag）
src/gate.ts            CI 门禁（--gate 的检查项与结论渲染）
src/run.ts             运行器入口
src/adapters/          tsc-cli / checker-cli / cli / batch / mock-batch / 工厂
scripts/select-smoke.ts  生成冒烟 manifest
scripts/select-official-baseline-cases.ts  生成官方基线可消费清单
scripts/detect-changes.ts  CI 每日 cron 的变化检测（本地输入哈希 / HEAD / 外部 pin）
config/baselines.json    基线配置（三个 tsc × 两套语料）
config/smoke-cases.json  strada 冒烟用例集（入库、可复现）
config/smoke-cases-5.9.json  5.9 语料冒烟集
config/anchor-cases.json     锚点专用用例集
config/official-baseline-cases.json  官方基线子集用例（示例清单）
config/smoke-cases-ts71-official.json  TS7 官方基线冒烟集（18 有错 + 10 无错）
config/official-baseline-cases-ts71.json  错误用例扩展样本（120 例，本地口径）
config/ratchet-ts71-official.tsv      TS7 官方基线 T0–T2 门禁 ratchet 清单（T3 归一 text）
test/                  单测（bun test）
```

## 10. v0 限制与 TODO

- [x] 批量适配器接真实实现：被测实现提供 `--batch`（NDJSON，协议见 §5.1），tsc-compa 注册 `checker-batch`（固定口径，与 `checker-cli` 逐案结果逐字段一致）；
- [ ] 期望生成本身进程内化（用各基线 typescript API 取代每案 CLI spawn，冷跑大头在这里）；
- [x] 官方 harness 默认值对齐（§3.3：三档 baseArgs 显式化，期望/适配器参数分离）；
- [x] 官方基线作为期望来源（§4.2；strada 平铺 + TS7 Go 分层两种布局，缺基线=无错）；
- [x] TS7 官方基线 T0–T3 分档与 T0–T2 门禁 ratchet（§4.3；T3 只报告）；
- [x] T3 整份基线渲染：adapter `fullText` 保留 elaboration/related 续行，期望只比摘要块，失败按 missing/extra/diagnostics/order/elaboration/related 归因（§4.3，RESULTS 结论 10）；
- [ ] 同源编译器生成期望（消除 npm 补丁版本与仓库基线的偏差）；
- [ ] 官方基线多值指令变体与配置命名复刻；
- [x] 多 tsc 基线与语料 tag 组合（§7，三档冒烟自比与跨版本预览已跑）；
- [x] 基线守门 `--gate`（§4.3：ratchet + 条数/覆盖率阈值，已接 `smoke.yml` 的 push/PR；每日 cron 先经 `scripts/detect-changes.ts` 判变化，未变跳过）；`--update-baseline` 未做，更新由 ratchet 改善写回承担；
- [ ] 更大规模的用例选择策略（按码族/目录分层抽样，避免只覆盖编译器用例）；
- [ ] 并行执行与结果合并（shard / merge）；
- [ ] L2/L3 判定粒度（宽度、消息文案）；
- [ ] 实现声明「已知不支持的错误码/能力」，用于 SKIP 而非算漏报；
- [x] CI workflow（实现侧 build → release asset → dispatch，见 §8；官方基线冒烟见 `.github/workflows/ts7-official.yml`）。


## 11. 性能附录（`--perf-ratio`，v0）

兼容性跑的主目标是正确性；性能只是附录：不参与退出码、不设门禁、不改变判定。打开 `--perf-ratio` 后：

- **实现侧计时免费**：正常兼容跑里在 `adapter.check` 前后计时，不额外跑实现；适配器若在
  `CaseOutcome.checkMs` 里自报每案检查耗时（`tsc-cli` 适配器解析 `--extendedDiagnostics` 的
  `Check time:` 得到），优先用 Check 相位口径。
- **固定分层样本**：跑之前预扫描（读主文件行数；官方基线模式下用 `baselineFileOf` 判断是否存在
  `.errors.txt`），按 suite × 行数档（≤50 / 51–200 / 201–1000 / >1000）× 有无期望错误分层，
  固定 seed/hash 排序抽样（默认 300 例，`--perf-sample` 可调）；每案每侧只跑一次，不做多轮重复。
- **顺序对半对冲**：样本按 hash 排序后前一半「参考先跑、实现后跑」，后一半「实现先跑、参考后跑」；
  同案两侧紧邻执行，且都用每案新进程 CLI、同参数（`--noEmit --pretty false --extendedDiagnostics`；
  实现支持时可另加 `--singleThreaded`/`--checkers 1`）。
- **空程序基线**：参考侧测 5 次、实现侧测 3 次空项目，各取最小作为固定成本估计。
- **口径**：两侧都有 Check 相位 → 累加 Check 比 + 逐案 Check 比值（中位数/几何均值/P25/P75）；
  实现没有相位 → wall − 空程序基线，且当参考每案固定成本占主导时守卫为 null 并告警，不给假精确值。
  另给「判定完全一致（fp/miss/错锚均为 0）」子集的比值。
- **样本组成**：`perf.sample.composition` 记录 suite/行数档/错误有无/对冲顺序，用于检查分层是否合理。
- **公平性说明**：`perf.warnings` 汇总 fixed 模式、实现无相位、参考失败、基线不稳等不对称项；
  跨实现比较只在同口径、同执行模式、同版本 tsc 下成立。
- **成本**：300 例参考 tsc（7.1 native 约 60–200ms/案）约 20–60 秒；默认关闭，CI 手动开启。
- 输出：`metrics.json` 的 `perf` 段（sample/metric/impl/reference/ratio/warnings）。
