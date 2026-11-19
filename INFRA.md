# Вынос LLM-инфраструктуры в общую платформу

План: LiteLLM, Langfuse, ClickHouse, Prometheus и Argo Rollouts уезжают в отдельный репо
`llm-platform` с долгоживущим kind-кластером. `agent-deploy-lab` становится одним из его
тенантов, и так же могут подключаться другие проекты.

Статус: шаги 0–3 выполнены (см. [Результаты шага 0](#результаты-шага-0) и
[Результаты шага 3](#результаты-шага-3)).

## Что влияет на план

- Score агента должен попасть в тот же проект Langfuse, куда LiteLLM пишет trace. Сейчас
  LiteLLM отправляет все трейсы с одной парой ключей (`llm/langfuse-api`). Если у каждого
  проекта свой проект Langfuse, LiteLLM должен выбирать ключи Langfuse по virtual key
  (key/team-based logging). Работает ли это с колбэком `langfuse_otel`, не проверено.
- Langfuse headless init (`LANGFUSE_INIT_*`) создаёт только один проект. Для остальных нужен
  API: org API key и `POST /api/public/projects`. Не проверено.
- Ключ агента регистрирует PostSync Job `litellm-agent-key` рядом с LiteLLM. На платформе его
  заменит `make tenant`, который выдаёт ключ любому проекту.
- Argo Rollouts (CRD) и Prometheus (scrape по аннотациям) работают на весь кластер, поэтому
  уезжают на платформу. Redis остаётся у агента.
- Порты kind задаются при создании кластера, поэтому платформа заранее резервирует диапазон
  под NodePort проектов.

## Целевая схема

```text
llm-platform (новый репо, кластер kind-llm-platform)
  Argo CD, argo-rollouts, prometheus, clickhouse, langfuse, litellm
  make up / down / tenant NAME=… NS=… BUDGET=… MODELS=…
        │ make tenant: virtual key LiteLLM, проект Langfuse с ключами,
        │ секрет platform-llm в namespace проекта
        ▼
agent-deploy-lab (этот репо, тенант)
  make up = проверить платформу → tenant → root-app в общий Argo CD → wait
  deploy/apps: только agent и redis
```

Контракт тенанта: Secret `platform-llm` в namespace проекта с ключами `LLM_BASE_URL`,
`LLM_API_KEY`, `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY` и `LANGFUSE_SECRET_KEY`. Проект
подключает его через `envFrom`.

## Шаги

### 0. Проверка (spike) в текущем кластере, без коммитов

1. LiteLLM с `langfuse_otel` пишет trace в проект, ключи которого заданы в metadata
   virtual key.
2. Через org API key создаётся проект Langfuse и его API-ключи.
3. Если не работает п. 1: один общий проект Langfuse на всех, проекты различаются тегом
   `project:<name>`. Если не работает п. 2: первый проект создаёт init, остальные заводятся в
   UI вручную, и `make tenant` подсказывает, как это сделать.

### 1. Репо `llm-platform`

`~/@/llm-platform`, на GitHub `Pavel-Husakouski/llm-platform`. Репо публичный, чтобы Argo CD
читал его без кредов.

1. Перенести `deploy/litellm` (без `agent-key.yaml`), `deploy/langfuse` (ClickHouse) и
   шаблоны Application для litellm, langfuse, clickhouse, prometheus и argo-rollouts. Из
   этого собрать `deploy/apps` платформы и `deploy/bootstrap` с Argo CD values и root-app.
2. `deploy/kind/cluster.yaml` с кластером `llm-platform`: порты 18080, 19090, 13300, 14000,
   18123 и 19000, плюс резерв 13000–13009 → 30000–30009 под API проектов.
3. `Makefile` с целями `up`, `down`, `secret`, `argocd`, `root`, `wait`, `status`,
   `*-password` и `llm-budget KEY=<alias> BUDGET=<usd>`. Новая цель
   `tenant NAME= NS= BUDGET= MODELS=` идемпотентна: повторный запуск не пересоздаёт ключи.
4. `scripts/platform-secrets.sh`: часть `k8s-secrets.sh` про deepseek, litellm и langfuse.
   `scripts/tenant.sh`: virtual key, проект Langfuse и Secret `platform-llm`.
5. CI с проверкой манифестов kubeconform (перенести из `ci.yml` агента), README и короткая
   SPEC с контрактом тенанта.
6. Коммит и push в `main` нового репо. Это первый коммит, ветки ещё нет.

### 2. `agent-deploy-lab`, ветка `stage-11`

1. Удалить `deploy/litellm`, `deploy/langfuse`, `deploy/kind` и шаблоны clickhouse,
   langfuse, litellm, prometheus и argo-rollouts. Из `deploy/apps/values.yaml` убрать
   charts, которые больше не нужны.
2. `deploy/agent/rollout.yaml`: заменить отдельные env на `envFrom: platform-llm`. Адреса
   `litellm.llm:4000` и `langfuse-web.langfuse:3000` теперь приходят из секрета.
3. Переименовать root-app из `root` в `agent-deploy-lab`, чтобы не конфликтовать с root
   платформы.
4. `Makefile`: `PLATFORM_DIR ?= ../llm-platform`, контекст `kind-llm-platform`.
   - `up` проверяет платформу, вызывает `make -C $(PLATFORM_DIR) tenant NAME=agent NS=agent
     BUDGET=1 MODELS=deepseek-flash`, затем применяет root-app и ждёт;
   - `down` удаляет Application и namespace `agent`, кластер не трогает;
   - `wait` проверяет только свои Application.
5. `scripts/k8s-secrets.sh` свести к секретам самого агента или удалить. Удалить
   `scripts/llm-budget.sh`: бюджет теперь меняется через платформу.
6. Убрать из `.github/workflows/ci.yml` проверки удалённых каталогов. Job release, который
   пишет тег в `deploy/agent`, не меняется.
7. Обновить README (разделы «Кластер», «LLM gateway и Langfuse», «Секреты в кластере») и
   SPEC: всё, что относится к платформе, заменить ссылкой на `llm-platform`.
8. Коммиты, push ветки и draft PR в `main`.

### 3. Проверка end-to-end

1. `make down` старого кластера `agent-deploy-lab`. Трейсы Langfuse и spend LiteLLM из него
   не переносятся.
2. В `llm-platform`: `make up`, затем `make status`.
3. В `agent-deploy-lab`: `make up REVISION=stage-11`, затем `npm run cli`.
4. Убедиться:
   - trace со score появились в проекте Langfuse агента;
   - spend растёт на ключе агента;
   - `make llm-budget BUDGET=0` в платформе даёт 422;
   - `make down` агента оставляет платформу живой.
5. Прогнать `npm test` и CI на PR.

## Результаты шага 0

Проверено 2026-11-19 в кластере `agent-deploy-lab`: LiteLLM v1.108.9, Langfuse 4.77.0
(chart 2.2.4). После проверки кластер возвращён в исходное состояние.

### Маршрутизация трейсов LiteLLM по virtual key: работает

Если у virtual key в metadata задан `logging` с колбэком `langfuse_otel`, trace уходит в
проект Langfuse тенанта, а в глобальный проект (env `LANGFUSE_*` у LiteLLM) не дублируется.
Score, который тенант отправляет своими ключами через `POST /api/public/scores` на этот
trace, принимается (200). Схема агента (trace пишет LiteLLM, score пишет агент) работает для
любого тенанта.

```json
{
  "key_alias": "<tenant>",
  "models": ["deepseek-flash"],
  "max_budget": 1,
  "budget_duration": "30d",
  "metadata": {
    "logging": [{
      "callback_name": "langfuse_otel",
      "callback_type": "success_and_failure",
      "callback_vars": {
        "langfuse_public_key": "pk-lf-…",
        "langfuse_secret_key": "sk-lf-…",
        "langfuse_host": "http://langfuse-web.langfuse:3000"
      }
    }]
  }
}
```

Глобальный колбэк и env `LANGFUSE_*` у LiteLLM остаются: туда попадают вызовы ключей без
`logging`, например ключа master. Для них headless init создаёт проект `platform`.

### Проекты Langfuse программно: только через внутренний tRPC

- Org API keys и `POST /api/public/projects` закрыты в OSS-версии:
  `POST /api/admin/organizations/{id}/apiKeys` с `ADMIN_API_KEY` отвечает
  `403 This feature is not available on your current plan`, а tRPC
  `organizationApiKeys.create` требует entitlement `admin-api`.
- Работает путь, которым пользуется UI. Вход пользователем init (`GET /api/auth/csrf`, затем
  `POST /api/auth/callback/credentials` с email, password и csrfToken), потом с cookie сессии
  POST в `/api/trpc/<procedure>` с телом `{"json": {...}}`:
  - `projects.create` `{name, orgId}` возвращает `id`;
  - `projectApiKeys.create` `{projectId, note}` возвращает `publicKey` и `secretKey`;
  - `projects.delete` `{projectId}` удаляет проект.
- `ADMIN_API_KEY` не нужен.
- tRPC — внутренний API UI, он может поменяться между версиями. Версия chart Langfuse
  зафиксирована, `tenant.sh` проверяет ответы и падает с понятной ошибкой. После обновления
  Langfuse нужно прогнать `make tenant` на тестовом тенанте.

### Что это меняет в шагах 1–2

- Решение «отдельный проект Langfuse на тенанта» подтверждено, запасной путь с тегом не
  нужен.
- `tenant.sh` работает с хоста через NodePort: LiteLLM на `localhost:14000` (master key),
  Langfuse на `localhost:13300` (пользователь init). PostSync Job и `kubectl exec` не нужны.
- Идемпотентность. Ключи тенанта хранятся в Secret платформы `tenant-<name>` (namespace
  `llm`). Если Secret есть, проект и ключи не создаются заново, только копируется
  `platform-llm` в namespace тенанта. Так же, как `once` в нынешнем `k8s-secrets.sh`.
- Headless init платформы: org `llm-platform`, проект `platform` для вызовов без тенанта.
  Проекты тенантов создаёт `tenant.sh`.

### Замечание для будущих проверок

`kubectl set env` на ресурсе под Argo CD не считается drift: Application остаётся Synced,
и selfHeal такое поле не убирает. Временные правки нужно откатывать вручную.

## Результаты шага 3

Проверено 2026-11-19: кластер `llm-platform` с нуля, агент из ветки `stage-11`.

- `make up` платформы: все 6 Application Synced/Healthy. `make up REVISION=stage-11` агента:
  `make tenant` создал virtual key `agent`, проект Langfuse `agent` и Secret `platform-llm`
  (`LLM_BASE_URL=http://litellm.llm:4000`, `LANGFUSE_HOST=http://langfuse-web.langfuse:3000`).
- Вопрос и ответ через API агента: trace `chat-question` и `chat-answer` пишутся в проект
  `agent`, trace id совпадает с логом агента. Score `review_score` агент отправил своими ключами
  на этот trace, Langfuse его принял (warn о сбое нет, метрика `agent_review_score_count` = 1).
- Spend растёт на ключе `agent` (`/key/info` с ключом тенанта).
- `make llm-budget KEY=agent BUDGET=0`: вызов модели ключом агента даёт
  `422 budget_exceeded`. После `BUDGET=1` снова 200.
- Повторный `make tenant`: «ключи не пересоздаются», Secret `tenant-agent` не меняется.
- `make down` агента удаляет Application и namespace `agent`, платформа остаётся Synced/Healthy.
  Следующий `make up` берёт тот же ключ, spend продолжается.

Что выяснилось по ходу:

- Langfuse 4 работает в режиме `events_only`: `GET /api/public/traces` и `GET /api/public/scores`
  отвечают, что endpoint недоступен. Читать trace можно через `GET /api/public/v2/observations`,
  score видно только в UI. `POST /api/public/scores` работает.
- Образ агента в kind не собирается: Argo CD берёт его из GHCR по тегу в
  `deploy/agent/kustomization.yaml`. Пока ветка не влита и CI не выпустил новый образ, для
  проверки нового кода образ собирают локально и грузят в узел:
  `docker build -t agent-deploy-lab:<tag> . && kind load docker-image agent-deploy-lab:<tag>
  --name llm-platform`, а тег временно меняют в kustomization. Временный коммит этапа 10 с
  локальным образом откачен перед merge.
- `PLATFORM_DIR ?= ../llm-platform` рассчитан на checkout в `~/@/agent-deploy-lab`. Из
  git worktree путь нужно передавать явно: `make up PLATFORM_DIR=~/@/llm-platform`.

## Решения по умолчанию

- Имя репо `llm-platform`, публичный.
- Отдельный проект Langfuse на каждого тенанта: подтверждено шагом 0.
- Данные старого кластера не мигрируются.
- Отдельный AppProject Argo CD для каждого тенанта (ограничение его namespace) пока не
  делается, это можно добавить позже.
