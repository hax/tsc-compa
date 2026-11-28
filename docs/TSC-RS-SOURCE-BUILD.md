# 准备 tsc-rs v0.1.0 源码构建工件

维护者可用 [`tsc-rs-source-build.ts`](../scripts/tsc-rs-source-build.ts) 为 [#26](https://github.com/hax/tsc-compa/issues/26)
准备可核对的工件。这是本仓从上游正式标签构建的二进制，不是上游发布的二进制。
脚本不运行候选、不上传工件、不调用公开工作流，也不改变现有冒烟版本或报告。

## 构建与隔离

只在一次性的原生 Linux x64 构建机上以非 root 用户运行。需要本地 Unix socket 上可用的 Docker；
不要在持有发布凭据的机器上运行。先独立核对官方 Rust 1.93.0 构建镜像及其 `linux/amd64` 清单的摘要，
将 `RUST_IMAGE` 设置为已核对的 `docker.io/library/rust@sha256:…`，不能用可变标签。

```sh
bun scripts/tsc-rs-source-build.ts build "$OUT" "$RUST_IMAGE"
sha256sum "$OUT/compiler/tsc-rs" "$OUT/provenance.json"
```

`OUT` 必须不存在。脚本先核对 `v0.1.0` 标签对象、标签指向的提交、源码树、`Cargo.lock` 和工具链文件；
再用 Rust 1.93.0 按锁文件取依赖。构建使用 `cargo build --release --frozen` 和上游的
`crates/compiler/Cargo.toml`，在断网容器中进行。容器以非 root 用户运行，只挂载暂存输入和明确的输出目录，
不挂载宿主工作树、Docker socket 或用户配置；不传入 GitHub、Cargo 或发布凭据。最终目录只有 `provenance.json`
和去掉执行位的 `compiler/tsc-rs`。该隔离不替代对构建机或 Docker 服务的信任。

## 从构建证据到候选发布

在独立的只读构建中核对可执行文件和来源记录是否复现。将审核通过的镜像、可执行文件和来源文件摘要
保存在工件之外。验证时不要从待验证目录读取「期望摘要」：

```sh
bun scripts/tsc-rs-source-build.ts verify "$OUT" "$RUST_IMAGE" "$EXE_SHA256" "$PROVENANCE_SHA256"
```

来源文件记录标签、提交、源码树、锁文件、配方、镜像、Rust/Cargo 身份、可执行文件和分发目录摘要。
这是构建记录，不是签名或发布授权。若独立构建产物不一致，先找出差异，不用同一个摘要代指不同产物。
公开评测接入前还需在隔离环境验证 `Version 6.0.3`、嵌入标准库和生成项目配置的调用方式，记录分片实际加载的
动态库摘要，并让所有分片消费同一份已验证的工件。已有 TS 7.1.0-beta 官方参考配置保持不变；
该发行版的公开评测将是跨版本对照，不代表 #26 已修复。
