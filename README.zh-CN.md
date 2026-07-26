# Nightscout for Cloudflare

[English](README.md) | **简体中文**

昵称：**Nightscout 泡面版**（The Instant Noodle Edition）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sid-Law/nightscout-for-cloudflare)

这个仓库提供一种快速、免费的方式，把
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) 部署到
Cloudflare。它在 Cloudflare 免费套餐额度内运行，不需要付费服务器或
MongoDB 服务。它是独立的非官方移植版，不是 Nightscout 官方发布。

当前版本：**v1.0.0-beta.1**

锁定上游：**Nightscout v15.0.7**

本项目保留官方 Nightscout 的页面、布局、图表、插件、翻译和计算逻辑，只增加
Cloudflare 平台适配层。

## 为什么做这个项目

Nightscout 是一个很伟大的项目，我们曾经可以在 Heroku 免费部署，那已经是
很久以前的事情了。而 Cloudflare 堪称赛博大善人，但它并不支持 MongoDB。

Nightscout 已经提供了非常好的泡面，但是没有叉子和开水（曾经有）。这个项目
提供了一把叉子，并且把开水（Cloudflare）递到你面前。只需要点击几下，一个
泡面的时间，你就可以得到一个 Nightscout。

## 现在已经能做什么

- Nightscout 绝大部分常用功能已经实现
- 首页、血糖曲线、趋势箭头、状态信息和设置页面可以正常使用
- v1、v2、v3 的常用读写 API 已经实现
- Dexcom Share（Beta）协议和模拟服务测试已经完成，真实账号社区验收尚未完成，
  默认关闭

## 目前还没有做到什么

- 暂不支持把现有 Nightscout/MongoDB 历史数据直接迁移进来；当前更适合新建
  实例。
- [SQLite Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  目前包含 5 GB 总存储，并有每天 100,000 次 Durable Object 请求、5,000,000
  行读取和 100,000 行写入额度。若只按每条血糖约 1 KB 粗略计算，5 GB 约等于
  17,000 天、接近 48 年的血糖记录，所以没办法保存超过 48 年的血糖记录。
- 还有少量比较冷门的接口、MongoDB 边缘查询和第三方功能暂未适配。

即便如此，当前版本已经可以满足大部分 Nightscout 日常使用需求。

## 一键部署与第一次打开

教程占位，稍后补充。

## 技术文档

- [Cloudflare 架构](docs/ARCHITECTURE.md)
- [上游兼容性矩阵](docs/UPSTREAM_COMPATIBILITY.md)

## License and attribution

这个项目使用 `AGPL-3.0-only`。Nightscout 上游工作的权利归原贡献者所有。参见
`LICENSE`、`NOTICE.md`，以及保留的
`vendor/nightscout/COPYRIGHT` 和 `vendor/nightscout/LICENSE`。
