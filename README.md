# agent-deploy-lab

Тренировочный стенд для отработки доставки AI-агента в прод: версионирование, release checks,
canary, rollback, IaC, code review. Подробности и план этапов в [SPEC.md](SPEC.md).

Сейчас готов **этап 1**: API + CLI + DeepSeek + Redis, локально через `docker compose`.

Приложение — тренер к интервью: задаёт вопрос по теме доставки агентов, оценивает ответ
по шкале 0–10, даёт эталонный ответ и задаёт следующий вопрос. System prompt лежит в
[prompts/trainer-v1.md](prompts/trainer-v1.md).

## Требования

- Docker с Compose v2;
- Node.js 26 (для CLI, тестов и локального запуска без Docker);
- ключ DeepSeek API.

## Куда положить ключ

Ключ в репозиторий не попадает: `.env` в `.gitignore`. Подойдёт любой из вариантов:

```bash
# вариант 1: переменная окружения в текущем shell
export DEEPSEEK_API_KEY=sk-...

# вариант 2: файл .env в корне репозитория, compose подхватит его сам
echo 'DEEPSEEK_API_KEY=sk-...' > .env
```

Без ключа `docker compose up` остановится с сообщением, что `DEEPSEEK_API_KEY` не задан.

## Запуск

```bash
npm install                 # зависимости для CLI и тестов на хосте
docker compose up -d        # redis + api на http://localhost:3000
curl localhost:3000/healthz # {"status":"ok","redis":true}
npm run cli                 # диалог с тренером
```

Контейнер `api` работает на `node:26-slim` без Dockerfile: исходники примонтированы, запуск
через `tsx`. `node_modules` контейнера лежат в отдельном volume, `npm ci` выполняется при
первом старте и при изменении `package-lock.json` (см. `scripts/compose-api.sh`).

Остановка: `docker compose down` (история сохраняется в volume `redis-data`),
`docker compose down -v` удаляет и историю.

## CLI

| Команда   | Действие                       |
|-----------|--------------------------------|
| `/new`    | начать новую сессию            |
| `/exit`   | выйти (или Ctrl+D)             |
| остальное | сообщение тренеру              |

- адрес API берётся из `API_URL`, по умолчанию `http://localhost:3000`;
- `sessionId` (uuid) хранится в `~/.agent-deploy-lab/session` и переживает перезапуск CLI.

## API

| Метод  | Путь       | Описание                                                       |
|--------|------------|----------------------------------------------------------------|
| `POST` | `/chat`    | тело `{ sessionId, message }`, ответ — поток SSE               |
| `GET`  | `/healthz` | `PING` в Redis: `200` если Redis отвечает, иначе `503`         |

Поток `/chat`:

```text
data: {"delta":"При"}

data: {"delta":"вет"}

event: done
data: {}
```

При ошибке LLM вместо `done` приходит `event: error` с `data: {"message":"..."}`.
Невалидный запрос получает `400` с JSON-описанием ошибок до начала стрима.

Пример без CLI:

```bash
curl -N localhost:3000/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo","message":"начнём"}'
```

## State

История сессии — Redis list по ключу `session:{sessionId}`, TTL 7 дней продлевается при
каждой записи. Элемент списка — JSON:

```json
{ "schemaVersion": 1, "role": "user", "content": "...", "ts": "2026-10-28T12:00:00.000Z" }
```

Обе реплики (user и assistant) дописываются только после успешного завершения стрима.
Redis запущен с `--appendonly yes`, поэтому история переживает рестарт и API, и Redis.

```bash
docker compose exec redis redis-cli LRANGE session:<sessionId> 0 -1
```

## Конфигурация API

| Переменная          | По умолчанию               | Описание                         |
|---------------------|----------------------------|----------------------------------|
| `DEEPSEEK_API_KEY`  | —                          | обязательна                      |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | endpoint OpenAI-совместимого API |
| `REDIS_URL`         | `redis://localhost:6379`   | в compose `redis://redis:6379`   |
| `MODEL_ID`          | `deepseek-chat`            | модель                           |
| `TEMPERATURE`       | `0.3`                      |                                  |
| `MAX_TOKENS`        | `1024`                     |                                  |
| `PORT`              | `3000`                     |                                  |
| `PROMPT_PATH`       | `prompts/trainer-v1.md`    | файл system prompt               |

## Разработка

| Скрипт              | Что делает                                    |
|---------------------|-----------------------------------------------|
| `npm run typecheck` | `tsc --noEmit`, strict                        |
| `npm test`          | vitest, LLM и Redis заменены фейками          |
| `npm run dev`       | API на хосте с перезапуском при изменениях    |
| `npm run cli`       | консольный клиент                             |

Структура:

```text
src/config.ts       конфигурация из env (zod)
src/llm.ts          интерфейс LlmClient и клиент DeepSeek (пакет openai, streaming)
src/history.ts      HistoryStore, формат записей, реализация на ioredis
src/api/server.ts   buildApp(deps): маршруты Fastify
src/api/main.ts     точка входа API
src/cli/main.ts     REPL-клиент
prompts/            system prompts
test/               vitest
```
