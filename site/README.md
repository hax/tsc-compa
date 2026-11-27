# 公开报告站点

[`index.html`](index.html)、[`styles.css`](styles.css) 和 [`app.js`](app.js) 提供静态浏览界面；
[`catalog.js`](catalog.js) 负责校验目录与报告索引、筛选结果及解析分享链接。站点只展示已发布的结果，不启动评测。

公开数据不存放在本目录，部署时由[发布工作流](../.github/workflows/publish-public-reports.yml)从
`public-report-data` 取回。改页面资源时核对发布清单；改目录结构或链接时同步检查
[目录测试](../test/site-catalog.test.js)与[发布校验](../scripts/stage-public-reports.ts)。

## 更新首页候选资料

[`candidate-overview.json`](candidate-overview.json) 是经人工核对的上游资料快照，不用于配置或触发评测。
新增公开配置时核对候选 ID、版本、参考配置和测试集是否与公开目录一致。首页从报告索引读取该组合最近发布的
全量报告及兼容性计数；不要把计数或报告地址抄进快照。

刷新资料时用 npm registry 完整包元数据的 `time[version]` 记录 npm 发布时间。GitHub 的发布时间取
Release `published_at`；先查标签引用，只有附注标签才记录标签对象的 `tagger.date`，轻量标签的
`taggerDate` 保持 `null`。标签目标和默认分支 HEAD 的提交时间都用 `commit.committer.date`。
保留精确 UTC 时间戳，核对后更新 `asOf`。默认分支 HEAD 不替代测试使用的包、标签或源码提交。
浏览器只读取随站点部署的快照，不调用上游 API。

核对命令示例（先为待查版本设置 `pkg`、`version`、`repo` 和 `tag`）：

```sh
curl -fsSL --compressed "https://registry.npmjs.org/$pkg" |
  jq --arg v "$version" '{publishedAt: .time[$v], gitHead: .versions[$v].gitHead}'
gh api "repos/$repo/releases/tags/$tag" --jq .published_at
gh api "repos/$repo/git/ref/tags/$tag" --jq .object
# 若上一步返回 type=tag，用标签对象的 SHA 查标签时间和目标；若为 commit，直接查提交。
gh api "repos/$repo/git/tags/$tag_object_sha" --jq '{taggerDate: .tagger.date, target: .object}'
gh api "repos/$repo/commits/$target_sha" --jq '{sha, committedAt: .commit.committer.date}'
branch=$(gh api "repos/$repo" --jq .default_branch)
gh api "repos/$repo/commits/$branch" --jq '{sha, committedAt: .commit.committer.date}'
```

`tsrs` 包没有 `gitHead`；源码提交单独查 npm SLSA 构建来源证明的
`predicate.buildDefinition.resolvedDependencies`。只把证明中记录的依赖提交记作 `slsaCommit`，不填为 `gitHead`。

```sh
curl -fsSL --compressed "https://registry.npmjs.org/-/npm/v1/attestations/tsrs@0.25.0-ts7.1.0-beta" |
  jq '.attestations[] | select(.predicateType | contains("slsa")) |
    .bundle.dsseEnvelope.payload | @base64d | fromjson | .predicate.buildDefinition.resolvedDependencies'
```
