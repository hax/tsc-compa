# 检查器适配器

[`index.ts`](index.ts) 根据运行参数创建适配器。适配器负责调用检查器并把执行结果整理成
[`Adapter` 接口](../types.ts)约定的类型；诊断比较和门禁由[运行器](../README.md)负责。

- [`tsc-cli.ts`](tsc-cli.ts) 和 [`bun-check.ts`](bun-check.ts) 分别驱动兼容 tsc 的 CLI 与 Bun 内置检查器；[`ts7-api.ts`](ts7-api.ts) 从 TypeScript 7 的异步 API 采集结构化诊断。
- [`cli.ts`](cli.ts)、[`checker-cli.ts`](checker-cli.ts) 支持其他逐案 CLI；[`batch.ts`](batch.ts) 实现批量协议客户端，[`mock-batch.ts`](mock-batch.ts) 用于验证协议，不是真实检查器。

新增或修改适配器时，按[技术参考](../../docs/REFERENCE.md)声明选项支持范围，测试失败、跳过和正常返回；
不能把未提供的诊断字段补成已验证结果。
