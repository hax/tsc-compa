# 测试样本

这里保存测试直接读取的小型固定输入。[`tsz-extended-diagnostics.txt`](tsz-extended-diagnostics.txt)
供 [`tsc-cli.test.ts`](../tsc-cli.test.ts) 验证如何区分统计输出与诊断，不是兼容性评测结果。

[`batch-options-worker.ts`](batch-options-worker.ts) 是批量协议的合成进程，供
[`batch-options-contract.test.ts`](../batch-options-contract.test.ts) 测试；协商接入时可复用[验收用例](batch-options-acceptance.md)。

新增或修改样本时注明读取它的测试及要覆盖的行为，只保留测试所需的内容。
上游测试集、临时输出和完整运行报告不放在这里。
