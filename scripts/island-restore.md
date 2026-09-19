# Восстановление острова из снимка `island-backup.sh`

Снимок — каталог `/var/backups/ugolok/<UTC-метка>/` (ссылка `latest`), внутри
`relay-events.jsonl.gz`, `blossom.sqlite3`, `blobs/`, `MANIFEST`.
**Проверяйте восстановление до аварии** (AUDIT-EGOROD H3): скопируйте снимок на
тестовый хост и пройдите шаги ниже — бэкап, который ни разу не восстанавливали,
бэкапом считать нельзя.

1. Остановить остров: `docker compose -f /opt/ugolok/island/docker-compose.yml stop relay blossom`.
2. Relay: очистить `/var/lib/ugolok/relay/*`, поднять контейнер и залить события  
   `gzip -dc relay-events.jsonl.gz | docker exec -i ugolok-relay /app/strfry --config=/app/strfry.conf import`.
3. Blossom: положить `blossom.sqlite3` в `/var/lib/ugolok/blossom/database.sqlite3`
   (при копии «с WAL» — вместе с `-wal`/`-shm`), `rsync -a blobs/ /var/lib/ugolok/blossom/blobs/`.
4. `docker compose ... up -d`, затем `scripts/island-health.sh prod`.
