# Вынос LLM-инфраструктуры в общую платформу

План: LiteLLM, Langfuse, ClickHouse, Prometheus и Argo Rollouts уезжают в отдельный репо
`llm-platform` с долгоживущим kind-кластером. `agent-deploy-lab` становится одним из его
тенантов, и так же могут подключаться другие проекты.

Статус: план, не выполнен.

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

## Решения по умолчанию

- Имя репо `llm-platform`, публичный.
- Отдельный проект Langfuse на каждого тенанта. Если шаг 0 не пройдёт, общий проект с
  тегом `project:<name>`.
- Данные старого кластера не мигрируются.
- Отдельный AppProject Argo CD для каждого тенанта (ограничение его namespace) пока не
  делается, это можно добавить позже.
