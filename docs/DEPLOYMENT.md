# NSCF 部署与首次使用

本文只说明当前版本如何部署、如何验证以及已知限制。开发过程和每一轮版本记录
由 Git 历史保存，不再堆放在用户文档中。

## 当前发布状态

- NSCF 版本：`1.0.0-beta.1`
- Nightscout 上游：`v15.0.7`
- 部署平台：Cloudflare Workers Free
- 存储：SQLite Durable Object
- 页面：官方 Nightscout 页面
- 数据：当前公开测试只使用模拟数据
- 发布状态：适合新建实例测试，尚未宣称完整上游等价或正式生产可用

已经在全新的 Cloudflare 账号上验证过源码部署、Profile 保存、Admin 登录、
模拟血糖、官方首页图表以及远程 API/实时协议测试。还需要在仓库公开后完成一次
普通用户点击 Deploy 按钮的完整验收，并由用户完成真实 AAPS/Loop 测试。

## Cloudflare 会创建什么

一次 NSCF 部署只使用：

1. 一个 Cloudflare Worker；
2. 一份 Workers Static Assets；
3. 一个 SQLite Durable Object 命名空间；
4. 两个保存相同密码的加密 Worker Secret：`API_SECRET` 和
   `API_SECRET_CONFIRM`。

不会创建 D1、R2、KV、Queues、自定义域名或 Cloudflare Zone 路由。

## 一键部署

Cloudflare 的 Deploy to Cloudflare 功能要求源仓库是公开仓库。仓库公开后，点击
项目 README 顶部的按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sid-Law/nightscout-for-cloudflare)

部署页面会要求把同一个密码填写两次：

### `API_SECRET`

这是每个家庭自己设置的 Nightscout 访问密码。

- 至少 12 个字符
- 直接填写明文密码
- 不需要自己计算 SHA-1 或 SHA-512
- 部署后在 Nightscout 网页、AAPS 或其他数据源中使用同一密码
- 密码不会写入 Git 仓库

### `API_SECRET_CONFIRM`

这是部署时的重复确认项：

- 再次输入与 `API_SECRET` 完全相同的明文密码
- Nightscout 客户端、AAPS 和其他上传端不需要填写这个名字
- 如果两次输入不同，Worker 会返回明确的中英文配置错误
- Cloudflare 会把两个值都隐藏，因此部署后不会在 Dashboard 中回显密码

用户可以在部署页面调整 GitHub 仓库副本名称、Worker 名称和资源名称。完成授权
后，Cloudflare 会构建源码、创建声明的资源并部署 Worker。

Cloudflare 官方说明：

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Deploy 按钮支持环境变量和 Secrets](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/)

## 第一次打开

全新实例没有 Profile。第一次打开首页时自动跳转到 `/profile/` 是官方
Nightscout 的正常流程。

1. 滚动到 Profile Editor 底部。
2. 点击 **(Authenticate)**。
3. 输入部署时设置的 `API_SECRET`。
4. 在自己的设备上勾选 **Remember this device**。
5. 点击 **Authenticate**。
6. 根据需要修改名称、时区和单位。默认 `Default` 与 `UTC` 也可以直接保存。
7. 点击 **Save**。
8. 确认页面显示 `Status: success`，然后返回首页。

如果关闭 Profile Editor 后又回到同一页面：

- 检查底部是否仍显示 `Unauthorized`
- 确认输入的是部署时设置的原始密码
- 确认密码没有多余的前后空格
- 重新点击 **Authenticate**，成功后再点 **Save**

这通常是认证未完成，不是 Profile 必填字段缺失，也不是 Cloudflare
Durable Object 无法保存。

## 修改 API_SECRET

用户以后可以自行修改：

1. 打开 Cloudflare Dashboard。
2. 进入 **Workers & Pages**。
3. 选择自己的 NSCF Worker。
4. 打开 **Settings → Variables and Secrets**。
5. 编辑 `API_SECRET`，类型保持为 **Secret**。
6. 把 `API_SECRET_CONFIRM` 改成完全相同的新密码，类型也保持为 **Secret**。
7. 保存并等待新版本部署完成。
8. 在 Nightscout 网页、AAPS 和其他上传端改成同一新密码。

