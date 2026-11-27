# TS6／TS7 版本差异探针

这里的短 TypeScript 用例用于观察同一组显式选项下的版本差异。[`manifest.json`](manifest.json)
记录上游用例、固定提交、附加选项及两个参考版本的诊断指纹；探针 ID 对应同名 `.ts` 文件。

运行 `bun run probes:versions` 校准两个官方参考版本；候选复现命令和结果解释见
[CI 使用说明](../../docs/CI.md#ts6--ts7-版本差异探针version-probesyml)。这组探针不替代冒烟或全量评测，
也不用于推断整个检查器的兼容性。增改样本时更新来源和指纹，并用两个固定参考版本复核。
