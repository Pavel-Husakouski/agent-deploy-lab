#!/bin/sh
# Запуск API в контейнере docker compose (этап 1, без Dockerfile).
# node_modules лежат в отдельном named volume, поэтому зависимости ставятся под платформу
# контейнера и не конфликтуют с node_modules хоста. npm ci выполняется только при изменении
# package-lock.json, чтобы `docker compose restart api` был быстрым.
set -eu

lock_hash=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
  echo "package-lock.json изменился: npm ci"
  find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  npm ci --no-audit --no-fund
  echo "$lock_hash" > node_modules/.lock-hash
fi

exec node_modules/.bin/tsx src/api/main.ts
