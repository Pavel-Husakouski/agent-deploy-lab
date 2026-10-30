# agent-deploy-lab

Тренировочный стенд для отработки доставки AI-агента в прод: версионирование, release checks,
canary, rollback, IaC, code review. Подробности и план этапов в [SPEC.md](SPEC.md).

Сейчас готов **этап 2**: API + CLI + DeepSeek + Redis, release manifest с проверкой,
Dockerfile, метрики Prometheus. Локально через `docker compose`.

Приложение — тренер к интервью: задаёт вопрос по теме доставки агентов, оценивает ответ
по шкале 0–10, даёт эталонный ответ и задаёт следующий вопрос. Какой system prompt и какая
модель используются, задаёт [release.json](release.json).

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
npm install                     # зависимости для CLI и тестов на хосте
docker compose up -d --build    # redis + api на http://localhost:3000
curl localhost:3000/healthz     # {"status":"ok","redis":true,"release":"0.1.0"}
npm run cli                     # диалог с тренером
```

Compose собирает образ `agent-deploy-lab:local` из [Dockerfile](Dockerfile). После правок
кода, промпта или `release.json` нужен `docker compose up -d --build`. Версия и git sha
попадают в OCI labels образа, если передать их при сборке:

```bash
VERSION=$(node -p "require('./release.json').version") GIT_SHA=$(git rev-parse --short HEAD) \
  docker compose up -d --build
```

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
| `GET`  | `/metrics` | метрики в формате Prometheus, см. [Метрики](#метрики)          |

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

## Release manifest

[release.json](release.json) фиксирует всё, что влияет на поведение агента, кроме кода:

| Поле            | Что задаёт                                                    |
|-----------------|---------------------------------------------------------------|
| `version`       | semver релиза, попадает в label `release` всех метрик         |
| `model`         | id модели, `temperature`, `maxTokens`, `pricing` (USD за 1M)  |
| `prompt.id`     | system prompt из файла `prompts/<id>.md`                      |
| `prompt.sha256` | sha256 файла промпта                                          |
| `evalDataset`   | датасет для eval gate (этап 3)                                |

Код версионируется тегом образа (версия + git sha, этап 5), поэтому правка кода bump не
требует. API при старте сверяет sha256 промпта с manifest и не запускается при расхождении.

`npm run check:manifest` сравнивает рабочее дерево с base ref (по умолчанию `origin/main`,
другой: `npm run check:manifest -- --base HEAD`) и падает, если:

1. `release.json` не проходит схему или `version` не semver;
2. sha256 файла промпта не совпадает с `prompt.sha256`;
3. изменились промпт, `model` или `evalDataset`, а `version` не выросла (или уменьшилась);
4. изменился текст промпта, который уже есть в base: выпущенный промпт неизменяем.

Если в base ещё нет `release.json`, правила 3 и 4 пропускаются (первый релиз).

Как поменять промпт:

```bash
cp prompts/trainer-v1.md prompts/trainer-v2.md   # правим новый файл, старый не трогаем
sha256sum prompts/trainer-v2.md                  # sha256 в release.json
# в release.json: prompt.id = trainer-v2, prompt.sha256 = ..., version = следующая
npm run check:manifest
```

## Метрики

| Метрика                       | Тип       | Labels и смысл                                   |
|-------------------------------|-----------|--------------------------------------------------|
| `agent_chat_requests_total`   | counter   | `status`: ok, error, aborted, bad_request,       |
|                               |           | unavailable                                      |
| `agent_chat_duration_seconds` | histogram | `status`; от запроса до конца стрима             |
| `agent_chat_ttft_seconds`     | histogram | время до первого фрагмента ответа                |
| `agent_llm_tokens_total`      | counter   | `type`: prompt, completion (из `usage` DeepSeek) |
| `agent_llm_cost_usd_total`    | counter   | по `model.pricing`, без скидки за cache hit      |
| `agent_release_info`          | gauge = 1 | все поля manifest                                |

Ко всем метрикам добавлены labels `release`, `prompt`, `model`, плюс стандартные метрики
процесса Node (`process_*`, `nodejs_*`). Токены берутся из последнего чанка стрима
(`stream_options.include_usage`).

```bash
curl -s localhost:3000/metrics | grep ^agent_
```

## Конфигурация API

Модель, параметры и промпт задаёт `release.json`, через env они не переопределяются.

| Переменная          | По умолчанию               | Описание                         |
|---------------------|----------------------------|----------------------------------|
| `DEEPSEEK_API_KEY`  | —                          | обязательна                      |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | endpoint OpenAI-совместимого API |
| `REDIS_URL`         | `redis://localhost:6379`   | в compose `redis://redis:6379`   |
| `PORT`              | `3000`                     |                                  |

## Разработка

| Скрипт                   | Что делает                                    |
|--------------------------|-----------------------------------------------|
| `npm run typecheck`      | `tsc --noEmit`, strict                        |
| `npm test`               | vitest, LLM и Redis заменены фейками          |
| `npm run build`          | сборка `src` в `dist` (`tsconfig.build.json`) |
| `npm run check:manifest` | проверка `release.json`, см. выше             |
| `npm run dev`            | API на хосте с перезапуском при изменениях    |
| `npm run cli`            | консольный клиент                             |

Структура:

```text
src/config.ts          конфигурация из env (zod)
src/release.ts         схема release.json, загрузка промпта и проверка sha256
src/manifest-check.ts  правила check:manifest (чистая функция)
src/metrics.ts         метрики prom-client
src/llm.ts             интерфейс LlmClient и клиент DeepSeek (openai, streaming, usage)
src/history.ts         HistoryStore, формат записей, реализация на ioredis
src/api/server.ts      buildApp(deps): маршруты Fastify
src/api/main.ts        точка входа API
src/cli/main.ts        REPL-клиент
scripts/               check-manifest.ts
prompts/               system prompts, выпущенные файлы не меняются
release.json           release manifest
Dockerfile             multi-stage сборка образа API
test/                  vitest
```
