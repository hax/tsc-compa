# tsc-compa 技术参考

编写适配器、读取指标文件或修改运行器时，可以在这里查参数、字段和比较规则。
各项设计的来由和报告的用途见 [设计思路](DESIGN.md)；
支持情况见 [实现状态](STATUS.md)，执行命令见 [README](../README.md) 和 [CI 使用说明](CI.md)。

第 1–10 节记录当前代码的行为，第 11 节说明两档比较与回归判定规则。
设计理由见 [DESIGN.md](DESIGN.md)，实现进展见 [STATUS.md](STATUS.md#53-两档比较与回归)。

## 1. 配置与编译选项

### 1.1 参考配置

通过 `--baseline` 选择的参考配置由以下部分组成：

| 字段 | 作用 |
| --- | --- |
| `id` | 通过 `--baseline` 选择的名称 |
| `tsc` | 参考 tsc 的可执行文件路径 |
| `baseArgs` | 运行时生成参考诊断所用的基础 CLI 参数 |
| `corpus` | 测试集引用的配置键 |
| `manifest` | 默认用例列表 |

参考 tsc 的版本与测试集版本是两个独立维度，必须明确配对。
同一个参考 tsc 可以对应不同测试用例或清单，每种组合用一个配置名选择。

测试集引用可以是版本标签或固定提交；需要稳定复现时应优先使用固定提交。
读取官方结果文件时，应核对测试集提交与参考编译器发布来源的关系；
具体配置、版本默认值和测试框架差异见 [实现状态](STATUS.md)。

### 1.2 参考诊断来源与运行模式

这两个 CLI 参数控制不同的事情：

| 维度 | 参数值 | 作用 |
| --- | --- | --- |
| 参考诊断来源 `--expectation-source` | `tsc` | 运行参考 tsc，生成并缓存参考诊断 |
| 参考诊断来源 `--expectation-source` | `official-baseline` | 读取官方 `.errors.txt` 中的参考诊断 |
| 参考诊断来源 `--expectation-source` | `ts7-api` | 经 TS7 async API 直接取得结构化诊断，不读写期望缓存 |
| 运行模式 `--mode` | `official` | 将支持的用例编译选项指令交给适配器 |
| 运行模式 `--mode` | `fixed` | 使用适配器声明的 `fixedOptions`，不使用用例编译选项指令 |

`official` 表示遵循用例选项，不表示一定读取官方诊断基线。
三种参考结果来源都可以与 `official` 模式组合。`ts7-api` 要求所选参考配置解析出的
tsc 版本为 `7.1.0-beta`（当前 `7.1.0-beta` 与 `7.1.0-beta-official` 都满足），
并禁止用 `--tsc` / `TSC_BIN` 覆盖参考二进制；参考与候选都是 TS7 async API 时，
各自为每个用例建立 program，不共享 program 结果。

`fixed` 模式用于验证固定选项检查器的调用流水线，要求适配器声明 `fixedOptions`。
读取官方诊断基线时，模式或额外参数不会重新生成基线内容；
修改候选选项后，需重新核对保存的参考结果与输入配置是否一致。

字段 `meta.verdictEligible` 表示运行模式和适配器是否满足门禁的比较条件：

```text
mode = official 且 adapter.supportsOptions = true
```

门禁要求此字段为 true；用例完成数量和错误数量另行检查。

### 1.3 选项来源与优先级

运行参考 tsc 时，基础参数写明目标版本的官方测试框架默认值，避免依赖不同版本
CLI 的隐含默认值。默认仅参考侧使用该参考配置；加 `--option-strategy aligned` 可把同一组基础参数也传给候选。

CLI 参数按以下顺序构造，支持的用例选项追加在最后：

| 接收方 | 参数来源，按追加顺序 |
| --- | --- |
| 生成参考诊断的 tsc | `baseline.baseArgs` → `--base-arg` → 用例选项或 `fixedOptions` |
| 被测适配器的 `CaseInput.args` | `aligned` 时先加 `baseline.baseArgs` → `--base-arg` → `--adapter-arg` → 用例选项或 `fixedOptions` |
| 读取官方诊断基线 | 使用已保存的内容，不执行上述参数生成 |
| TS7 async API 参考 | `baseline.baseArgs` → `--base-arg` → 用例选项；API 适配器再补自身默认参数 |

适配器还可以在调用实现时添加自己的默认参数或输出格式参数。
同一选项重复出现时，应遵循目标 CLI 的解析规则；用例选项追加在最后，
可能覆盖先追加的同名参数，包括 `--base-arg`。

`CaseInput.options` 是结构化选项列表；`CaseInput.args` 是供 CLI 使用的参数列表。
前者不包含所有基础参数，后者也不包含待写入的源文件路径。
适配器需要结合结构化选项、CLI 参数和自身默认值处理输入。

跨版本比较需要说明目的：

- 使用各自默认值：衡量默认行为差异；
- 显式对齐选项：尽量区分默认值差异与检查行为差异。

对齐选项前应确认双方都支持这些选项和值。
标准库、模块环境和测试框架差异另见 [实现状态](STATUS.md)。

## 2. 执行流程

```text
测试集引用 + 用例列表 + 参考配置 + 适配器
                    │
              读取与解析用例
                    │
              构造虚拟文件与选项
                    │
              分类、过滤与支持检查 ──► SKIP + 原因
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
  获得参考诊断               调用候选适配器
  ├─ 参考 tsc + 缓存          └─ 统一结果
  ├─ 官方诊断基线
  └─ TS7 async API
       │                         │
       └────────────┬────────────┘
                    ▼
           诊断匹配 + 一致性分档
                    ▼
          指标、逐案明细与可选报告
                    ▼
          回归检查与可选兼容性门禁
```

流程图表示数据依赖，不要求两侧并行执行。
任何阶段未能形成可比较结果，都应记录跳过或异常原因。
报告保留门禁检查结果及失败信息。

## 3. 用例解析、选择与分类

### 3.1 指令与虚拟文件

官方测试输入通过注释指令声明选项和虚拟文件，例如 `// @strict: true`、
`// @target: es2015`、`// @filename: a.ts`。
`@filename` 划分虚拟文件；被识别为元数据的指令行不属于源文件内容。
剥离哪些行会影响诊断位置，因此解析行为必须与所选测试集的测试框架核对。

指令处理分为四类：

| 类别 | 行为 | 结论限制 |
| --- | --- | --- |
| 支持的选项指令 | 转换为结构化编译选项 | 仍需确认被测实现接受该选项 |
| 跳过指令 | 整个用例记录为 SKIP，并给出原因 | 不进入诊断统计分母 |
| 忽略指令 | 不转换为选项，保留忽略记录 | 不代表该指令对诊断或文本一定无影响 |
| 未知或不可解析指令 | 整个用例记录为 SKIP | 不在不完整输入条件下给出比较结论 |

整理文件名、将虚拟文件写入临时目录时，需检查路径是否越出用例根目录。
绝对虚拟路径、声明文件和多配置变体需要分别判断，不能混为一种「不支持」。
指令支持表、扩展名规则及保真度缺口见 [实现状态](STATUS.md)。

用例列表仍写 `compiler/Foo.ts`，不要写展开后的 ID。例如 `// @target: es2015, es2020`
生成两个独立配置，分别以 `compiler/Foo(target=es2015).ts` 和
`compiler/Foo(target=es2020).ts` 运行、计时并检查回归。具名记录的 `details.json`
包含 `caseId: "compiler/Foo.ts"` 和 `configuration: "target=es2015"` 等字段；普通记录
仍用源文件路径作 `id`。多个多值选项按组合展开，上限为 256 个配置。`lib` 保留整组逗号
分隔值，不产生配置变体。`fixed` 模式不执行具名配置变体。
`declaration` 与 `emitDeclarationOnly` 已作为编译参数传递；声明生成诊断仍取决于适配器及
实际编译选项。

### 3.2 用例选择与多维标签

用例列表固定样本和顺序；扫描测试集用于发现候选用例，结果还需说明选择范围。
类型检查用例以 `compiler` 和 `conformance` 测试类别为主要对象；
IDE、工程构建等用例应使用独立的测试规则。

分类标签用于描述多个维度：

| 维度 | 标签示例 |
| --- | --- |
| 测试类别 | `suite:compiler`、`suite:conformance`、`suite:other` |
| 文件数 | `files:single`、`files:multi` |
| 语言特征 | `lang:js`、`lang:jsx` |
| 输入形态 | `shape:parser` |
| 选项涉及的功能 | `options:module`、`options:lib`、`options:emit` |
| 环境依赖 | `env:skip` |
| 运行时参考结果特征 | `expect:syntax`、`expect:no-errors` |

不同维度的标签可以重叠；`suite:*` 等同一维度内的互斥标签可组成分区。
`byClass` 的数字不能跨重叠标签直接相加。

`--exclude-class a,b` 命中任意一个标签即排除；
`--only-class a,b` 要求同时命中所有指定标签。
运行期标签要在获得参考结果之后才能判断。
被排除的用例记录为 SKIP，原因为 `类排除:<tag>`，不会从结果中静默消失。

## 4. 参考诊断

### 4.1 运行参考 tsc

将虚拟文件写入临时目录后，由参考 tsc 检查。
解析器将 CLI 输出的 1-based 行列转换为接口中的 0-based 行列。
诊断文件路径应映射回用例内相对路径，不把临时目录或外部环境文件混入用例诊断。

缓存键是以下内容的 SHA-256，保存为 `.cache/expectations/<hash>.json`：

```text
schemaVersion, pipeline,
files[{path,text}], args, tscVersion,
compilerIdentity = 参考原生二进制或 wrapper 的 sha256
```

运行器传入 `meta.tools.reference.native.sha256`，没有原生包装时传 wrapper 的 sha256；
因此 npm 包版本号相同但二进制不同，不会读回旧诊断。键中不包含操作系统、libc、默认库
路径等环境标识；跨环境复用时仍要核对版本、二进制和参数。读回时还要求缓存的
`schemaVersion` 与 `pipeline` 等于当前值，旧管线结果会被重新采集。
崩溃和超时不写缓存，避免把临时故障固化；语法错误结果可以缓存，读取时仍按
`syntax` 跳过。`ts7-api` 参考不经过这个缓存。

### 4.2 读取官方结果文件

读取 `.errors.txt` 时，只解析第一个以 `====` 开头的行之前的诊断摘要块。
后面的源码标注不是诊断摘要，不参与 T3 比较。

基线查找需适配目录布局，候选顺序为：

1. 保留用例相对目录；
2. 保留测试类别首段目录，将其下的子目录平铺；
3. 只按用例文件名在基线根目录查找。

例如 `conformance/es6/Symbols/Foo.ts` 可以对应
`conformance/Foo.errors.txt`，而不是仅尝试完整相对路径。
布局和配置变体命名是不同问题，不能通过「找不到文件」替代变体支持。

无配置后缀的用例沿用缺 `.errors.txt` 即零诊断的规则，前提是测试集完整、路径映射正确。
具名配置按自己的文件名查找，例如 `Foo(target=es2015).errors.txt`，不借用无后缀或其他配置的
结果。没有该 `.errors.txt` 时，只有找到同一配置、同一主文件名的 `.types`、`.symbols`、
`.js` 或 `.d.ts` 产物才记为零诊断；否则跳过该配置。

官方结果文件的跳过原因要按输入分别记录：

| 情形 | 当前处理 |
| --- | --- |
| 不支持的配置，或具名配置缺少官方结果及同配置产物 | 跳过并记录原因；其他可比较的配置分别计数 |
| 绝对路径 `@filename` | 跳过；不把虚拟根路径写到磁盘 |
| 用例 ID 以 `.d.ts` 结尾 | 跳过；普通用例包含虚拟 `.d.ts` 不受影响 |
| 基线含 pretty／ANSI | 跳过；非空 pretty 输出不能当作零诊断 |
| 基线含无位置配置错误 | 跳过；没有可映射的文件位置 |
| 基线含 TS1xxx／TS17006／TS17007 | 跳过；与当前「语法即整案 SKIP」口径一致 |

未知或不可解析的选项指令在解析阶段整案跳过，原因写入 `details.json` 的
`skipReason`；它不会退化成零选项后继续比较。`--limit` 截掉的用例根本不在本次记录中，
不能被解释为跳过。

## 5. 诊断匹配与指标

### 5.1 诊断字段与统计范围

诊断接口包含：

| 字段 | 含义 |
| --- | --- |
| `file` | 用例内相对文件路径 |
| `line`、`col` | 0-based 行号和列号 |
| `code` | 数值诊断码，如 `2322` |
| `severity` | `error` 或 `warning` |
| `message` | 可选的诊断首行文本 |
| `end` | 可选的结束位置；`line`、`col` 均从 0 开始，列以 UTF-16 代码单元计，可跨行 |
| `width` | 可选的诊断跨度；严格比较里的 `width` 项也可根据 `end` 核对，不影响诊断对应 |
| `messageChain` | 可选的结构化消息链；`null` 表示明确无链，`undefined` 表示未提供 |
| `related` | 可选的结构化相关信息；`[]` 表示明确为空，`undefined` 表示未提供 |
| `attributes` | 可选的其他结构化属性；`undefined` 表示未提供 |
| `fullText` | 可选的单条诊断完整文本块，包括说明续行 |

两档比较保留全部诊断；参考 error 对上 warning 也算命中。候选额外的 warning 单列，不计多报错误。
`CaseOutcome` 另有结果级 `fullText`（完整诊断摘要流）、`exitCode`、`checkMs` 和
`rawOutput`。字段缺失与明确空值分开：例如 `related: []` 参与「明确为空」的比较，
`related` 缺失则对应字段记为 `unavailable`。

### 5.2 匹配规则

兼容匹配以「文件、起点、问题类型」为键做一对一匹配，保留重复项，优先吸收候选 error。
同一问题使用相同的原始码，或命中 `config/baselines.json` 中按参考 tsc 版本配置的等价码组。
未匹配项在同文件同组只有唯一对应时，可另记为位置差异；这仍不是兼容命中。多个候选位置不能归因时，不凭顺序配对。
缺部分匹配键时，根据已知分量检查能否解释全部参考诊断和候选 error；可能对应的项单列 `unresolved`。

### 5.3 指标定义

下表省略重复的 `totals.` 前缀；除用例总数和跳过数外，统计只包含形成可比较结果的用例：

| 字段 | 单位／定义 |
| --- | --- |
| `cases`、`ran`、`skipped` | 本次用例数、完成比较的用例数、跳过的用例数 |
| `expectTotal`、`hitTotal` | 参考诊断数、满足匹配键的诊断数 |
| `coverage` | `hitTotal / expectTotal`；参考总数为零时是 `null`，不是 100% |
| `fpCases`、`fpTotal` | 至少有一条多报错误的用例数、多报错误诊断条数 |
| `missTotal` | 漏报诊断条数 |
| `misanchorCases`、`misanchorTotal` | 至少有一对位置差异的用例数、位置差异配对数 |
| `passCases` | 兼容档通过的用例数；严格一致见 `comparison.strict` |
| `fpFreeCases` | 多报错误为零的用例数；仍可能有漏报或位置差异 |
| `byTier` | 现有实现中每个用例最高分级的分布，不是累计达档数 |
| `messageMismatch` | 已配对但首行文本不同的诊断条数 |
| `t3Failures` | 存在官方结果文件正文时，T3 未达原因的分类计数 |

其中 `cases` 和 `skipped` 包含跳过用例，其余诊断统计不包含。
`byClass` 按标签聚合，`byCode` 给出多报错误／漏报的高频诊断码；
`skips` 按原因汇总跳过，`samples` 保存文本差异、T3 未达等样例。

`comparison.compatibility` 和 `comparison.strict` 分别以 `pass`、`fail`、`unknown` 汇总已完成用例。
`comparison.fields` 按字段汇总 `equal`、`different`、`unavailable`；`byClass` 也分别计数两档。

多报错误使用用例数和诊断条数两个计数。
现有字段和原始 CLI 输出仍保留代码用词：`fp`／`假阳性` 对应多报错误，
`misanchor`／`错锚` 对应位置差异。
报告高覆盖率时，应同时给出 `ran / cases`、跳过原因及样本选择方式。
崩溃、超时或不支持的用例排除于诊断分母之外，会影响结果的代表性。

## 6. 旧版 T0–T3 分级

以下为旧产物与历史实验保留，不是新版结论或门禁。

### 6.1 等级定义

每个用例只记录达到的最高分级，后一项包含前一项的条件：

| 分级 | 标识 | 比较内容 |
| --- | --- | --- |
| 未达 T0 | `none` | 诊断位置与码的多重集不同 |
| T0 | `location` | `(file, line, col, code)` 多重集相同 |
| T1 | `category` | T0 条件，加 `severity` 相同 |
| T2 | `text` | T1 条件，加首行 `message` 相同 |
| T3 | `full` | T2 条件，加诊断摘要文本相同 |

T0–T2 不比较诊断输出顺序；缺失的 `message` 按空串处理。
报告中的「至少达到 T1」由 T1、T2、T3 三档相加得到，
不同于 `byTier.category` 单独记录的「最高只达到 T1」。

### 6.2 T3 的文本范围与换行处理

参考侧取官方结果文件第一个 `====` 之前的摘要块，将换行统一为 LF，
去除摘要末尾的空白行，保留其他行内及行尾空白。
比较对象不是整个基线文件的原始字节。

实际侧按以下优先级获得摘要文本：

1. 适配器提供的 `CaseOutcome.fullText`；
2. 按实际输出顺序拼接 `Diagnostic.fullText`；
3. 未提供单条完整文本时，渲染文件、位置、严重级别、诊断码和首行文本。

适配器应输出与参考侧摘要格式一致的文本。
补充说明（elaboration）、相关诊断信息（related information）和输出顺序都影响 T3。
如果官方摘要只有首行，回退渲染也可能达到 T3；
如果包含续行，则仅提供首行通常不足以达到 T3。

没有官方结果文件正文时，非空诊断最多评到 T2；两侧诊断为空且实际摘要为空白时，
按约定记为 T3。这是无错用例的特例，不是对缺失正文做了完整文本验证。
运行时生成参考诊断的报告将完整文本比较标为不可用，空结果的分级仍按上述约定统计。

T3 未达原因分为 `missing`、`extra`、`diagnostics`、`order`、
`elaboration`、`related`、`other`，分别描述诊断少报、多报、集合不同、
顺序不同、说明续行不同、关联信息不同及其他差异。

## 7. 回归检查与 CI 通过条件

### 7.1 ratchet 规则

按「候选检查器 × 参考配置」保存 TSV。更换期望来源或测试范围时，应使用独立记录或审阅并更新。
每行保存 `<id><TAB><compatibility><TAB><strict><TAB><fields><TAB><legacy>`。
旧 `location|category|text|full` 只作为兼容历史迁移，不证明严格一致或结构化字段已验证。
已验证用例跳过、被排除或从用例列表移除，均记录为该档不可确认；逐字段亦然。

### 7.2 初始化与更新

- `--ratchet <path>` 需要已有文件；首次可加 `--ratchet-init`。`--ratchet-impl <id>` 按参考配置推导路径并可初始化，二者不能同时使用。
- 非门禁且可作结论的运行可写入改善，不覆盖已经验证为通过或相同的要求。
- `--gate` 仅读取已存在的记录；所选保护档必须至少已有一个通过用例。不要把有限的 `--limit` 当作完整回归验证。

### 7.3 CI 检查

`--gate` 要求运行可作兼容结论且至少完成一个用例。默认 `--gate-profile compatibility`；
`--gate-profile strict` 也阻断严格一致性回归。无回归记录时，已完成用例须全部通过所选档；
有记录时，阻断受保护用例在对应档退步。字段回归单列但不单独阻断。
`--gate-max-fp`、`--gate-max-miss`、`--gate-max-misanchor`、`--gate-min-coverage`
可附加限制，不用于放宽档位要求。门禁结论见 `meta.gate`；逐案回归见 `meta.ratchet.regressionDetails`。

严格档在没有 ratchet 时经常用来验证 API 自比：参考和候选都提供结构化字段，严格一致
才能得到 `pass`；纯文本 CLI 通常只把无诊断用例判为 `pass`，其余因范围、消息链等
未提供而记 `unknown`。

`--limit N` 在配置展开前截取用例列表的前 N 个源文件。`meta.selectedCases` 是选中的
源文件数；`totals.cases` 统计展开后的记录（含跳过）。`meta.manifest.sha256` 是完整列表的
哈希，`selectedIdsSha256` 是截取后源文件 ID 的哈希。被截掉的源文件不出现在
`details.json`，但其已保护记录仍可能报告「未进入本次执行范围」的回归。
固定 120 例评估脚本不提供 `--limit`。

## 8. 适配器接口与批量协议

### 8.1 统一接口

适配器实现 `Adapter.check(CaseInput) → CaseOutcome`，
并可提供初始化和关闭方法。

| 字段／形态 | 含义 |
| --- | --- |
| `per-case` | 逐案调用实现进程 |
| `batch` | 一个常驻进程处理多个用例 |
| `api` | 进程内 API 形态；TS7 的客户端在 Bun，编译器后端仍是持久子进程 |
| `supportsOptions` | 适配器声明是否接受外部编译选项，不是运行时协商结果 |
| `fixedOptions` | 固定选项模式使用的结构化选项列表 |

`CaseOutcome.status = ok` 表示获得了可比较的检查结果，不表示没有错误诊断。
`skip`、`crash`、`timeout` 在汇总中记为 SKIP 并保留原因，不进入诊断统计分母。

适配器可通过 `CaseOutcome.fullText` 提供完整诊断摘要流，
通过 `CaseOutcome.checkMs` 提供 Check 阶段耗时，单位为毫秒。
各适配器提供哪些字段，见 [实现状态](STATUS.md)。

`ts7-api` 的补充约定：

- 使用 `typescript-7-1/async` 的 `API` 类；参考和候选各建一个适配器实例，实例内串行排队；
- 命令行由适配器默认参数、`CaseInput.args`、物化后的文件路径组成，再交给
  `parseCommandLine`；`createProgram` 使用解析出的文件与选项，相对路径选项按用例临时目录解析；
- 诊断按命令行解析、program、global、配置、语法、语义、声明生成阶段的顺序收集；有语法诊断
  时不查语义诊断；声明生成阶段只在满足实际编译选项和前置诊断条件时查询，不写声明文件；
- 主诊断和相关信息都保留 API 提供的有效 `endPosition` 为 `end`。数值 `width` 仍只取同一行的
  UTF-16 列差；跨行结束位置直接用于严格比较的 `width` 项，不用原始 `end - pos` 猜跨度；
- 任一诊断没有文件位置、或出现 error/warning 之外的 category，整案记为 skip；
  临时目录之外的 lib 诊断剔除；
- 每次调用单独格式化诊断，`Diagnostic.fullText` 与拼接后的 `CaseOutcome.fullText` 同源；
  空诊断的结果级 `fullText` 是 `""`；
- 不提供逐案 `exitCode`，不跨方法去重；超时后下一案会等待仍在途的 API 工作。
  关闭内置会话时，超过宽限期仍在执行的自有子进程会被终止；不强制终止宿主注入的客户端。

`--adapter tsrs-async` 是独立的实验候选。它复用上述诊断收集和会话规则，但从
`config/tsrs-async` 的隔离安装目录加载 `tsrs@0.25.0-ts7.1.0-beta` 的 `tsrs/async`，并显式启动同一
npm 发布的平台原生程序。该目录的 `bun.lock` 固定 SDK 和各平台原生包的版本及 tarball 完整性。
`TSRS_BINARY` 非空时拒绝运行，不回退到官方 `tsc` 或逐案 CLI。
`--expectation-source ts7-api` 仍单独加载官方 `typescript-7-1/async`。报告中的
`meta.tools.candidate.{path,version,sha256}` 记录实际用于启动 API 的原生程序；
`meta.tools.candidate.sdk` 记录模块名、版本、入口路径和入口文件的 SHA-256（不是整个 SDK 包的哈希）。
安装与复跑命令见 [tsrs async 试验记录](RESULTS.md#tsrs-async-候选试验2026-11-27)。

### 8.2 NDJSON 消息

批量协议通过 stdin 接收请求、stdout 输出响应；
每行是一个完整 JSON 对象，诊断日志写到 stderr。
协议版本字段为 `protocol: 1`。

请求示例，每行可独立解析：

```jsonl
{"protocol":1,"type":"check","id":"case-1","files":[{"path":"a.ts","text":"const value: string = 1;\n"}],"options":[{"name":"strict","value":true}],"args":["--strict","true"]}
{"protocol":1,"type":"shutdown"}
```

响应示例，`result.id` 回显对应请求的关联 ID：

```jsonl
{"protocol":1,"type":"hello","implementation":{"name":"checker","version":"1.0.0"}}
{"protocol":1,"type":"result","id":"case-1","status":"ok","diagnostics":[{"file":"a.ts","line":0,"col":6,"code":2322,"severity":"error","message":"Type 'number' is not assignable to type 'string'."}],"fullText":"a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.","exitCode":2,"checkMs":12}
{"protocol":1,"type":"result","id":"case-2","status":"skip","diagnostics":[],"skipReason":"@jsx"}
{"protocol":1,"type":"result","id":"case-3","status":"crash","diagnostics":[],"message":"checker process failed"}
```

`case-2` 和 `case-3` 分别演示 skip 与 crash 请求结果。
关联 ID 必须唯一；它用于匹配请求与响应，不必等于测试集中的用例路径。
`file` 使用请求中的虚拟文件路径，行列使用 0-based，
`severity` 未提供时客户端按 `error` 处理。

结果级可选字段：

| 字段 | 含义 |
| --- | --- |
| `fullText` | 完整诊断摘要流；`""` 表示明确无诊断，缺省表示未提供 |
| `exitCode` | 实现进程退出码；`null` 表示没有退出码，缺省表示未采集 |
| `checkMs` | Check 阶段耗时，毫秒；缺省表示未提供 |
| `rawOutput` | `{stdout, stderr}` 原文，仅留存，不参与比较 |

诊断级可选字段 `width`、`messageChain`、`related`、`attributes`、`fullText`、`raw` 也原样透传；
客户端不会把 `related: []` 改成缺失，也不会给缺字段补空对象。协议自检实现
`mock-batch` 的 `FAKE_RICH` 覆盖这些字段，实际实现的字段完整度仍需逐项核对。

`hello` 可提供实现名称和版本，不改变 `supportsOptions`。
收到 `shutdown` 后实现应结束进程。
`checker-batch` 工厂固定 `supportsOptions=false`，只能配 `--mode fixed`；
批量客户端出现 crash 或超时后按 SKIP 保留原因，不进入诊断分母。

`bun-check` 收到 `declaration=true`、`emitDeclarationOnly=true` 或 `composite=true` 时，
将该配置标为跳过；它不提供声明生成阶段的诊断。

## 9. 性能指标

### 9.1 测量对象与抽样

`--perf-ratio` 在兼容性运行中附带性能测量，不为耗时设置兼容性门禁。
正常用例执行时记录 `adapter.check` 从开始到结束的实际耗时，不为计时额外重跑被测用例；
但参考侧执行和空程序测量仍有额外成本。

固定样本按测试类别、行数分桶及参考错误特征分层，并用固定种子排序选取。
这些特征是抽样依据，不保证覆盖所有诊断码或所有语言特性。
两侧每个样本各运行一次，参考先执行与实现先执行的顺序对半分配，
减少时间窗口造成的系统性偏差，不等于消除了测量噪声。

参考侧使用逐案 tsc CLI；实现侧沿用所选适配器，不自动转换成逐案进程。
两侧采用对应的用例选项，但还需检查适配器附加参数、进程模式和并行度是否一致。
跨实现比较必须公开这些条件。

### 9.2 比值与计算条件

主比值的方向始终是「被测实现耗时 / 参考 tsc 耗时」：
小于 1 表示在该测量方法下候选耗时更少，比较工作量还需结合诊断结果。

- 两侧样本均提供 Check 阶段耗时时，使用累计 Check 耗时之比；
- 否则使用扣除空程序固定成本估计后的实际耗时之比；
- 分子或分母非正、固定成本占主导等情况返回 `null` 并记录原因。

Check 耗时只衡量检查阶段；实际耗时还可能包含启动、写入文件、解析、绑定和输出，
比较时需使用相同的测量方法。

不扣空程序固定成本的实际耗时（raw wall）单独记录，不替代 Check 或差分比值。以下字段
相对于 `metrics.perf`，两行均只纳入双方都完成计时的记录：

| 范围 | 双方累计实际耗时（毫秒） | 候选 ÷ 参考 |
| --- | --- | --- |
| 全计时样本 | `impl.sumWallMs`、`reference.sumWallMs` | `ratio.wall` |
| 兼容档通过子集 | `ratio.agreementSubset.implWallMs`、`ratio.agreementSubset.referenceWallMs` | `ratio.agreementSubset.wall` |

Markdown 和 HTML 性能附录均展示这两种范围的原始实际耗时比值。兼容通过子集不要求
严格一致；没有正的参考总耗时时，raw wall 比值为 `null`。结果也记录样本组成、逐案比值
和双方调用条件不一致时的告警。
抽样默认值、空程序重复次数和具体字段见 [实现状态](STATUS.md)。

## 10. 结果输出与外部集成

`metrics.json` 保存运行元数据、聚合指标及可选门禁／性能结果；
`details.json` 保存逐案诊断和差异，供归因使用。
Markdown 和自包含 HTML 报告从同一份数据渲染，不再执行测试。

报告应同时呈现运行配置、完成／跳过数量、多报错误／漏报／位置差异、
诊断覆盖率、上下两档分布、旧分级结果和测试范围。
前后运行的差异只有在测试集、用例选择、参数与比较规则可对照时才有明确意义。
渲染过程应具有确定性，HTML 内容需转义，失败信息不能因汇总而丢失。

CI 可以接收外部实现构建出的二进制，再交给适配器执行。
分发渠道、下载权限和触发方式属于部署配置，不改变诊断比较规则。
报告产物、分支保护配置及二进制接入操作见 [CI 使用说明](CI.md)。

## 11. 两档比较与回归判定规则

实现范围与限制见 [实现状态](STATUS.md)。

### 11.1 诊断对应与兼容判定

参考与候选诊断按主诊断文件、起点和问题类型对应。文件使用用例内相对路径，
位置换算为一致的单位；原始位置和输出也保留。

- 原始诊断码相同，或属于针对参考版本确认的等价码组，才能按同类问题匹配；
- 每条参考诊断需要独立的候选对应，重复诊断也按条数核对；
- error／warning 升降不妨碍对应，另记严重级别差异；
- 未对应的候选 warning 记为附加提醒，未对应的候选 error 记为多报错误；
- 参考诊断缺失、主诊断文件或起点不同、问题类型不同，兼容判定失败。

主诊断起点相同、标记长度不同可以兼容；related info 的位置属于附加信息，单独比较。

### 11.2 严格一致与独立差异项

严格一致要求所有诊断及其输出相同，不允许附加或缺失诊断，包括 warning。

| 差异项 | 比较内容 |
| --- | --- |
| 原始诊断码 | 原始数值完全相同，等价码替换仍是差异 |
| 严重级别 | 实际记录的诊断类别相同 |
| 主诊断定位 | 文件、起点、长度或标记范围相同 |
| 说明文字 | 首行文本、修正建议相同 |
| 消息链 | 各节点的内容及层次相同 |
| related info | 内容、相关位置、数量及顺序相同 |
| 其他诊断属性 | 双方接口返回的附加诊断信息相同 |
| 诊断集合与顺序 | 条数和先后顺序相同 |
| 完整诊断输出 | 诊断文本、标注和格式相同，不包含运行耗时或调试日志 |

严格比较的 `width` 项在双方都给出 `end` 时比较结束位置，即使结束位置跨行；否则尝试比较
单行跨度。一侧只给出跨行结束位置，另一侧只给出数值宽度时，该项记为 `unavailable`。

这些项分别比较。某项不同，不停止其余项的比较，也不覆盖其余项的结果。
保存两档结果和具体差异，报告默认突出不同项。

### 11.3 字段可用性

结果区分「相同」「不同」「未提供」。明确为空或不适用，与接口没有提供必要信息是两种情况。

- 已知某项不同，可以判定严格不一致；
- 尚未发现差异，但必要信息缺失，只能显示「无法确认严格一致」；
- 无法判断兼容所需的诊断对应或附加诊断类别时，也不能判为兼容；
- 采集失败与明确没有诊断分别记录，不能把失败输出当作零诊断。

API 或批量接口可以直接提供范围、消息链等结构化信息；CLI 文本解析需要检查能否取得对应信息。

### 11.4 记录与回归

每条回归要求包含候选、参考配置、固定用例和保护档。
本次完整结果另行保存，不按门禁档截断记录，也不因更新记录而抹去之前的差异。

| 前后结果 | 回归识别 |
| --- | --- |
| 兼容通过 → 不兼容或无法完成比较 | 兼容性回归 |
| 严格一致 → 仅兼容或无法确认严格一致 | 严格一致性回归 |
| 某个已验证相同的差异项变为不同或未提供 | 对应差异项的回归 |

报告记录回归及其具体原因。门禁按维护者选择的保护档判定：
保护兼容时，兼容性回归失败；保护严格一致时，严格一致性回归也失败。
因此「严格一致退到仅兼容」始终是回归，但不同保护档可以有不同的门禁结果。

更新参考版本、测试范围或保护档时，审阅变化并明确更新基准。
已纳入回归的用例要继续检查，未完成或被移出执行范围时需给出处理记录。
