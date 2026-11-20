# agent-deploy-lab: спецификация (черновик)

> **Статус:** утверждён к этапу 1, 2026-10-28; этап 5 готов 2026-11-02; этап 10 (вне очереди,
> до этапа 6) готов 2026-11-16; этап 11 (вне очереди) готов 2026-11-19; этап 6 готов
> 2026-11-20. Следующий — этап 7.
> Открытые вопросы в конце файла закрыть к их этапам.

## Контекст для сессии

> Этот файл читает отдельная сессия без истории предыдущих разговоров.
>
> - **Зачем:** пользователь готовится к интервью на позицию AI Agent Engineer. Нужен
>   тренировочный стенд, на котором руками проходится весь путь доставки агента: версионирование,
>   release checks, canary, rollback, IaC, code review.
> - **Теория:** `~/@/edu/ai/agent-delivery-cicd.md` (подпункты темы, на них ссылаются этапы).
> - **Порядок работы:** перед каждым этапом показать план и ждать «жги». Делать один этап,
>   в конце проверить критерии готовности на живом стенде, остановиться.
> - **Правила:**
>   - не читать `.env`-файлы и любые файлы с `.env` в имени;
>   - код на TypeScript;
>   - текст на русском, термины на английском;
>   - в `.md` строки до 100 символов, таблицы выровнены.

## Цель и не-цели

**Цель:** небольшое, но «настоящее» агентное приложение и pipeline вокруг него, где можно:
- сломать промпт и увидеть, как его не пускает eval gate;
- выкатить новую версию canary-релизом и посмотреть автооткат по метрикам;
- откатить релиз, когда новая версия уже записала state;
- поднять всю инфраструктуру с нуля одной командой `make up` (kind + Argo CD, остальное
  по app-of-apps из git).

**Не-цели:**
- продуктовое качество ассистента, UI, авторизация пользователей;
- облачный деплой в основном стенде (Terraform в облаке вынесен в опциональный этап 9);
- high availability и нагрузочное тестирование.

## Приложение

Ассистент-тренер к интервью на DeepSeek: роль задаёт клиент, тренер задаёт вопрос, поясняет его
по запросу, оценивает ответ, даёт правильный ответ и обсуждает его. Enter после разбора начинает
новый вопрос в новой сессии, из прошлой переиспользуется только название роли.

| Компонент  | Описание                                                                         |
|------------|----------------------------------------------------------------------------------|
| API        | Fastify: `POST /chat`, `GET /healthz`, `GET /metrics` (Prometheus)               |
| CLI-клиент | REPL на `readline`, streaming; после разбора текст — уточнение, Enter — дальше   |
| LLM        | пакет `openai`: в compose DeepSeek напрямую, в кластере через LiteLLM Proxy      |
| Трейсы     | Langfuse: trace на запрос, сессии, теги релиза, score разбора                    |
| State      | Redis: история диалога по `sessionId`, в записи есть `schemaVersion`             |
| Промпты    | `prompts/*.md`, версию выбирает `release.json`                                   |
| Manifest   | `release.json`: версия, модель, параметры, версия и sha256 промпта, eval dataset |
| Метрики    | requests, errors, latency, токены, стоимость запроса, версия релиза в labels     |

Пример manifest:

```json
{
  "version": "1.2.0",
  "model": { "id": "deepseek-flash", "temperature": 0.3, "maxTokens": 1024 },
  "prompt": { "id": "trainer-v7", "sha256": "…" },
  "evalDataset": "golden-v7"
}
```

## Стенд

**Выбран вариант A: kind (Kubernetes in Docker).** Нужен только Docker и бинарники `kind`,
`kubectl`, `helm`, `make`. Ресурсы: примерно 4-6 GB RAM со всем стеком.

Почему не Docker Compose: canary и автооткат там пришлось бы писать скриптами. Argo Rollouts
и Argo CD дают те же механизмы, что в проде, и на интервью это весомее.

