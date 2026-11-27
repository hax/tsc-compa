# tsrs async 候选的隔离安装

这里只为 `--adapter tsrs-async` 安装依赖，不影响仓库根的依赖或公开评测使用的 tsrs CLI。
`package.json` 固定 SDK 版本；`bun.lock` 记录 SDK 与各平台原生包（含声明库）的版本和 npm tarball 完整性。

用 Bun 1.4.5 在仓库根运行：

```sh
test -f config/tsrs-async/bun.lock && \
  bun install --cwd config/tsrs-async --frozen-lockfile --registry=https://registry.npmjs.org
```

先检查锁文件存在：Bun 1.4.5 在没有锁文件时仍可能完成安装。
升级候选时同时提交 `package.json` 和 `bun.lock`，并重新运行
[TS7 冒烟和固定样本](../../docs/RESULTS.md#tsrs-async-候选试验2026-11-27)。
