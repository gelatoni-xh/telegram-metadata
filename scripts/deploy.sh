#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/apps/telegram-metadata
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is active'; exit 1; }
release_sha=${1:?Provide full SHA}
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
candidate="releases/$release_sha"
cd "$candidate"
sha256sum -c image.tar.gz.sha256
docker load -i image.tar.gz > /dev/null
cd ../..
./scripts/backup.sh
test ! -f release.env || cp release.env previous-release.env
install -m 600 "$candidate/.env.production" .env.production
install -m 600 "$candidate/.env.migration" .env.migration
printf 'APP_IMAGE=telegram-metadata:%s\n' "$release_sha" > next-release.env
docker compose --env-file next-release.env run --rm --no-deps migrate
docker exec -i tasuki-keifu-postgres psql -U tasuki_keifu_user -d telegram_metadata -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO telegram_metadata_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "QuerySession", "ProviderCall", "TelegramUpdate" TO telegram_metadata_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM telegram_metadata_app;
SQL
mv next-release.env release.env
# Stop first so the old process releases its single-runtime advisory lock.
docker compose --env-file release.env stop app
docker compose --env-file release.env up -d --no-deps app
for attempt in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:3051/readyz >/dev/null; then
    echo "Deployment healthy: $release_sha"
    # Retain this release and its immediate predecessor only, within this project.
    previous=$(sed -n 's/^APP_IMAGE=telegram-metadata://p' previous-release.env 2>/dev/null || true)
    for directory in releases/*; do
      tag=${directory##*/}
      [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue
      [[ "$tag" == "$release_sha" || "$tag" == "$previous" ]] && continue
      rm -rf -- "$directory"
      docker image rm "telegram-metadata:$tag" >/dev/null 2>&1 || true
    done
    exit 0
  fi
  sleep 2
done
echo 'Readiness failed; retain previous-release.env for schema-compatible code rollback' >&2
exit 1