С этапа 11 кластер kind, Argo CD, Argo Rollouts, Prometheus, LiteLLM и Langfuse живут в
отдельном репо [llm-platform](https://github.com/Pavel-Husakouski/llm-platform) и общие для
нескольких проектов. agent-deploy-lab — тенант платформы: `make tenant` выдаёт ему virtual
key LiteLLM и проект Langfuse, в своём `deploy/` остаются только agent и Redis. План переноса —
[INFRA.md](INFRA.md).

## Архитектура

```text
PR ──> GitHub Actions: typecheck, vitest, manifest check, promptfoo (golden, injection, cost)
   ──> merge в main ──> build образа ──> push в GHCR (тег = версия + sha)
                    ──> коммит нового тега в deploy/ (k8s-манифесты)

llm-platform (make -C ../llm-platform up, отдельный репо):
  kind create cluster ──> helm install argo-cd ──> root-app llm-platform
  ──> Applications: Argo Rollouts, Prometheus, LiteLLM, ClickHouse, Langfuse

bootstrap агента (make up):
  проверка платформы ──> make tenant (virtual key, проект Langfuse, Secret platform-llm)
  ──> kubectl apply root-app.yaml (agent-deploy-lab) ──> Applications: Redis, agent

локальный kind (кластер llm-platform):
  Argo CD ──(pull)──> GitHub repo: видит новый тег в deploy/
          ──> Argo Rollouts: canary 50% → 100% (2 реплики)
                 └── AnalysisTemplate: Prometheus, canary против stable
                     (error rate, p95 latency, cost)
                 └── анализ не прошёл ──> автооткат на stable
  Redis: история диалогов, Prometheus: метрики
  agent ──> LiteLLM Proxy (virtual key, бюджет) ──> DeepSeek
                └── трейсы ──> Langfuse <── score разбора ── agent
```

Все соединения исходящие со стороны кластера: self-hosted runner, белый IP и туннели не нужны.

## Стек

| Слой                | Инструмент                                                         |
|---------------------|--------------------------------------------------------------------|
| Язык, runtime       | TypeScript, Node.js 26                                             |
| HTTP                | Fastify                                                            |
| Тесты               | vitest (LLM замокан)                                               |
| Eval, red team      | promptfoo, provider `deepseek:deepseek-flash`, grader на DeepSeek  |
| Образы              | Docker, GHCR                                                       |
| CI                  | GitHub Actions                                                     |
| Кластер             | kind, общий кластер llm-platform                                   |
| Bootstrap           | Makefile: проверка платформы, `make tenant`, root-app              |
| IaC                 | Argo CD app-of-apps (`deploy/bootstrap/root-app.yaml`)             |
| CD (GitOps)         | Argo CD                                                            |
| Выкатка             | Argo Rollouts                                                      |
| Метрики             | Prometheus (kube-prometheus-stack или минимальный chart)           |
| State               | Redis                                                              |
| LLM gateway         | LiteLLM Proxy: alias модели, virtual key с бюджетом, ретраи        |
| Трейсы LLM          | Langfuse self-hosted, chart `langfuse`, свой ClickHouse            |
| Облачный IaC (опц.) | Terraform, этап 9                                                  |

## Этапы

| #  | Что делаем                                                           | Подпункт темы      |
|----|----------------------------------------------------------------------|--------------------|
| 1  | API + CLI + DeepSeek + Redis, локально через `docker compose`        | база               |
| 2  | Промпты в файлах, `release.json` с sha256, Dockerfile, `/metrics`    | 1. версионирование |
| 3  | GitHub Actions: typecheck, vitest, manifest check, promptfoo         | 2. release checks  |
| 4  | Makefile + Argo CD app-of-apps: Rollouts, Prometheus, Redis из git   | 5. IaC             |
| 5  | GitOps: CI коммитит тег в `deploy/`, Argo CD синхронизирует          | CD                 |
| 6  | Canary с AnalysisTemplate, автооткат по метрикам                     | 3. выкатка         |
| 7  | Сценарии отката: «сломанный» релиз; v2 пишет историю в новом формате | 4. rollback        |
| 8  | PR template, CODEOWNERS на `prompts/`, отчёт promptfoo в PR, runbook | 6. review и docs   |
| 9  | (опц.) Terraform в облаке: managed LLM endpoint + budget alert       | 5. IaC             |
| 10 | LiteLLM Proxy и self-hosted Langfuse (сделан до этапа 6)             | наблюдаемость      |
| 11 | Инфраструктура в llm-platform, агент — тенант (INFRA.md)             | IaC                |

**Критерии готовности:**

1. Диалог из CLI работает, история переживает рестарт API.
2. Правка промпта без bump версии ловится скриптом проверки manifest.
3. PR со сломанным промптом или injection-уязвимостью красный, merge заблокирован.
4. `make up` с нуля поднимает стенд, вся инфраструктура кроме Argo CD синхронизируется из git;
   `make down` полностью сносит кластер. С этапа 11 стенд — платформа и агент: кластер поднимает
   и сносит `make up` / `make down` в llm-platform, а `make down` агента удаляет только его
   Application и namespace.
5. Merge в `main` сам доезжает до кластера без ручных команд.
6. Плохой релиз откатывается сам по метрикам, хороший доходит до 100% после анализа.
7. После отката v1 читает записи, сделанные v2, или есть обратная миграция.
8. Runbook отката проходится по шагам без подсказок.
9. (опц.) `terraform plan` показывает diff, `apply`/`destroy` управляют endpoint и budget
   alert, state не в git.
10. Стенд поднимает LiteLLM и Langfuse (с этапа 11 — платформа); в поде агента нет ключа
    DeepSeek; в Langfuse на каждый запрос trace с токенами, стоимостью, тегами релиза и
    сессией, у разбора score; урезанный бюджет virtual key даёт понятную ошибку; метрики агента
    не изменились.
11. `make up` агента поверх поднятой платформы: trace и score в проекте Langfuse агента, spend
    на его ключе; `make down` агента оставляет платформу живой.

## Что нужно от GitHub

| Компонент         | Зачем                                  | Что настроить                     |
|-------------------|----------------------------------------|-----------------------------------|
| Репозиторий       | код, промпты, k8s-манифесты для GitOps | создать                           |
| GitHub Actions    | CI, сборка образа, bump тега           | ничего, workflow лежат в репо     |
| GHCR              | хранение образов                       | ничего, push через `GITHUB_TOKEN` |
| Secrets           | `DEEPSEEK_API_KEY` для promptfoo       | вручную или `gh secret set`       |
| Ruleset на `main` | merge только после зелёного eval gate  | bypass только для deploy key      |
| Deploy key        | push тега в `main` из job `release`    | write-ключ, секрет `DEPLOY_KEY`   |
| Окружение         | `DEPLOY_KEY` доступен только `main`    | `release`, branch policy `main`   |

**Рекомендация: public репозиторий.**

| Что                 | Public           | Private (free plan)                       |
|---------------------|------------------|-------------------------------------------|
| Минуты Actions      | без лимита       | 2000 мин/мес                              |
| Branch protection   | есть             | недоступно                                |
| Argo CD читает репо | без доступа      | deploy key или PAT                        |
| Pull образа из GHCR | без авторизации* | `imagePullSecret` с PAT (`read:packages`) |

\* После первого push проверить visibility пакета: у GHCR-пакета своя настройка видимости.

## Секреты

- `DEEPSEEK_API_KEY` хранится только в GitHub Secrets (для CI) и в k8s Secret платформы
  (`make up` llm-platform из переменной окружения пользователя, не в git). В кластере он лежит
  только в namespace `llm` у LiteLLM.
- Секреты LiteLLM и Langfuse генерирует платформа, см. llm-platform. У агента один Secret
  `platform-llm` (virtual key, адреса и ключи проекта Langfuse `agent`), его создаёт
  `make tenant` платформы, в git его нет.
- В репозитории нет ключей, `.env` в `.gitignore`, `terraform.tfstate` в `.gitignore`
  (для этапа 9).
- `DEPLOY_KEY` (write deploy key) лежит только в окружении `release`, PR-ветки его не получают.
- Ассистент (Claude) ключ не читает и не видит: пользователь кладёт его сам.

## Решения

| Вопрос        | Решение                                                                 |
|---------------|-------------------------------------------------------------------------|
| Репозиторий   | public, название `agent-deploy-lab`                                     |
| Кто создаёт   | Claude через `gh repo create` (на этапе 1)                              |
| Node.js       | 26 (LTS с октября 2026, установлена локально), образ `node:26-slim`     |
| Окружение     | есть `docker` 29.7, `gh` 2.100, `kind` 0.32, `kubectl` 1.36, `helm` 4.2 |
| Окружение     | есть `make` 4.4, `git` 2.55, `node` 26.12; RAM 30 GB, свободно ~16 GB   |
| `gh` scopes   | нет `workflow`: до push `.github/workflows` выполнить                   |
|               | `gh auth refresh -s workflow`                                           |
| Feature flags | не делаем: промпт меняется релизом и проходит тот же canary             |
| Canary        | 2 реплики, шаг 50% и пауза 5 мин, анализ canary против stable;          |
|               | без трафика Inconclusive и пауза, нагрузка — `npm run load`             |
| Плохой релиз  | учебная env `FAULT_ERROR_RATE`: доля `/chat` с ошибкой до вызова LLM    |
| Eval provider | свой `evals/provider.ts` вместо `deepseek:deepseek-flash`: промпт,      |
|               | модель и параметры из `release.json`, вызов через `src/llm.ts`          |
| Eval gate     | golden ≥ 90%, injection 100%, cost ≤ $0.002 на ответ                    |
| Платформа     | кластер, Argo CD, Argo Rollouts, Prometheus, LiteLLM, Langfuse — в      |
|               | llm-platform, агент — тенант (`make tenant`, Secret `platform-llm`);    |
|               | решения по ним описаны там                                              |
| Redis в k8s   | свои манифесты (StatefulSet, AOF на PVC), без Bitnami chart             |
| Образ         | CI пушит в GHCR, тег `<version>-<sha7>`, пакет public                   |
| Push тега     | deploy key с bypass в ruleset, секрет в окружении `release`             |
| agent в k8s   | `Rollout` с этапа 4, canary с анализом с этапа 6                        |
| Доступ        | API 13000 → NodePort 30000 из резерва 13000–13009 платформы,            |
|               | остальные порты (Argo CD, Langfuse, LiteLLM...) — у платформы           |
| Роль          | свободный текст от клиента, формат и eval injection, не хранится в API  |
| Режим хода    | `mode` в запросе, подставляет API, текст пользователя на него не влияет |
| Контекст      | сессия = вопрос и обсуждение, разбор между сессиями не передаётся       |
| Повторы       | последние 20 вопросов по `clientId` и роли в Redis, TTL 30 дней         |
| Уточнение     | до ответа `clarify` без эталона, после разбора `discuss` без оценки     |
| Разбор        | JSON mode, схема в API, один повтор; клиенту `event: review`, в историю |
|               | markdown; остальные режимы — текст потоком                              |
| Краткость     | уточнения: правило в промпте и eval, `maxTokens` обрывал бы ответ       |
| Трейсы        | LiteLLM пишет trace в проект Langfuse агента по metadata virtual key    |
|               | (`logging` с `langfuse_otel`), см. INFRA.md, шаг 0                      |
| Score         | агент шлёт `review_score` в public API Langfuse, trace id задаёт сам и  |
|               | передаёт LiteLLM в `traceparent`: `trace_id` из metadata не работает    |

## Открытые вопросы

1. Облако для этапа 9 (Bedrock / Azure OpenAI / Vertex)? Решить перед этапом 9.