CLI 方式：

```sh
npx wrangler secret put API_SECRET
npx wrangler secret put API_SECRET_CONFIRM
```

两条命令中输入完全相同的值。

## 本地或命令行部署

建议使用 Node.js 22 LTS 或更新版本。

```sh
git clone https://github.com/Sid-Law/nightscout-for-cloudflare.git
cd nscf
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
```

登录 Cloudflare 并设置密码：

```sh
npx wrangler login
npx wrangler secret put API_SECRET
npx wrangler secret put API_SECRET_CONFIRM
```

两次输入同一个密码。

确认本地测试全部通过后部署：

```sh
npm run deploy
```

本地开发时复制示例文件：

```sh
cp .dev.vars.example .dev.vars
```

然后在 `.dev.vars` 中填写本地测试密码：

```dotenv
API_SECRET=choose-your-own-password
API_SECRET_CONFIRM=choose-your-own-password
```

启动：

```sh
npm run dev
```

打开 <http://localhost:8787/>。

## 部署后检查

### 普通页面

- `/healthz` 返回正常状态和 Nightscout `v15.0.7`
- `/profile/` 能认证并保存 Profile
- `/admin/` 在记住认证后能加载角色和管理工具
- `/food/` 能打开并完成一条测试记录的创建和删除
- `/report/` 能打开报告页面
- 首页能显示当前模拟血糖、趋势箭头和曲线

### API

- v1 Status 和 Entries 读取正常
- v2 Status、Properties 和 Summary 读取正常
- v3 能取得 JWT，并对所需集合完成授权读写
- EIO3/EIO4 polling、WebSocket 和实时 `dataUpdate` 正常

项目自带的远程检查命令：

```sh
npm run smoke:public -- https://your-worker.workers.dev
```

不要只以“页面能打开”作为兼容完成的证据。API、授权、实时连接和持久化必须分别
检查。

## AAPS 或 Loop 验收

当前代码已经覆盖常见 AAPS、AndroidAPS 和 Loop 数据形状与协议契约，但正式
发布前仍需要用户在自己的测试环境完成真实客户端验收。

建议先做最小测试：

1. 在客户端填写新的 NSCF 地址和自己设置的 `API_SECRET`。
2. 只启用数据上传，不立即改变现有治疗或闭环设置。
3. 确认最新血糖、Device Status 和 Treatments 出现在 NSCF。
4. 确认时间、时区、单位、Profile 和趋势一致。
5. 确认断网后恢复上传不会丢失或错误重复普通记录。
6. 完成观察后再决定是否进入更完整的闭环兼容测试。

NSCF 不新增剂量算法，也不修改客户端的治疗逻辑。

## 当前限制

- 不提供旧 MongoDB 多年历史数据的一键迁移
- 任意 Mongo 查询和无限量读取不保证兼容
- API 和批量写入有适合 Workers Free 的明确上限
- Engine.IO 二进制包尚未适配
- 少量 Node.js 动态服务端插件和第三方集成仍待适配
- 公开 Deploy 按钮和真实闭环设备仍待最终用户验收
- 当前 beta 不应承载正式医疗数据

完整差距见 [UPSTREAM_COMPATIBILITY.md](UPSTREAM_COMPATIBILITY.md)。

## 删除和重新测试

删除 Worker 不一定等于已经明确删除对应 Durable Object 命名空间中的全部存储
数据。若要验证完全干净的新用户流程，最简单可靠的方法是：

- 使用新的 Cloudflare 测试账号；或
- 使用新的 Worker 和 Durable Object 命名空间名称。

通过 Durable Object migration 删除类命名空间会永久删除其中的数据，只有在
确认不再需要任何内容时才应执行。参见 Cloudflare 的
[Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。

## 更新

更新代码前先备份或保留现有实例，然后：

```sh
git pull
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy
```

普通 Wrangler 部署不会把已经保存的加密 `API_SECRET` 写回仓库。部署后仍应
重新执行页面和 API 检查。
