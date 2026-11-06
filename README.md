# Telegram Metadata Bot

[![中文](https://img.shields.io/badge/阅读中文-README.md-1677ff?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-555?style=flat-square)](README.en.md)

**我自用的 Telegram Bot，用于中日文文本元数据检索。** 在私聊中通过番号或关键词查询、筛选和浏览结果，并查看简要详情。

本仓库保存自用 Bot 的实现与部署说明。面向成年人，首次查询前需要确认年龄，仅返回文本元数据，不提供视频、预览、下载或媒体链接。

JavInfo 适配器会校验已记录的 `/query`、`/movie` 和 `/profile` 接口响应。已核实的 API 契约和仍待审查的来源链接条款见 [`docs/source.md`](docs/source.md)。

## 本地开发

需要 Node.js 24、Corepack（pnpm 10.32.1）和 Docker。

1. 将 BotFather token 保存在 `.env` 中，格式为 `BOT_TOKEN=...`。该文件已被 Git 忽略，权限应保持为 `600`。
2. 使用 `nvm use 24` 切换到 Node.js 24。
3. 执行 `docker compose -f infra/compose.local.yml up -d` 启动独立 PostgreSQL 测试数据库。
4. 依次执行 `corepack pnpm@10.32.1 install`、`corepack pnpm@10.32.1 db:generate` 和 `corepack pnpm@10.32.1 exec prisma migrate dev`。未设置 `DATABASE_URL` 时，Prisma 默认连接端口为 `15456` 的独立本地测试数据库。
5. 执行 `corepack pnpm@10.32.1 dev`。开发环境使用长轮询，不注册 webhook。

在 `.env.local` 中设置 `JAVINFO_API_KEY` 即可启用实时元数据查询。密钥仅通过 `x-javinfo-key` 请求头发送，不写入日志。

## 命令

支持 `/start`、`/help`、`/language`、`/cancel`、`/privacy`，以及仅管理员可用的 `/status`。忽略群聊消息；首次查询需要完成一次年龄确认。

## 生产环境

仓库：`gelatoni-xh/telegram-metadata`。`Check and deploy` 工作流会在部署前验证 Node 24、数据库迁移、单元测试、PostgreSQL 集成测试和 Docker 构建。将仓库变量 `DEPLOY_ENABLED=true` 即可启用主分支发布。

GitHub Actions Secrets：`BOT_TOKEN`、`JAVINFO_API_KEY`、`WEBHOOK_SECRET`、`DATABASE_URL`、`MIGRATION_DATABASE_URL`、`ADMIN_TELEGRAM_ID`、`SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS`、`SERVER_HOST`、`SERVER_USER`。Actions 生成受保护的环境文件，通过已校验的 SSH 传输；凭据不提交到仓库，也不打包到镜像。服务器上的运行环境文件权限为 `600`。

部署目录为 `/opt/apps/telegram-metadata`，Compose 服务为 `app`，回环端口为 `3051`。将仓库变量 `WEBHOOK_URL` 设置为公开 HTTPS 端点。在服务器受保护的 `.env` 中设置 `DATABASE_NETWORK`，并创建包含 `DB_CONTAINER` 和 `DB_ADMIN_USER` 的 `.ops.conf`，供本地数据库管理和备份使用。数据库 URL 保留在 GitHub Secrets 中；运行角色与迁移角色分离。运行角色仅有应用表的增删改查权限，迁移使用所有者账号。后续 CI 部署必须保留主机专属配置。

Webhook 更新按 ID 去重，持久化入队后才确认接收，由单个 worker 处理。消息载荷在处理完成后删除，仅含 ID 的记录七天后过期。被中断的处理中更新不会自动重放，因为上游查询可能已经产生费用；用户可在发布中断后重新操作。注册 webhook 时保留 Telegram 待处理更新。

`scripts/backup.sh` 会在每次部署前生成经过验证的自定义格式数据库备份，每日 systemd 定时器也使用同一脚本，保留期为 14 天。备份包含用户偏好，也可能包含待处理消息，应按运行环境文件的标准保护。先恢复到独立的临时数据库并核对数量，再切换生产。不要覆盖共享数据库。

代码回滚要求数据库 schema 兼容：检查 `previous-release.env`，停止本项目的 `app`，将上一版本配置复制到 `release.env`，再执行 `docker compose --env-file .env --env-file release.env up -d --no-deps app`。先审查迁移；数据库迁移不会自动回退。仅保留当前和上一版本的镜像及归档。不要停止或删除共享 PostgreSQL 容器、网络或卷。

## 使用统计

仅管理员可用的 `/stats` 返回聚合使用统计。Bot 在管理员私聊中维护一条静默置顶快照，每五分钟刷新一次，启动后也会刷新，供 GitHub 每日作品集报告读取。请保持置顶。导出失败时只记录不含凭据的日志，并在下一周期重试，不阻塞启动或正常请求。

统计排除配置中的管理员，对已处理的私聊文本消息和按钮操作按 Telegram update ID 计数一次。活跃用户按天和完整的七天区间分别去重。搜索请求包括到达提供方的初次搜索、筛选和翻页尝试，也包括返回错误的尝试。`UsageEvent` 仅持久化 update ID、用户 ID、时间戳和搜索尝试次数，不复制查询文本或消息正文。当前注册用户和历史新增用户由 `User` 推导；删除用户记录会将其从统计关联中移除。`UsageEvent` 用于趋势聚合而保留，不提供公开的逐用户导出。

交互统计从迁移创建的 `StatsState.createdAt` 开始。开始追踪之前的日期和安装当天的不完整日期，其交互、活跃用户和搜索次数均返回 `null`，应显示为不可用，而不是零。注册和新增用户仍可由既有账号记录统计。积累七个完整追踪日之前，首个七日活跃用户总数不可用。所有统计区间均使用 Asia/Shanghai 时区。快照仅含聚合字段，由 GitHub 通过 Telegram `getChat` 读取，无需公开统计端点或远程数据库访问。

执行 Compose 命令时显式加载两个文件：`docker compose --env-file .env --env-file release.env ...`。前者保存主机配置，后者指定发布镜像。
