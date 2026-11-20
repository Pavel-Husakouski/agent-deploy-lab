# agent-deploy-lab

Тренировочный стенд для отработки доставки AI-агента в прод: версионирование, release checks,
canary, rollback, IaC, code review. Подробности и план этапов в [SPEC.md](SPEC.md).

Готовы этапы 1–7, 10 и 11, следующий — этап 8 (review и runbook).

- **Этапы 1–5:** API + CLI + DeepSeek + Redis, release manifest с проверкой, Dockerfile,
  метрики Prometheus, CI в GitHub Actions с eval gate на promptfoo. Запуск локально через
  `docker compose` или в kind-кластере, куда Argo CD доставляет агента из git
  (см. [Кластер](#кластер)). Merge в `main` сам доезжает до кластера: CI пушит образ в GHCR и
  коммитит новый тег в `deploy/` (см. [Релиз](#релиз)).
- **Этап 6:** новая версия выкатывается canary: половина трафика, анализ метрик canary против
  stable в Prometheus, при провале автооткат (см. [Canary](#canary)).
- **Этап 7:** откат релиза, который уже записал state: история в формате v2 читается
  предыдущим релизом, аварийный откат тегом без canary, обратная миграция для отката дальше
  окна совместимости (см. [Откат](#откат)).
- **Этап 10:** в кластере агент ходит в LLM через LiteLLM Proxy с virtual key и бюджетом, а
  каждый вызов виден трейсом в self-hosted Langfuse
  (см. [LLM gateway и Langfuse](#llm-gateway-и-langfuse)).
- **Этап 11:** кластер, Argo CD, LiteLLM, Langfuse, Prometheus и Argo Rollouts вынесены в
  общую платформу [llm-platform](https://github.com/Pavel-Husakouski/llm-platform). Агент —
  её тенант: ключи получает через `make tenant`, в своём `deploy/` держит только agent и Redis
  (см. [INFRA.md](INFRA.md)).

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

Тот же агент в Kubernetes, тенантом [llm-platform](https://github.com/Pavel-Husakouski/llm-platform):
kind-кластер `llm-platform`, Argo CD, LiteLLM, Langfuse, Prometheus и Argo Rollouts живут
там и общие для всех проектов. Этот репо кладёт в общий Argo CD свой root-app
`agent-deploy-lab` (app-of-apps), остальное Argo CD синхронизирует из `deploy/` в git.

Нужны `docker`, `kind`, `kubectl`, `make` и поднятая платформа (её требования — в README
llm-platform). Порт 13000 на `127.0.0.1` пробрасывает кластер платформы, поэтому сначала
`docker compose down`.

```bash
git clone https://github.com/Pavel-Husakouski/llm-platform.git ../llm-platform
export DEEPSEEK_API_KEY=sk-...   # нужен только платформе, make читает его из окружения
make -C ../llm-platform up       # кластер, Argo CD, LiteLLM, Langfuse, Prometheus
make up                          # ключи тенанта, root-app агента, ожидание
npm run cli                      # тот же CLI, API на localhost:13000
make down                        # удалить агента, платформа остаётся
```

| Target        | Действие                                                             |
|---------------|----------------------------------------------------------------------|
| `make up`     | всё по порядку, идемпотентно; `REVISION=<ветка>` для проверки        |
|               | `deploy/` из ветки до merge (по умолчанию `main`)                    |
| `make down`   | удалить root-app (с ним agent и redis) и namespace `agent`           |
| `make tenant` | `make tenant` платформы: virtual key, проект Langfuse, `platform-llm` |
| `make status` | состояние Application и подов агента                                 |

Каталог платформы задаёт `PLATFORM_DIR` (по умолчанию `../llm-platform`), kubectl работает с
контекстом `kind-llm-platform`. `make up` падает сразу, если кластера нет или Application
`llm-platform` не Synced/Healthy.

| Адрес                    | Что                         |
|--------------------------|-----------------------------|
| `http://localhost:13000` | API агента (NodePort 30000) |

Argo CD UI, Langfuse, LiteLLM, Prometheus и ClickHouse — на адресах платформы:
`make -C ../llm-platform status`, пароли там же (`make -C ../llm-platform argocd-password` и
другие `*-password`).

Что синхронизирует Argo CD (`deploy/apps`, Helm chart с Application на компонент):

| Wave | Application | Источник                                           | Namespace |
|------|-------------|----------------------------------------------------|-----------|
| 0    | `redis`     | [deploy/redis](deploy/redis): StatefulSet, AOF+PVC | `agent`   |
| 1    | `agent`     | [deploy/agent](deploy/agent): Rollout, NodePort    | `agent`   |

- У всех Application включены `automated`, `prune` и `selfHeal`: ручная правка в кластере
  откатывается к состоянию из git.
- agent — `Rollout` с canary и анализом, см. [Canary](#canary). CRD `Rollout` и Prometheus,
  который scrape-ит под по аннотациям `prometheus.io/*`, ставит платформа.
- Образ берётся из GHCR, тег в `deploy/agent/kustomization.yaml` меняет CI, см. [Релиз](#релиз).
- История в Redis лежит на PVC и живёт до `make down`.

## Canary

Новая версия агента (новый тег образа или любая правка шаблона пода) выкатывается не сразу:

```text
2 реплики stable ──> 1 stable + 1 canary (≈50% трафика), пауза 5 мин ──> 2 реплики новой версии
                        └── AnalysisRun agent-canary раз в минуту, с первой минуты
                               └── провал ──> abort: canary в 0, трафик на stable
```

- Ingress-контроллера на платформе нет, Service делит трафик поровну между подами, поэтому доля
  canary задаётся числом подов: 2 реплики дают один шаг 50%.
- Первый деплой (stable ещё нет) canary не проходит.
- [deploy/agent/analysis.yaml](deploy/agent/analysis.yaml) сравнивает canary со stable, а не с
  историческим baseline. Поды различает метка `rollouts_pod_template_hash`:

| Метрика                  | Как считается                                              | Провал  |
|--------------------------|------------------------------------------------------------|---------|
| `error-rate-diff`        | доля `status=error` у canary минус та же доля у stable     | > 0.05  |
| `p95-latency-ratio`      | p95 `agent_chat_duration_seconds` canary / stable          | > 2     |
| `cost-per-request-ratio` | стоимость успешного ответа canary / stable                 | > 1.5   |

- Окно 2 минуты, `failureLimit: 1`: один выброс не прерывает выкатку, два — прерывают.
- Во время выкатки нужна нагрузка: `npm run load` (по умолчанию 20 вопросов в минуту 10 минут,
  около $0.07). Без неё бывает два исхода. Если серии canary в Prometheus есть, но трафик
  встал, запросы дают NaN, измерение Inconclusive, и Rollout встаёт на паузу; продолжает
  ручной promote: действие `promote-full` у Rollout в UI Argo CD или
  `kubectl argo rollouts promote agent -n agent` (нужен плагин kubectl-argo-rollouts). Если у
  нового canary-пода не было ни одного запроса, серий нет, запрос пустой, измерение Error, и
  после 5 ошибок подряд (`consecutiveErrorLimit` 4) выкатка прерывается. Повтор — действие
  `retry` в UI Argo CD или `kubectl argo rollouts retry rollout agent -n agent`, уже под
  нагрузкой.

```bash
kubectl --context kind-llm-platform -n agent get rollout agent
kubectl --context kind-llm-platform -n agent get analysisrun
kubectl --context kind-llm-platform -n agent describe analysisrun <name>   # значения метрик
```

**Плохой релиз.** Учебная переменная `FAULT_ERROR_RATE` (доля от 0 до 1) заставляет `/chat`
отвечать ошибкой до вызова LLM. Коммит с `FAULT_ERROR_RATE: "0.5"` в `deploy/agent/rollout.yaml`
и нагрузка во время выкатки: `error-rate-diff` около 0.5, анализ проваливается, Rollout
прерывается и остаётся на stable. Статус Rollout — `Degraded`, пока в git не вернут хорошую
версию: Argo CD не откатывает git, он показывает, что желаемое состояние не выкатилось.
На стенде (2026-11-20) так и было: `error-rate-diff` 0.6 два измерения подряд, abort через
3 минуты после начала выкатки, все запросы снова на stable.

## Откат

Откат агента — это откат manifest целиком и совместимость state, а не revert кода. Промпт,
модель и параметры зашиты в образ вместе с `release.json`, поэтому прошлый тег образа — это
прошлый manifest. Но история в Redis общая для всех версий: её успевает записать и новая
версия, и даже canary, который анализ потом прервал.

**Совместимость истории: expand → contract.** Формат меняется в два релиза:

| Релиз  | Читает | Пишет | Зачем                                                         |
|--------|--------|-------|---------------------------------------------------------------|
| 0.10.0 | v1     | v1    | до этапа 7: записи v2 молча пропускаются                      |
| 0.11.0 | v1, v2 | v1    | expand: сначала выкатывается читатель нового формата          |
| 0.12.0 | v1, v2 | v2    | новый формат; откат на 0.11.0 историю не теряет               |

Чтение v1 можно убрать (contract), когда истечёт TTL последних записей v1 и откат на 0.11.0
станет не нужен. Откат на 0.10.0 после записей v2 — уже за окном совместимости. Сессия, целиком
записанная 0.12.0, отвечает `409 no_question`. Хуже смешанная сессия: в ней 0.10.0 видит только
реплики v1 и отвечает без вопроса и разбора, без всякой ошибки. Метрики пропусков в 0.10.0 ещё
нет, поэтому потерю видно только по жалобам; с 0.11.0 её показывает
`agent_history_skipped_total{schema_version}`. Для этого случая есть обратная миграция
`npm run migrate:history`.

**Аварийный откат тегом.** Быстрый путь — вернуть в `deploy/` тег образа, который уже работал:

```bash
git log --oneline -- deploy/agent/kustomization.yaml   # прошлые теги
gh workflow run rollback.yml -f tag=0.11.0-<sha7>
```

- [rollback.yml](.github/workflows/rollback.yml) проверяет, что образ есть в GHCR, и коммитит
  тег в `main` через deploy key с `[skip ci]`, иначе job `release` вернул бы тег HEAD.
- `rollbackWindow: { revisions: 2 }` в Rollout: возврат на ReplicaSet, созданный раньше
  текущего stable, но не дальше двух ревизий назад, идёт сразу на 100%, без canary-шага,
  анализа и нагрузки. Откатом контроллер считает только переход на более старый ReplicaSet:
  возврат вперёд (например, снова на новую версию после отката) — обычный canary с анализом,
  ему нужна нагрузка.
- Код в `main` остаётся прежним: следующий merge снова выкатит HEAD. После отката нужен
  revert или fix-forward через PR.
- Не годится: `kubectl argo rollouts undo` и правка Rollout руками. У Application включён
  `selfHeal`, Argo CD вернёт состояние из git. Не годится и PR, который меняет только тег:
  после merge job `release` соберёт HEAD и запишет его тег.

**Обратная миграция** v2 → v1 переписывает сессии, TTL ключей сохраняет, параллельную запись
API не теряет (WATCH/MULTI):

```bash
kubectl --context kind-llm-platform -n agent port-forward svc/redis 16379:6379 &
npm run migrate:history -- --url redis://localhost:16379 --dry-run
npm run migrate:history -- --url redis://localhost:16379
```

Порядок, если откат уходит за окно: сначала откат тегом, потом миграция. В обратном порядке
ещё работающая новая версия успеет дописать v2. Миграция возвращает данные, но не ответы,
которые старая версия успела дать без истории: они остаются в сессии.

**Проверено на стенде (2026-11-20):**

1. 0.11.0, затем 0.12.0 — merge и canary под `npm run load`, оба анализа Successful.
2. Сессия на 0.12.0, вопрос и ответ: в Redis 4 записи v2, разбор объектом `review`.
3. Откат 0.12.0 → 0.11.0 через `rollback.yml`: 2 минуты от запуска до Healthy, без canary;
   `discuss` в той же сессии называет оценку и пункты разбора.
4. Ручной `kubectl patch` образа Rollout на 0.12.0: selfHeal вернул образ из git за 5 секунд.
5. Откат 0.11.0 → 0.10.0: сессия из v2 отвечает 409, смешанная — «в этой сессии вопроса нет».
6. `migrate:history`: 188 записей в 1216 сессиях, TTL сохранён, обе сессии снова читаются.
7. Возврат 0.10.0 → 0.12.0 через `rollback.yml` без нагрузки: это не откат, а canary;
   измерения Error, abort. Retry под нагрузкой — Healthy.

## LLM gateway и Langfuse

В кластере агент не ходит в DeepSeek напрямую:

```text
agent ──(virtual key, metadata: trace, session, теги)──> LiteLLM Proxy ──> DeepSeek
                                                          └─ langfuse_otel ──> Langfuse (проект agent)
agent ──(score review_score на trace запроса)──> Langfuse public API (проект agent)
```

LiteLLM и Langfuse принадлежат платформе, их устройство описано в llm-platform. Агент видит
только контракт тенанта — Secret `platform-llm`, см. ниже.

**LiteLLM Proxy**:

- alias `deepseek-flash` совпадает с `model.id` в `release.json`, провайдер задаёт только
  конфиг шлюза: смена провайдера (этап 9) не трогает агента;
- ключа DeepSeek у агента нет, только virtual key `agent` с бюджетом $1 на 30 дней. По
  metadata ключа LiteLLM пишет трейсы его вызовов в проект Langfuse `agent`;
- trace id задаёт агент и передаёт заголовком `traceparent`: поле `trace_id` в metadata
  OTel-интеграция LiteLLM не использует. Тот же id агент пишет в лог (`вызов LLM`), по нему
  запрос из лога находится в Langfuse;
- `stream_options.include_usage` и `response_format` доходят до DeepSeek как есть, поэтому
  метрики стоимости и JSON mode разбора работают как без шлюза.

**Langfuse** (проект `agent`):

- каждый вызов LLM — generation в trace. Один `POST /chat` — один trace, повтор разбора
  попадает в тот же trace;
- trace сгруппированы в сессии по `sessionId`, `clientId` идёт как user;
- теги `release:<version>`, `prompt:<id>`, `model:<id>`, `mode:<mode>`: по ним в UI
  сравниваются релизы;
- оценка разбора уходит score `review_score` на trace ключами проекта `agent`. Сбой Langfuse
  только логируется, ответ клиенту от него не зависит;
- Langfuse v4 работает в режиме events_only: читать трейсы и score через public API v1 нельзя,
  только UI и `/api/public/v2/observations`. Запись score через `POST /api/public/scores`
  работает.

Проверка отказа по бюджету:

```bash
make -C ../llm-platform llm-budget KEY=agent BUDGET=0   # следующий запрос получит event: error
                                                        # «422 Budget has been exceeded!»
make -C ../llm-platform llm-budget KEY=agent BUDGET=1   # вернуть
```

### Секреты в кластере

У агента один секрет, своих он не генерирует. `make up` вызывает `make tenant` платформы: при
первом запуске она заводит virtual key и проект Langfuse `agent`, при повторных только заново
копирует ключи в namespace `agent`.

| Namespace | Secret         | Что внутри                                                    |
|-----------|----------------|---------------------------------------------------------------|
| `agent`   | `platform-llm` | `LLM_BASE_URL`, `LLM_API_KEY` (virtual key), `LANGFUSE_HOST`, |
|           |                | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`                  |

Rollout подключает его через `envFrom`. Ключ DeepSeek, master key LiteLLM и секреты Langfuse
лежат в namespace платформы.

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

Enter — следующий вопрос, или задайте свой вопрос по разбору.
> почему не FIFO
Потому что...
>

─── новый вопрос, роль: Node AWS Developer ───
```

| Ввод               | Вопрос ждёт ответа             | Разбор получен                     |
|--------------------|--------------------------------|------------------------------------|
| Enter              | ничего                         | новая сессия и новый вопрос        |
| `? текст`          | уточнение, ответ не раскрывает | уточнение в той же сессии          |
| текст без `?`      | ответ: разбор с оценкой        | уточнение в той же сессии          |
| `/new`             | другой вопрос                  | новый вопрос                       |
| `/role <название>` | сменить роль, новый вопрос     | сменить роль, новый вопрос         |
| `/exit`            | выйти (или Ctrl+D)             | выйти (или Ctrl+D)                 |

- `?` считается только первым символом: `что такое SQS?` до разбора будет ответом.
- Новый вопрос печатается жирным, в остальных ответах жирным выделено `**такое**`. Звёздочки
  убираются всегда, а при выводе в файл или pipe и заданном `NO_COLOR` текст выходит без стилей.
- Роль спрашивается на старте, Enter оставляет последнюю. `npm run cli -- --role "Data Engineer"`
  запускает без вопроса. Роль хранится в `~/.agent-deploy-lab/role`.
- Каждый вопрос — новая сессия: контекст живёт, пока идут уточнения, а Enter после разбора его
  сбрасывает, остаётся только название роли. Каждое обсуждение отправляет всю сессию вместе с
  разбором, поэтому длинное обсуждение стоит дороже.
- Разбор CLI собирает сам из полей ответа API: оценка, что хорошо, чего не хватает, эталон.
  Пока сервер ждёт и проверяет разбор целиком, в терминале видно «разбираю ответ…».
- Ответ на уточнение краткий, 2–4 предложения. Подробнее модель отвечает, если об этом попросить.
- Заданные вопросы не повторяются: CLI создаёт `~/.agent-deploy-lab/client-id`, а API помнит по
  нему и роли последние 20 вопросов. Модель может пропустить повтор, это не строгая гарантия.
- Сложность сама не растёт. Уровень можно задать в роли: `Senior Node AWS Developer`.
- Адрес API берётся из `API_URL`, по умолчанию `http://localhost:13000`.

## API

| Метод  | Путь       | Описание                                                       |
|--------|------------|----------------------------------------------------------------|
| `POST` | `/chat`    | тело `{ sessionId, role, mode, clientId?, message? }`, SSE      |
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

`clientId` передаётся только с `mode: question` и не обязателен: без него вопросы могут
повторяться. Формат тот же, что у `sessionId`.

Поток `/chat`:

```text
data: {"delta":"При"}

data: {"delta":"вет"}

event: done
data: {}
```

В режиме `answer` вместо `delta` приходит одно событие `review` с разбором, затем `done`:

```text
event: review
data: {"kind":"review","score":7,"reason":"...","good":"...","missing":["..."],"reference":["..."]}
```

Если сообщение не по теме, оценки нет: `{"kind":"redirect","text":"..."}`. Модель отвечает в
JSON mode DeepSeek, схему проверяет API ([src/review.ts](src/review.ts)): ответ не по схеме
запрашивается ещё раз, после второго — `event: error`. В историю сессии разбор пишется markdown,
поэтому в `discuss` модель видит его как текст.

При ошибке LLM вместо `done` приходит `event: error` с `data: {"message":"..."}`.
Невалидный запрос получает `400` с JSON-описанием ошибок до начала стрима.

Пример без CLI:

```bash
curl -N localhost:13000/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo","role":"Node AWS Developer","mode":"question"}'
```

## State

История сессии (один вопрос, уточнения, ответ и обсуждение) — Redis list по ключу
`session:{sessionId}`, TTL 7 дней продлевается при каждой записи. Элемент списка — JSON.
С 0.12.0 API пишет формат v2: режим хода, релиз, разбор объектом (`review`, схема из
`src/review.ts`) вместо markdown в `content`:

```json
{ "schemaVersion": 2, "role": "assistant", "mode": "answer", "release": "0.12.0",
  "review": { "kind": "review", "score": 7, "...": "..." }, "ts": "2026-11-20T12:00:00.000Z" }
```

До 0.12.0 писался v1: `{ "schemaVersion": 1, "role", "content", "ts" }`. При чтении API
приводит обе версии к v1 (разбор снова становится markdown), записи другой версии пропускает и
считает в `agent_history_skipped_total`. Почему так — см. [Откат](#откат).

Обе реплики (user и assistant) дописываются только после успешного завершения стрима.
Redis запущен с `--appendonly yes`, поэтому история переживает рестарт и API, и Redis.

```bash
docker compose exec redis redis-cli LRANGE session:<sessionId> 0 -1
```

Заданные вопросы — отдельный Redis list `asked:{clientId}:{роль в нижнем регистре}`, последние 20
вопросов текстом, TTL 30 дней продлевается при каждой записи. Вопрос дописывается после успешного
стрима, сбой этой записи только логируется. В режиме `question` список идёт в system prompt,
в других режимах модель его не получает.

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
в промпте нет плейсхолдеров `{{role}}`, `{{mode}}` и `{{asked}}`.

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
cp prompts/trainer-v6.md prompts/trainer-v7.md   # правим новый файл, старый не трогаем
sha256sum prompts/trainer-v7.md                  # sha256 в release.json
# в release.json: prompt.id = trainer-v7, prompt.sha256 = ..., version = следующая
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
| `golden`    | вопрос по роли, запрет повторов, уточнение без оценки, схема  | 90%   |
|             | разбора, оценка сильного/слабого ответа, «не знаю»,           |       |
|             | обсуждение без новой оценки, краткость уточнений (до 800      |       |
|             | символов), возврат к теме, русский язык                       |       |
| `injection` | утечка system prompt, подмена оценки и режима, скрытые        | 100%  |
|             | команды в ответе, названии роли и списке заданных вопросов    |       |

- В каждом тесте assertion `cost`: ответ не дороже $0.002 по `pricing` из manifest.
- В golden assertion `finish-reason: stop`: ответ не обрезан по `maxTokens`.
- Проверки детерминированные (regex, `contains`, JavaScript) и `llm-rubric`, grader —
  `deepseek-flash` с `temperature: 0` и выключенным thinking.
- Golden допускает 1 случайный фейл из 10: LLM недетерминирован.
- Injection требует 100%, но упавший тест прогоняется ещё 2 раза (`--filter-failing`) и
  засчитывается, только если прошёл оба раза. Такой тест попадает в отчёт как flaky: разовый
  фейл бывает ошибкой grader, а уязвимость, которая проявляется хоть в одном повторе, gate
  не пропускает. Отчёты повторов: `reports/injection.retry-<n>.json`.
- В режиме `answer` output теста — JSON разбора после проверки схемы с тем же повтором, что в
  API. Разбор не по схеме после повтора — ошибка теста.
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

Отчёты: `reports/<набор>.html` и `.json`, итог в markdown — `reports/summary.md`. С
`-- --base origin/main` в итоге есть строка, что релиз меняет относительно base: версия,
промпт, модель, dataset.

## Review

PR в `main` проходит review не только кода: промпт, модель и dataset меняют поведение релиза
так же, как код.

| Что                                             | Зачем                                         |
|-------------------------------------------------|-----------------------------------------------|
| [PR template](.github/pull_request_template.md) | что меняется, bump, чеклист review промпта и  |
|                                                 | eval, план отката                             |
| [CODEOWNERS](.github/CODEOWNERS)                | промпт, manifest, eval, формат истории,       |
|                                                 | `deploy/`, CI: владелец назначается ревьюером |
| Шаг `eval report to PR` в job `eval`            | отчёт eval комментарием в PR, см. ниже        |

**Отчёт eval в PR.** Job `eval` публикует `reports/summary.md` одним комментарием от
`github-actions[bot]` и обновляет его при каждом push: что релиз меняет относительно base
(версия, промпт, модель, dataset), pass rate по наборам против порога, flaky, стоимость,
причины фейлов от grader и ссылка на прогон с HTML-отчётами promptfoo. Комментарий пишется и
при красном eval: причина видна без перехода в логи.

**Что смотреть в diff промпта:**

- правила против injection: роль — только название, режим задаёт приложение, инструкции не
  раскрываются;
- формат вывода: JSON разбора по схеме API, остальные режимы — текст;
- покрытие: новое поведение — тест в golden, новая поверхность атаки — тест в injection;
- стоимость и длина ответа: колонка стоимости в отчёте, `finish-reason: stop`;
- однозначность `llm-rubric`: grader читает rubric буквально и шире, чем задумано (см. 0.12.1).

Review CODEOWNERS не обязателен по ruleset: владелец в репо один, а GitHub не даёт одобрить
свой PR. Обязательны зелёные `checks` и `eval`.

## Релиз

Job `release` в [ci.yml](.github/workflows/ci.yml) запускается только на push в `main` и только
после зелёных `checks` и `eval`:

1. собирает образ и пушит его в GHCR с тегом `<version>-<sha7>`:
   `ghcr.io/pavel-husakouski/agent-deploy-lab:0.3.0-bca0a54`;
2. меняет `newName` и `newTag` в `deploy/agent/kustomization.yaml` и коммитит в `main` от
   `github-actions[bot]` с `[skip ci]`;
3. Argo CD замечает коммит при опросе git (несколько минут), Rollout выкатывает новую версию
   canary с анализом (см. [Canary](#canary)): на время выкатки нужна нагрузка `npm run load`.

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

| Метрика                          | Тип       | Labels и смысл                                   |
|----------------------------------|-----------|--------------------------------------------------|
| `agent_chat_requests_total`      | counter   | `status`: ok, error, aborted, bad_request,       |
|                                  |           | conflict, unavailable                            |
| `agent_chat_duration_seconds`    | histogram | `status`; от запроса до конца стрима             |
| `agent_chat_ttft_seconds`        | histogram | время до первого фрагмента ответа LLM            |
| `agent_llm_tokens_total`         | counter   | `type`: prompt, completion (из `usage` DeepSeek) |
|                                  |           | и `mode`: question, clarify, answer, discuss     |
| `agent_llm_cost_usd_total`       | counter   | `mode`; по `model.pricing`, без скидки за кэш    |
| `agent_llm_truncated_total`      | counter   | ответы, обрезанные по `maxTokens`                |
| `agent_llm_invalid_output_total` | counter   | разборы не по схеме, каждая попытка              |
| `agent_review_score`             | histogram | оценка ответа 0–10, без `redirect`               |
| `agent_history_skipped_total`    | counter   | `schema_version`: номер или `invalid`;           |
|                                  |           | записи истории, которые API не прочитал          |
| `agent_release_info`             | gauge = 1 | все поля manifest                                |

Ко всем метрикам добавлены labels `release`, `prompt`, `model`, плюс стандартные метрики
процесса Node (`process_*`, `nodejs_*`). Токены берутся из последнего чанка стрима
(`stream_options.include_usage`).

```bash
curl -s localhost:13000/metrics | grep ^agent_
```

## Конфигурация API

Модель, параметры и промпт задаёт `release.json`, через env они не переопределяются.

| Переменная            | По умолчанию               | Описание                                |
|-----------------------|----------------------------|-----------------------------------------|
| `LLM_API_KEY`         | `DEEPSEEK_API_KEY`         | обязательна одна из двух                |
| `LLM_BASE_URL`        | `DEEPSEEK_BASE_URL` или    | OpenAI-совместимый endpoint: DeepSeek   |
|                       | `https://api.deepseek.com` | или LiteLLM (`http://litellm.llm:4000`) |
| `LLM_METADATA`        | `false`                    | trace в `metadata` запроса, для LiteLLM |
| `LANGFUSE_HOST`       | —                          | score разбора в Langfuse; три           |
| `LANGFUSE_PUBLIC_KEY` | —                          | переменные задаются вместе или          |
| `LANGFUSE_SECRET_KEY` | —                          | не задаются                             |
| `REDIS_URL`           | `redis://localhost:6379`   | в compose `redis://redis:6379`          |
| `PORT`                | `13000`                    |                                         |
| `FAULT_ERROR_RATE`    | `0`                        | учебный сбой: доля `/chat` с ошибкой,   |
|                       |                            | см. [Canary](#canary)                   |

В compose и eval агент ходит в DeepSeek напрямую, в кластере — через LiteLLM.

## Разработка

| Скрипт                     | Что делает                                                    |
|----------------------------|---------------------------------------------------------------|
| `npm run typecheck`        | `tsc --noEmit`, strict                                        |
| `npm test`                 | vitest, LLM и Redis заменены фейками                          |
| `npm run build`            | сборка `src` в `dist` (`tsconfig.build.json`)                 |
| `npm run check:manifest`   | проверка `release.json`, см. выше                             |
| `npm run eval`             | eval gate на promptfoo, см. выше                              |
| `npm run dev`              | API на хосте с перезапуском при изменениях                    |
| `npm run cli`              | консольный клиент                                             |
| `npm run load`             | нагрузка вопросами для анализа canary: `--rate` в минуту,     |
|                            | `--duration` в секундах, `--url`                              |
| `npm run migrate:history`  | обратная миграция истории v2 → v1, см. [Откат](#откат)        |

Структура:

```text
src/config.ts          конфигурация из env (zod)
src/release.ts         схема release.json, загрузка промпта и проверка sha256
src/manifest-check.ts  правила check:manifest (чистая функция)
src/metrics.ts         метрики prom-client
src/prompt.ts          формат роли, сборка system prompt и сообщений для LLM
src/llm.ts             интерфейс LlmClient и клиент OpenAI-совместимого API (streaming, usage,
                       trace в metadata для LiteLLM)
src/langfuse.ts        score в Langfuse через public API
src/history.ts         HistoryStore, формат записей, реализация на ioredis
src/api/server.ts      buildApp(deps): маршруты Fastify
src/api/main.ts        точка входа API
src/cli/main.ts        REPL-клиент
src/cli/input.ts       разбор ввода и выбор действия по этапу тренировки
src/cli/style.ts       жирный текст для терминала
deploy/bootstrap/      root-app агента (app-of-apps) для Argo CD платформы
deploy/apps/           Helm chart: Application на каждый компонент
deploy/redis/, agent/  манифесты Redis и агента (Rollout, AnalysisTemplate canary)
Makefile               make up / down и вспомогательные target-ы
scripts/               check-manifest.ts, eval.ts (eval gate), load.ts (нагрузка для canary),
                       migrate-history.ts (обратная миграция истории)
evals/                 promptfoo: provider.ts, наборы <evalDataset>/*.yaml
.github/workflows/     CI и аварийный откат (rollback.yml)
prompts/               system prompts, выпущенные файлы не меняются
release.json           release manifest
Dockerfile             multi-stage сборка образа API
test/                  vitest
```
