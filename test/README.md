# 自动化测试

在仓库根目录运行 `bun install --frozen-lockfile` 和 `bun test ./test`，也可单跑某个测试文件。

- [`baseline-pins.test.ts`](baseline-pins.test.ts) 核对官方测试集引用与已安装的参考编译器；[`case.test.ts`](case.test.ts) 和 [`comparison.test.ts`](comparison.test.ts) 覆盖用例与诊断比较规则。
- [`run-gate.test.ts`](run-gate.test.ts)、[`report.test.ts`](report.test.ts) 等覆盖门禁和报告；[`public-evaluation.test.ts`](public-evaluation.test.ts) 与 [`site-catalog.test.js`](site-catalog.test.js) 覆盖公开评测与站点目录。
- 本地小型输入放在[测试样本目录](fixtures/README.md)或测试代码内；上游测试集由[工作流](../.github/workflows/README.md)按固定引用另行检出，不复制到这里。

修改行为时，在对应测试中增加能复现的断言，既检查正常结果，也检查失败与跳过是否被正确区分。
