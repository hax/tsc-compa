# 公开报告站点

[`index.html`](index.html)、[`styles.css`](styles.css) 和 [`app.js`](app.js) 提供静态浏览界面；
[`catalog.js`](catalog.js) 负责校验目录与报告索引、筛选结果及解析分享链接。站点只展示已发布的结果，不启动评测。

公开数据不存放在本目录，部署时由[发布工作流](../.github/workflows/publish-public-reports.yml)从
`public-report-data` 取回。改页面资源时核对发布清单；改目录结构或链接时同步检查
[目录测试](../test/site-catalog.test.js)与[发布校验](../scripts/stage-public-reports.ts)。
