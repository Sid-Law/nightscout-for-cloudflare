# Nightscout for Cloudflare

[English](README.md) | **简体中文**

昵称：**Nightscout 泡面版**（The Instant Noodle Edition）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

这个仓库提供一种快速、免费的方式，把
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) 部署到
Cloudflare。它在 Cloudflare 免费套餐额度内运行，不需要付费服务器或
MongoDB 服务。它是独立的非官方移植版，不是 Nightscout 官方发布。

当前 Nightscout for Cloudflare 版本：**1.1.1-beta**

Nightscout 上游版本：**15.0.7**

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

## Nightscout 与 Nightscout for Cloudflare

Nightscout for Cloudflare 是 Nightscout 的独立、非官方 Cloudflare
移植版本。Nightscout 上游版本和移植版本使用各自独立的版本号：

- Nightscout 上游版本：**15.0.7**
- Nightscout for Cloudflare 版本：**1.1.1-beta**

原版 Admin Tools 的对应功能仍然保留，但本项目使用 SQLite Durable Objects
存储数据，而不是 MongoDB。因此，页面中的部分名称会调整为与实际存储方式无关
的名称，避免用户误以为部署中仍然存在 MongoDB。

| 原版 Nightscout 名称 | Nightscout for Cloudflare 名称 |
| --- | --- |
| Clean Mongo status database | Device status maintenance（设备状态维护） |
| Clean Mongo treatments database | Treatment records maintenance（治疗记录维护） |
| Clean Mongo entries (glucose entries) database | Glucose entries maintenance（血糖记录维护） |
| Remove future items from mongo database | Future-dated records maintenance（未来时间记录维护） |

## 一键部署与便捷更新

第一次安装仍然使用本页顶部的 **Deploy to Cloudflare** 按钮。Cloudflare 会在
用户账号中创建一个私有 Git 仓库，将它连接到新 Worker，然后完成部署。

以后更新时，直接使用现有 Worker 的 Cloudflare 构建：

1. 在 Cloudflare Dashboard 中打开自己的 Worker。
2. 进入 **Deployments（部署）**，点击 **View build history（查看构建记录）**。
3. 打开最近一次成功构建，点击 **Retry build（重新构建）**。

构建程序会在 Cloudflare 的临时构建环境中拉取官方最新版，保留原 Worker 名称
和明文 `API_SECRET`，然后部署到同一个 Worker。它不会修改用户的 GitHub 仓库，
也不会替换 Durable Object 存储。如果下载、安装、构建或部署失败，Cloudflare
会继续保留之前正在运行的版本。

自动拉取只对 Deploy to Cloudflare 创建的单提交仓库启用。如果用户自己增加了
Git 提交，构建会尊重用户修改，不再自动替换源码。只有明确希望忽略自定义提交时，
才在构建变量中设置 `NSCF_AUTO_UPDATE=1`。

在这个构建更新器加入前创建的旧副本，需要最后重新部署一次或手动初始化；
之后更新都使用 **Retry build（重新构建）**。

## 技术文档

- [部署与首次使用](docs/DEPLOYMENT.zh-CN.md)
- [Cloudflare 架构](docs/ARCHITECTURE.md)
- [上游兼容性矩阵](docs/UPSTREAM_COMPATIBILITY.md)

## License and attribution

这个项目使用 `AGPL-3.0-only`。Nightscout 上游工作的权利归原贡献者所有。参见
`LICENSE`、`NOTICE.md`，以及保留的
`vendor/nightscout/COPYRIGHT` 和 `vendor/nightscout/LICENSE`。
