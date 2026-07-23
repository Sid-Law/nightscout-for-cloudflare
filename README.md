# NSCF — Nightscout for Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sid-Law/nscf)

NSCF 是把官方 [Nightscout](https://github.com/nightscout/cgm-remote-monitor)
移植到 Cloudflare Workers 的独立开源项目。目标是让普通糖友家庭不必维护
Node.js、MongoDB 和服务器，也能在 Cloudflare 免费套餐上使用尽可能接近官方
Nightscout 的功能。

当前版本：**NSCF v1.0.0-beta.1**

锁定上游：**Nightscout v15.0.7**

NSCF 使用官方 Nightscout 页面、布局、图表、插件、翻译和计算逻辑，没有另外
制作一套替代 UI。Cloudflare 相关代码只负责替换原来的 Node.js、Express、
MongoDB、Socket.IO 服务端和后台任务运行环境。

> 当前版本适合新建测试实例和模拟数据体验，还不是“官方 Nightscout 所有能力
> 100% 等价”的稳定版本。它不是医疗设备，不能代替医生或用于自动决定胰岛素
> 剂量。

## 现在已经能做什么

### 官方页面

- Nightscout 首页、血糖曲线、趋势箭头和状态信息
- Profile Editor
- Food Editor
- Admin Tools
- Reports
- Split、多画面和 Clock 页面
- v1 与 v3 Swagger API 文档
- Nightscout v15.0.7 自带的翻译和前端插件

### 数据和 API

- SQLite Durable Object 持久化，不需要 MongoDB、D1 或 R2
- Entries、Treatments、Device Status、Profile、Food、Settings 和 Activity
- Nightscout API v1、v2 以及 v3 的主要读写流程
- 常见 AAPS、AndroidAPS 和 Loop 上传数据形状的契约测试
- ObjectId、UUID、去重、批量写入、排序、时间范围、历史记录和软删除
- JSON，以及已实现接口所需的 CSV、TSV、XML 表示
- Profile 的时区、基础率、碳水比、敏感系数、目标范围和历史 Profile 计算

### 登录和权限

- 用户在部署时自行设置 `API_SECRET`
- 官方 Nightscout 网页认证
- “Remember this device”
- Subjects、Roles、访问令牌和 API v3 JWT
- Admin 页面常用的角色、数据清理和管理流程

### 实时更新

- Engine.IO 3 和 Engine.IO 4
- Socket.IO polling 和 WebSocket
- 首页实时 `dataUpdate`
- API v3 `/storage` 实时事件
- `/alarm` 通知、确认和静音状态
- Durable Object 被回收后仍可恢复的会话、心跳和待发送队列

### 插件和后台任务

常用状态及通知适配已经包括 IOB、COB、Loop、OpenAPS、Pump、Uploader
Battery、CAGE、SAGE、IAGE、BAGE、Timeago、Simple Alarm、Treatment
Notify、Dexcom Error Codes、xDrip-js 和 DBSize 等。

Node.js 中依赖常驻进程的定时器已经改为 Durable Object alarms，因此不依赖
Worker 一直在线。

### 测试用模拟血糖

NSCF 提供一个仅用于测试的模拟 CGM 开关。启用后会先生成一小段五分钟间隔的
血糖曲线，之后每五分钟继续增加一条。它不会连接真实 CGM，也不会计算剂量。

## 目前还没有做到什么

以下是当前版本与“完整官方 Nightscout 等价”之间的明确差距：

- 尚未由用户使用真实 AAPS/Loop 和真实设备完成最终闭环兼容验收
- 没有现成的 MongoDB 历史数据库导入工具；当前优先服务新建实例
- MongoDB 的任意查询语法、无限制正则表达式、聚合管线和所有混合类型行为，
  只实现了 Nightscout 常用且经过契约测试的部分
- 不支持一次请求读取或上传无限量数据；Cloudflare 免费套餐下设置了批量、
  请求体和查询结果上限
- Engine.IO 的二进制数据包尚未适配；普通 Nightscout JSON 数据和页面实时
  更新不依赖它
- 仍有少量依赖 Node.js 动态 `require`、文件系统或常驻进程的服务端插件，
  不能原样运行，需要继续逐个适配
- 一些非核心第三方推送或语音助手集成尚未启用
- 还没有完成公开仓库的一键部署实测和面向正式用户的安全加固审查

这些限制不会被“页面能打开”掩盖。详细的接口和上游契约状态见
[兼容性矩阵](docs/UPSTREAM_COMPATIBILITY.md)。

## 适合谁

当前优先面向：

- 第一次部署 Nightscout 的糖友和糖宝家长
- 希望先免费使用首页、曲线、记录、Profile、Admin 和常见上传 API 的家庭
- 不需要导入多年 MongoDB 历史数据的用户
- 愿意先以测试实例验证 AAPS/Loop 连接的用户

如果必须保留旧 Nightscout 的多年历史、依赖未适配的特殊插件，或者现在就要求
生产环境完全等价，请暂时保留原来的 Nightscout。

## 一键部署

Cloudflare 的 Deploy 按钮只能读取公开的 GitHub/GitLab 仓库。因此，本仓库
公开后才能由普通用户使用页面顶部的一键部署按钮。

部署时只需要用户决定一个设置：

> 设置自己的 Nightscout 访问密码 `API_SECRET`，至少 12 个字符。

这是用户自己定义的明文密码，不需要先计算 SHA-1。部署完成后，在 Nightscout
网页、AAPS 或其他数据源中填写同一个密码。

Cloudflare 会创建：

1. 一个 Worker；
2. 一份 Workers Static Assets；
3. 一个 SQLite Durable Object 命名空间；
4. 一个加密的 `API_SECRET`。

项目不会创建 D1、R2、KV、Queues、自定义域名或真实 CGM 连接。

完整步骤见 [部署指南](docs/DEPLOYMENT.md)。

## 第一次打开

空数据库第一次访问首页时会跳转到 `/profile/`，这是官方 Nightscout 的正常
行为，不是保存故障。

1. 滚动到 Profile Editor 底部，选择 **(Authenticate)**。
2. 输入部署时自己设置的 `API_SECRET`。
3. 在自己的设备上勾选 **Remember this device**。
4. 点击 **Authenticate**。
5. 默认的 `Default` Profile 和 `UTC` 时区可以直接保存；也可以先改成自己的
   名称、时区和单位。
6. 点击 **Save**，看到 `Status: success` 后返回首页。

如果关闭 Profile Editor 后又被送回来，优先检查页面底部是否仍显示
`Unauthorized`。这通常表示还没有成功认证，并不是缺少某个必须填写的
Profile 字段，也不是 Cloudflare 无法保存。

## 本地开发

建议使用 Node.js 22 LTS 或更新版本。

```sh
npm install
cp .dev.vars.example .dev.vars
```

在 `.dev.vars` 中填写本地测试密码：

```dotenv
API_SECRET=choose-your-own-password
```

然后运行：

```sh
npm run build
npm run check
npm test
npm run dev
```

打开 <http://localhost:8787/>。

部署前执行：

```sh
npm run build
npm run check
npm test
npm run deploy:dry
```

确认全部通过后再执行：

```sh
npm run deploy
```

## 项目边界

- 官方源码版本和校验信息记录在 `upstream/manifest.json`
- 未修改的 Nightscout v15.0.7 快照位于 `vendor/nightscout`
- Cloudflare 适配层位于 `src`、`platform` 和 `scripts`
- 不增加医疗算法，不提供剂量建议
- 当前公开测试只使用模拟数据

开发者文档：

- [部署与首次使用](docs/DEPLOYMENT.md)
- [上游兼容性矩阵](docs/UPSTREAM_COMPATIBILITY.md)
- [Cloudflare 架构](docs/ARCHITECTURE.md)
- [后续实现计划](docs/EXECUTION_PLAN.md)

## License and attribution

NSCF 使用 `AGPL-3.0-only`。Nightscout 上游工作的权利归原贡献者所有。参见
`LICENSE`、`NOTICE.md`，以及保留的
`vendor/nightscout/COPYRIGHT` 和 `vendor/nightscout/LICENSE`。
