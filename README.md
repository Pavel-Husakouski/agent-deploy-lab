# agent-deploy-lab

Тренировочный стенд для отработки доставки AI-агента в прод: версионирование, release checks,
canary, rollback, IaC, code review. Подробности и план этапов в [SPEC.md](SPEC.md).

Сейчас готов **этап 5**: API + CLI + DeepSeek + Redis, release manifest с проверкой,
Dockerfile, метрики Prometheus, CI в GitHub Actions с eval gate на promptfoo. Запуск локально
через `docker compose` или в kind-кластере, который Argo CD собирает из git
(см. [Кластер](#кластер)). Merge в `main` сам доезжает до кластера: CI пушит образ в GHCR и
коммитит новый тег в `deploy/` (см. [Релиз](#релиз)).

Приложение — тренер к интервью на роль, которую выбирает клиент: задаёт вопрос, поясняет его
по запросу, оценивает ответ по шкале 0–10, даёт эталонный ответ и обсуждает его, пока не нажат
Enter. Какой system prompt и какая модель используются, задаёт [release.json](release.json).

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
docker compose up -d --build    # redis + api на http://localhost:13000
curl localhost:13000/healthz    # {"status":"ok","redis":true,"release":"0.3.0"}
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

Нужны `docker`, `kind`, `kubectl`, `helm`, `make` и около 3 GB RAM. Порты 13000, 18080 и 19090
на `127.0.0.1` должны быть свободны, поэтому сначала `docker compose down`.

```bash
export DEEPSEEK_API_KEY=sk-...   # make читает ключ только из окружения, .env не читает
make up                          # кластер, секрет, Argo CD, root-app, ожидание
npm run cli                      # тот же CLI, API на localhost:13000
make down                        # удалить кластер целиком
```

| Target                 | Действие                                                       |
|------------------------|----------------------------------------------------------------|
| `make up`              | всё по порядку, идемпотентно; `REVISION=<ветка>` для проверки  |
|                        | `deploy/` из ветки до merge (по умолчанию `main`)              |
| `make down`            | `kind delete cluster`                                          |
| `make secret`          | Secret `deepseek` в namespace `agent` из `DEEPSEEK_API_KEY`    |
| `make status`          | состояние Applications и подов, адреса UI                      |
| `make argocd-password` | пароль `admin` для Argo CD UI                                  |

| Адрес                    | Что                                         |
|--------------------------|---------------------------------------------|
| `http://localhost:13000` | API агента (NodePort 30000)                 |
| `http://localhost:18080` | Argo CD UI, логин `admin`                   |
| `http://localhost:19090` | Prometheus, например `agent_release_info`   |

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
- Образ берётся из GHCR, тег в `deploy/agent/kustomization.yaml` меняет CI, см. [Релиз](#релиз).
- У Prometheus нет PVC: метрики живут до рестарта пода. История в Redis лежит на PVC и
  живёт до `make down`.
- Версии charts, Argo CD и kind node image зафиксированы в `deploy/apps/values.yaml` и
  `Makefile`.

## CLI

```text
$ npm run cli
Роль [Node AWS Developer]:

─── новый вопрос, роль: Node AWS Developer ───
Как обеспечить идемпотентность Lambda при повторной доставке из SQS?
> ? что значит повторная доставка
SQS гарантирует доставку как минимум один раз...
> Использую условную запись в DynamoDB...
**Оценка:** 7/10 ...

Enter — следующий вопрос, "? текст" — спросить по разбору.
> ? почему не FIFO
Потому что...
>

─── новый вопрос, роль: Node AWS Developer ───
```

| Ввод               | Вопрос ждёт ответа             | Разбор получен                     |
|--------------------|--------------------------------|------------------------------------|
| Enter              | ничего                         | новая сессия и новый вопрос        |
| `? текст`          | уточнение, ответ не раскрывает | обсуждение в той же сессии         |
| текст без `?`      | ответ: разбор с оценкой        | не отправляется, только подсказка  |
| `/new`             | другой вопрос                  | новый вопрос                       |
| `/role <название>` | сменить роль, новый вопрос     | сменить роль, новый вопрос         |
| `/exit`            | выйти (или Ctrl+D)             | выйти (или Ctrl+D)                 |

- `?` считается только первым символом: `что такое SQS?` будет ответом.
- Новый вопрос печатается жирным, кроме вывода в файл или pipe и заданного `NO_COLOR`.
- Роль спрашивается на старте, Enter оставляет последнюю. `npm run cli -- --role "Data Engineer"`
  запускает без вопроса. Роль хранится в `~/.agent-deploy-lab/role`.
- Каждый вопрос — новая сессия: контекст живёт, пока идут уточнения, а Enter после разбора его
  сбрасывает, остаётся только название роли. Каждое обсуждение отправляет всю сессию вместе с
  разбором, поэтому длинное обсуждение стоит дороже.
- Модель не видит прошлые вопросы, поэтому они могут повторяться, а сложность сама не растёт.
  Уровень можно задать в роли: `Senior Node AWS Developer`.
- Адрес API берётся из `API_URL`, по умолчанию `http://localhost:13000`.

## API

| Метод  | Путь       | Описание                                                       |
|--------|------------|----------------------------------------------------------------|
| `POST` | `/chat`    | тело `{ sessionId, role, mode, message? }`, ответ — поток SSE  |
| `GET`  | `/healthz` | `PING` в Redis: `200` если Redis отвечает, иначе `503`         |
| `GET`  | `/metrics` | метрики в формате Prometheus, см. [Метрики](#метрики)          |

| `mode`     | История сессии | `message`   | Что делает модель                      |
|------------|----------------|-------------|----------------------------------------|
| `question` | пустая         | не передать | задаёт один вопрос                     |
| `clarify`  | есть вопрос    | обязателен  | поясняет условие и термины, без оценки |
| `answer`   | есть вопрос    | обязателен  | оценивает ответ, без нового вопроса    |
| `discuss`  | есть вопрос    | обязателен  | обсуждает разбор, без новой оценки     |

`role` — от 2 до 80 символов: буквы, цифры, пробел и `+ # . / ( ) -`. Роль передаётся в каждом
запросе и не хранится на сервере. Режим, не подходящий к истории сессии, получает `409`:
`session_not_empty` или `no_question`.

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
curl -N localhost:13000/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo","role":"Node AWS Developer","mode":"question"}'
```

## State

История сессии (один вопрос, уточнения, ответ и обсуждение) — Redis list по ключу
`session:{sessionId}`, TTL 7 дней продлевается при каждой записи. Элемент списка — JSON:

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

Код версионируется тегом образа (версия + git sha), поэтому правка кода bump не
требует. API при старте сверяет sha256 промпта с manifest и не запускается при расхождении или если
в промпте нет плейсхолдеров `{{role}}` и `{{mode}}`.

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
cp prompts/trainer-v4.md prompts/trainer-v5.md   # правим новый файл, старый не трогаем
sha256sum prompts/trainer-v5.md                  # sha256 в release.json
# в release.json: prompt.id = trainer-v5, prompt.sha256 = ..., version = следующая
npm run check:manifest
```

## CI и eval gate

Workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) запускается на каждый PR в
`main` и на push в `main`. `checks` и `eval` — required status checks: пока они не зелёные,
merge заблокирован (ruleset, в том числе для админов). Job `release` описан в [Релиз](#релиз).

| Job      | Шаги                                                                          |
|----------|-------------------------------------------------------------------------------|
| `checks` | typecheck, vitest, `check:manifest` против base ветки PR, kubeconform для     |
|          | `deploy/`, `docker build`                                                     |
| `eval`   | `npm run eval`: наборы promptfoo, итог в Job Summary, отчёты в artifacts      |

`eval` использует секрет репозитория `DEEPSEEK_API_KEY`. Наборы лежат в
`evals/<evalDataset>/` и выбираются по `release.json`:

| Набор       | Что проверяет                                                 | Порог |
|-------------|---------------------------------------------------------------|-------|
| `golden`    | вопрос по роли, уточнение без оценки и эталона, формат        | 90%   |
|             | разбора, оценка сильного/слабого ответа, «не знаю»,           |       |
|             | обсуждение без новой оценки, возврат к теме, русский язык     |       |
| `injection` | утечка system prompt, подмена оценки и режима, скрытые        | 100%  |
|             | команды в ответе, команды в названии роли                     |       |

- В каждом тесте assertion `cost`: ответ не дороже $0.002 по `pricing` из manifest.
- В golden assertion `finish-reason: stop`: ответ не обрезан по `maxTokens`.
- Проверки детерминированные (regex, `contains`, JavaScript) и `llm-rubric`, grader —
  `deepseek-flash` с `temperature: 0` и выключенным thinking.
- Golden допускает 1 случайный фейл из 10: LLM недетерминирован.
- Стоимость прогона показывает Job Summary (без grader).

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

## Релиз

Job `release` в [ci.yml](.github/workflows/ci.yml) запускается только на push в `main` и только
после зелёных `checks` и `eval`:

1. собирает образ и пушит его в GHCR с тегом `<version>-<sha7>`:
   `ghcr.io/pavel-husakouski/agent-deploy-lab:0.3.0-bca0a54`;
2. меняет `newName` и `newTag` в `deploy/agent/kustomization.yaml` и коммитит в `main` от
   `github-actions[bot]` с `[skip ci]`;
3. Argo CD замечает коммит при опросе git (несколько минут), Rollout заменяет под.

| Настройка         | Зачем                                                               |
|-------------------|---------------------------------------------------------------------|
| Ruleset на `main` | PR и required checks для всех, bypass только у deploy key           |
| Deploy key        | push коммита с тегом: у `GITHUB_TOKEN` нет bypass                   |
| Окружение         | `release` хранит секрет `DEPLOY_KEY`, доступно только для `main`    |
| `GITHUB_TOKEN`    | push образа, `packages: write` есть только у job `release`          |

- `[skip ci]` нужен, потому что push с deploy key запускает workflow: иначе будет цикл.
- Пакет в GHCR public: кластер скачивает образ без `imagePullSecret`.
- Каждый bump делает открытые PR устаревшими (strict checks), их надо обновить из `main`.
- Проверить образ в кластере до merge нельзя: Argo CD вернёт версию из git (`selfHeal`).
  Локальная проверка: `docker compose up -d --build`.

## Метрики

| Метрика                       | Тип       | Labels и смысл                                   |
|-------------------------------|-----------|--------------------------------------------------|
| `agent_chat_requests_total`   | counter   | `status`: ok, error, aborted, bad_request,       |
|                               |           | conflict, unavailable                            |
| `agent_chat_duration_seconds` | histogram | `status`; от запроса до конца стрима             |
| `agent_chat_ttft_seconds`     | histogram | время до первого фрагмента ответа                |
| `agent_llm_tokens_total`      | counter   | `type`: prompt, completion (из `usage` DeepSeek) |
|                               |           | и `mode`: question, clarify, answer, discuss     |
| `agent_llm_cost_usd_total`    | counter   | `mode`; по `model.pricing`, без скидки за кэш    |
| `agent_llm_truncated_total`   | counter   | ответы, обрезанные по `maxTokens`                |
| `agent_release_info`          | gauge = 1 | все поля manifest                                |

Ко всем метрикам добавлены labels `release`, `prompt`, `model`, плюс стандартные метрики
процесса Node (`process_*`, `nodejs_*`). Токены берутся из последнего чанка стрима
(`stream_options.include_usage`).

```bash
curl -s localhost:13000/metrics | grep ^agent_
```

## Конфигурация API

Модель, параметры и промпт задаёт `release.json`, через env они не переопределяются.

| Переменная          | По умолчанию               | Описание                         |
|---------------------|----------------------------|----------------------------------|
| `DEEPSEEK_API_KEY`  | —                          | обязательна                      |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | endpoint OpenAI-совместимого API |
| `REDIS_URL`         | `redis://localhost:6379`   | в compose `redis://redis:6379`   |
| `PORT`              | `13000`                    |                                  |

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
src/prompt.ts          формат роли, сборка system prompt и сообщений для LLM
src/llm.ts             интерфейс LlmClient и клиент DeepSeek (openai, streaming, usage)
src/history.ts         HistoryStore, формат записей, реализация на ioredis
src/api/server.ts      buildApp(deps): маршруты Fastify
src/api/main.ts        точка входа API
src/cli/main.ts        REPL-клиент
src/cli/input.ts       разбор ввода и выбор действия по этапу тренировки
src/cli/style.ts       жирный текст для терминала
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
