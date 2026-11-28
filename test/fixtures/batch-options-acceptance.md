# 批量选项协商：验收用例

[`batch-options-worker.ts`](batch-options-worker.ts) 是合成 NDJSON 进程，不是 TypeScript 实现。
[`batch-options-contract.test.ts`](../batch-options-contract.test.ts) 已核对消息、逐案选项切换，以及当前运行器的旧版 `official` / `fixed` 行为。下表列出可复用的断言。`BatchAdapter` 已有消费者测试；报告和门禁接入仍是后续运行器验收。

从仓库根目录运行 `bun test ./test/batch-options-contract.test.ts`。适配器测试可用 `process.execPath` 启动 `[workerPath, mode, "--batch"]`，按表依次 `check`；运行器测试可复用临时可执行包装，调用导出的 `runWorker(mode)`。请求继续使用 `options: [{name, value}]` 和 `args: string[]`，用同一进程连续跑同一段源文本。协商使用顶层或嵌套 `capabilities`，能力的 `version` 与可选的 `implementation.version` 分开。
客户端校验 v1 `args` 中已知、规范拼写的 `--name value` 分离 token，布尔量还接受裸 `--name`；
不推测短别名、大小写变体、`--name=value`、响应文件或位置参数，也不改写已经发送的参数。
结构化拒绝只接受 `skip` 或 `error` 搭配 `unsupportedOption` / `unsupported-option` 或 `unsupportedValue` / `unsupported-value`。
已知选项的字符串值原样交给 checker，不按较旧 TypeScript 的枚举限制。

| 测试模式 | 请求或事件 | 验收断言 |
| --- | --- | --- |
| `legacy` | 不发 `hello`；正常回答原有 `check` | 不发送新探测帧，不把 `options` 数组换成对象；选项支持未声明，行为不变。 |
| `hello` | 子进程首次主动声明；同一进程序列 `strict=true → false → true`，`target=es2015 → es2020 → es2015` | 能力冻结；诊断码依次为 `2322 / 无 / 2322`、`2737 / 无 / 2737`，请求之间不继承设置。 |
| `first-result` | 仅首个配对正常结果附能力，之后省略 | 首案在交给诊断比较前按新声明复核；后续仍用同一声明，也出现上述两组诊断变化。只在校验协议、结果形态、在途 ID 和截止时间之后冻结，不在进程刚启动时认定不支持。 |
| `bad-ok` | 首案请求未声明的 `module=esnext`，配对响应却为 `ok + []` | 首案不能进比较、通过数或诊断分母；保留配置 ID、原始请求参数、选项名和值，说明实现没有按协议拒绝。下一条受支持请求仍可比较。 |
| `first-result` 拒绝路径 | `args` 里的继承参数 `module=esnext`、`skipLibCheck=false`，结构化 `skipDefaultLibCheck=true`，以及已声明 `target` 的不支持值 `es5` | 识别明确拒绝并保存结构化原因；即使 `options` 没有某个继承项，也不得把它丢掉。`skipLibCheck`、`skipDefaultLibCheck` 都影响诊断，不能当成中性旗标。保留输入中的显式 `false`，不要删选项重试或隐去配置。 |
| `unknown-code` / `wrong-status` | 未列入认可清单的 `errorCode`，或已知码出现在 `status: ok` | 只有显式列入认可清单的码及协议认可的状态组合才能分类为选项拒绝；不能靠相近拼写、消息文本或非空码推断。不合法的组合也不得进入比较或算作干净通过。 |
| `unmatched` / `late` / `changed` | 未匹配 ID 声明；首案超时后在下一请求到达时补发；成功协商后改变白名单 | 未匹配和超时响应不得改变能力或影响另一案。冲突声明不得扩大已冻结范围；若允许重复，规范化后须完全相同。超时应留在执行失败分类。 |
| 运行器 `official` / `fixed` | 旧版用例带 `@strict: false`；另以已协商实现复用同一测试集 | `official` 使用用例指令；`fixed` 不用该指令且始终仅供报告。已协商实现必须真正支持选定 preset 才能声称候选应用了它；不支持的项显式留在明细。 |
| 报告和门禁 | 已协商 checker 仅提供 `file/line/col/code/severity`；一次选中范围混有可比较案与选项拒绝 | 实际结构化诊断支持兼容档；声明字段不补齐缺失的 `message` / `fullText`，严格档仍依据实际证据。报告明确比较范围；自报协商不授权门禁、回归记录写回或公开评测，选项拒绝也不能让门禁因少跑而通过。 |
