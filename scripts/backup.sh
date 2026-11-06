#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/apps/telegram-metadata
source .ops.conf
mkdir -p backups
file="backups/telegram-metadata-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec "$DB_CONTAINER" pg_dump -U "$DB_ADMIN_USER" -d telegram_metadata -Fc --no-owner > "$file.tmp"
test -s "$file.tmp"
docker exec -i "$DB_CONTAINER" pg_restore --list < "$file.tmp" > /dev/null
mv "$file.tmp" "$file"
find backups -name 'telegram-metadata-*.dump' -mtime +14 -delete
echo 'Database backup verified'
