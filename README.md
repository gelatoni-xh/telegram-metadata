# Telegram Metadata Bot

Telegram private chat bot for bilingual text metadata search. The initial implementation includes age confirmation, Chinese/Japanese UI, privacy controls, query sessions, result pages, detail pages, and session ownership/version checks.

The JavInfo adapter uses the documented `/query`, `/movie`, and `/profile` endpoints with runtime response validation. Its search, detail, authentication, and account response shapes have been checked with controlled live calls. See `docs/source.md` for the verified contract and remaining source-link terms review.

## Local development

Requirements: Node.js 24, Corepack with pnpm 10.32.1, and Docker.

1. Keep the BotFather token in `.env` as `BOT_TOKEN=...`. This file is ignored by Git and should remain mode `600`.
2. Select Node.js 24 with `nvm use 24`.
3. Start the isolated PostgreSQL test database with `docker compose -f infra/compose.local.yml up -d`.
4. Run `corepack pnpm@10.32.1 install`, `corepack pnpm@10.32.1 db:generate`, then `corepack pnpm@10.32.1 exec prisma migrate dev`. Prisma defaults to the isolated local test database on port `15456` when `DATABASE_URL` is unset.
5. Run `corepack pnpm@10.32.1 dev`. Development uses long polling; it does not register a webhook.

Set `JAVINFO_API_KEY` in `.env.local` to enable live metadata queries. The key is sent only in the `x-javinfo-key` header and is never logged.

## Commands

`/start`, `/help`, `/language`, `/cancel`, `/privacy`, and administrator-only `/status` are supported. Group chats are ignored. The first query requires one-time age confirmation.

## Production

Private repository: `gelatoni-xh/telegram-metadata`. `Check and deploy` verifies Node 24, database migrations, unit and PostgreSQL integration tests, and the Docker build before deployment. Set repository variable `DEPLOY_ENABLED=true` to enable main-branch releases.

GitHub Actions Secrets: `BOT_TOKEN`, `JAVINFO_API_KEY`, `WEBHOOK_SECRET`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `ADMIN_TELEGRAM_ID`, `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`, `SERVER_HOST`, `SERVER_USER`. Actions renders protected environment files and transfers them over verified SSH; credentials are never committed or included in the image. Server copies are mode 600 for runtime use.

Deploy to `/opt/apps/telegram-metadata`, Compose service `app`, loopback port `3051`. Set repository variable `WEBHOOK_URL` to the public HTTPS endpoint. Set `DATABASE_NETWORK` in the server's protected `.env` file and create `.ops.conf` with `DB_CONTAINER` and `DB_ADMIN_USER` for local database administration and backups. Database URLs remain GitHub Secrets; runtime and migration roles stay separate. The runtime has CRUD permissions only on application tables; migrations use the owner login. Host-specific settings must survive future CI deployments.

Webhook updates are deduplicated by ID and acknowledged after durable insertion. A single worker processes the queue. Message payloads are removed after completion; ID-only records expire after seven days. Interrupted in-flight updates are not replayed automatically because upstream queries may already have incurred a charge. Users can repeat their action after an interrupted release. Telegram pending updates are preserved when registering the webhook.

`scripts/backup.sh` creates a verified, custom-format database dump before every deployment; the daily systemd timer uses the same script. Retention is 14 days. Backup files contain user preferences and may contain pending messages: protect them like the runtime environment. Restore into a separate scratch database first and verify counts before switching production. Never restore over the shared databases.

For a schema-compatible code rollback, check `previous-release.env`, stop this project's `app`, copy the previous release to `release.env`, and run `docker compose --env-file .env --env-file release.env up -d --no-deps app`. Review migrations first; database migrations are never reversed automatically. Only the current and previous image/archive are retained. Do not stop or delete the shared PostgreSQL container, network or volume.

## Usage statistics

Administrator-only `/stats` returns aggregate usage statistics. The bot maintains one silent pinned snapshot in the administrator's private chat, refreshed every five minutes (also after startup), for the GitHub daily portfolio report. Keep it pinned. Export failures are logged without credentials and retried at the next interval; they do not block startup or normal requests.

Statistics exclude the configured administrator and count handled private text messages/buttons once per Telegram update ID. Active users are deduplicated over each day and over the entire completed seven-day interval. Search requests count initial searches, filter applications and pagination attempts reaching the provider, including attempts returning an error. Only update ID, user ID, timestamp and search-attempt count persist in `UsageEvent`; no query text or message body is copied into analytics. Current registered users and historical new users derive from `User`. Deleting user records removes them from analytics joins. `UsageEvent` is retained for trend aggregation; no public per-user export is provided.

Interaction tracking starts at the migration's `StatsState.createdAt`. Days before tracking and the partial installation day return `null` for interactions, active users and searches. They must display as unavailable, not zero. Registered/new users can still be counted from existing account records. The first seven-day active total is unavailable until seven complete tracked days exist. All periods use Asia/Shanghai. Snapshots contain only aggregate fields and are read by GitHub through Telegram `getChat`; no public statistics endpoint or remote database access is needed.

Compose commands load both files explicitly: `docker compose --env-file .env --env-file release.env ...`. The first file holds host settings; the second selects the release image.
