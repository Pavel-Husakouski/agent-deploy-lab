# agent-deploy-lab

Тренировочный стенд для отработки доставки AI-агента в прод: версионирование, release checks,
canary, rollback, IaC, code review. Подробности и план этапов в [SPEC.md](SPEC.md).

Сейчас готов **этап 4**: API + CLI + DeepSeek + Redis, release manifest с проверкой,
Dockerfile, метрики Prometheus, CI в GitHub Actions с eval gate на promptfoo. Запуск локально
через `docker compose` или в kind-кластере, который Argo CD собирает из git
(см. [Кластер](#кластер)).

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
curl localhost:3000/healthz     # {"status":"ok","redis":true,"release":"0.3.0"}
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

## Кластер

Тот же агент в kind. Руками ставится только Argo CD, остальное он синхронизирует из
`deploy/` в git по схеме app-of-apps.

Нужны `docker`, `kind`, `kubectl`, `helm`, `make` и около 3 GB RAM. Порты 3000, 8080 и 9090
на `127.0.0.1` должны быть свободны, поэтому сначала `docker compose down`.

```bash
export DEEPSEEK_API_KEY=sk-...   # make читает ключ только из окружения, .env не читает
make up                          # кластер, образ, секрет, Argo CD, root-app, ожидание
npm run cli                      # тот же CLI, API на localhost:3000
make down                        # удалить кластер целиком
```

| Target                 | Действие                                                       |
|------------------------|----------------------------------------------------------------|
| `make up`              | всё по порядку, идемпотентно; `REVISION=<ветка>` для проверки  |
|                        | `deploy/` из ветки до merge (по умолчанию `main`)              |
| `make down`            | `kind delete cluster`                                          |
| `make image`           | собрать `agent-deploy-lab:dev`, `kind load`, перезапустить под |
| `make secret`          | Secret `deepseek` в namespace `agent` из `DEEPSEEK_API_KEY`    |
| `make status`          | состояние Applications и подов, адреса UI                      |
| `make argocd-password` | пароль `admin` для Argo CD UI                                  |

| Адрес                   | Что                                         |
|-------------------------|---------------------------------------------|
| `http://localhost:3000` | API агента (NodePort 30000)                 |
| `http://localhost:8080` | Argo CD UI, логин `admin`                   |
| `http://localhost:9090` | Prometheus, например `agent_release_info`   |

Что синхронизирует Argo CD (`deploy/apps`, Helm chart с Application на компонент):

| Wave | Application     | Источник                                           | Namespace       |
|------|-----------------|----------------------------------------------------|-----------------|
| -1   | `argo-rollouts` | chart `argo-rollouts` 2.43.8                       | `argo-rollouts` |
| -1   | `prometheus`    | chart `prometheus` 29.40.0, только server          | `monitoring`    |
| 0    | `redis`         | [deploy/redis](deploy/redis): StatefulSet, AOF+PVC | `agent`         |
| 1    | `agent`         | [deploy/agent](deploy/agent): Rollout, NodePort    | `agent`         |

- У всех Application включены `automated`, `prune` и `selfHeal`: ручная правка в кластере
  откатывается к состоянию из git.
- Sync waves работают благодаря health check для `Application` в
  [argocd-values.yaml](deploy/bootstrap/argocd-values.yaml). Без него agent синхронизировался
  бы раньше, чем появятся CRD `Rollout`.
- agent уже `Rollout`, пока без canary steps (они появятся на этапе 6). Под scrape-ится
  Prometheus по аннотациям `prometheus.io/*`.
- До этапа 5 образ не берётся из registry: `make image` собирает его и загружает в ноду kind.
- У Prometheus нет PVC: метрики живут до рестарта пода. История в Redis лежит на PVC и
  живёт до `make down`.
- Версии charts, Argo CD и kind node image зафиксированы в `deploy/apps/values.yaml` и
  `Makefile`.

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
| `evalDataset`   | eval dataset для gate: каталог `evals/<id>/`                  |

Код версионируется тегом образа (версия + git sha, этап 5), поэтому правка кода bump не
требует. API при старте сверяет sha256 промпта с manifest и не запускается при расхождении.

`npm run check:manifest` сравнивает рабочее дерево с base ref (по умолчанию `origin/main`,
другой: `npm run check:manifest -- --base HEAD`) и падает, если:

1. `release.json` не проходит схему или `version` не semver;
2. sha256 файла промпта не совпадает с `prompt.sha256`;
3. изменились промпт, `model`, `evalDataset` или содержимое `evals/<evalDataset>/`, а
   `version` не выросла (или уменьшилась);
4. изменился текст промпта, который уже есть в base: выпущенный промпт неизменяем;
5. нет каталога `evals/<evalDataset>/`.

Если в base ещё нет `release.json`, правила 3 и 4 пропускаются (первый релиз).

Как поменять промпт:

```bash
cp prompts/trainer-v2.md prompts/trainer-v3.md   # правим новый файл, старый не трогаем
sha256sum prompts/trainer-v3.md                  # sha256 в release.json
# в release.json: prompt.id = trainer-v3, prompt.sha256 = ..., version = следующая
npm run check:manifest
```

## CI и eval gate

Workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) запускается на каждый PR в
`main` и на push в `main`. Оба job — required status checks: пока они не зелёные, merge
заблокирован (branch protection, в том числе для админов).

| Job      | Шаги                                                                          |
|----------|-------------------------------------------------------------------------------|
| `checks` | typecheck, vitest, `check:manifest` против base ветки PR, kubeconform для     |
|          | `deploy/`, `docker build`                                                     |
| `eval`   | `npm run eval`: наборы promptfoo, итог в Job Summary, отчёты в artifacts      |

`eval` использует секрет репозитория `DEEPSEEK_API_KEY`. Наборы лежат в
`evals/<evalDataset>/` и выбираются по `release.json`:

| Набор       | Что проверяет                                                 | Порог |
|-------------|---------------------------------------------------------------|-------|
| `golden`    | формат разбора, оценка сильного/слабого ответа, «не знаю»,    | 90%   |
|             | возврат к теме, русский язык, неповтор вопросов               |       |
| `injection` | утечка system prompt, смена роли, подмена оценки,             | 100%  |
|             | скрытые команды в ответе кандидата                            |       |

- В каждом тесте assertion `cost`: ответ не дороже $0.002 по `pricing` из manifest.
- В golden assertion `finish-reason: stop`: ответ не обрезан по `maxTokens`.
- Проверки детерминированные (regex, `contains`, JavaScript) и `llm-rubric`, grader —
  `deepseek-flash` с `temperature: 0` и выключенным thinking.
- Golden допускает 1 случайный фейл из 10: LLM недетерминирован.
- Прогон обоих наборов стоит около $0.015 (без grader).

Provider [evals/provider.ts](evals/provider.ts) берёт промпт, модель и параметры из
`release.json` и вызывает LLM через `src/llm.ts`: eval проверяет ровно тот релиз, который
поедет в прод. promptfoo установлен отдельно в `evals/` и не попадает в образ.

Запуск локально (ключ из env или `.env`, его читает promptfoo):

```bash
npm ci --prefix evals              # один раз
npm run eval                       # оба набора
npm run eval -- --suite injection  # один набор
```

Отчёты: `reports/<набор>.html` и `.json`.

## Метрики

| Метрика                       | Тип       | Labels и смысл                                   |
|-------------------------------|-----------|--------------------------------------------------|
| `agent_chat_requests_total`   | counter   | `status`: ok, error, aborted, bad_request,       |
|                               |           | unavailable                                      |
| `agent_chat_duration_seconds` | histogram | `status`; от запроса до конца стрима             |
| `agent_chat_ttft_seconds`     | histogram | время до первого фрагмента ответа                |
| `agent_llm_tokens_total`      | counter   | `type`: prompt, completion (из `usage` DeepSeek) |
| `agent_llm_cost_usd_total`    | counter   | по `model.pricing`, без скидки за cache hit      |
| `agent_llm_truncated_total`   | counter   | ответы, обрезанные по `maxTokens`                |
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
| `npm run eval`           | eval gate на promptfoo, см. выше              |
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
deploy/kind/           конфиг kind-кластера
deploy/bootstrap/      values Argo CD и root-app (app-of-apps)
deploy/apps/           Helm chart: Application на каждый компонент
deploy/redis/, agent/  манифесты Redis и агента
Makefile               make up / down и вспомогательные target-ы
scripts/               check-manifest.ts, eval.ts (eval gate)
evals/                 promptfoo: provider.ts, наборы <evalDataset>/*.yaml
.github/workflows/     CI
prompts/               system prompts, выпущенные файлы не меняются
release.json           release manifest
Dockerfile             multi-stage сборка образа API
test/                  vitest
```
