# agent-deploy-lab: спецификация (черновик)

> **Статус:** утверждён к этапу 1, 2026-10-28. Открытые вопросы в конце файла закрыть к их этапам.

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

Ассистент-тренер к интервью на DeepSeek: задаёт вопросы по теме, оценивает ответ пользователя,
даёт правильный ответ и хранит историю сессии.

| Компонент  | Описание                                                                         |
|------------|----------------------------------------------------------------------------------|
| API        | Fastify: `POST /chat`, `GET /healthz`, `GET /metrics` (Prometheus)               |
| CLI-клиент | консольный REPL на `readline`, ходит в API, streaming ответа                     |
| LLM        | DeepSeek через пакет `openai` с `baseURL: https://api.deepseek.com`              |
| State      | Redis: история диалога по `sessionId`, в записи есть `schemaVersion`             |
| Промпты    | `prompts/*.md`, выбор версии через feature flag или `release.json`               |
| Manifest   | `release.json`: версия, модель, параметры, версия и sha256 промпта, eval dataset |
| Метрики    | requests, errors, latency, токены, стоимость запроса, версия релиза в labels     |

Пример manifest:

```json
{
  "version": "1.2.0",
  "model": { "id": "deepseek-chat", "temperature": 0.3, "maxTokens": 1024 },
  "prompt": { "id": "trainer-v3", "sha256": "…" },
  "evalDataset": "golden-v1"
}
```

## Стенд

**Выбран вариант A: kind (Kubernetes in Docker).** Нужен только Docker и бинарники `kind`,
`kubectl`, `helm`, `make`. Ресурсы: примерно 4-6 GB RAM со всем стеком.

Почему не Docker Compose: canary и автооткат там пришлось бы писать скриптами. Argo Rollouts
и Argo CD дают те же механизмы, что в проде, и на интервью это весомее.

## Архитектура

```text
PR ──> GitHub Actions: typecheck, vitest, manifest check, promptfoo (golden, injection, cost)
   ──> merge в main ──> build образа ──> push в GHCR (тег = версия + sha)
                    ──> коммит нового тега в deploy/ (k8s-манифесты)

bootstrap (make up):
  kind create cluster ──> helm install argo-cd ──> kubectl apply root-app.yaml
  root-app (app-of-apps) ──> Applications: Argo Rollouts, Prometheus, Redis, agent

локальный kind:
  Argo CD ──(pull)──> GitHub repo: видит новый тег в deploy/
          ──> Argo Rollouts: canary 10% → 50% → 100%
                 └── AnalysisTemplate: Prometheus (error rate, p95 latency, cost)
                 └── анализ не прошёл ──> автооткат на stable
  Redis: история диалогов, Prometheus: метрики
```

Все соединения исходящие со стороны кластера: self-hosted runner, белый IP и туннели не нужны.

## Стек

| Слой                | Инструмент                                                         |
|---------------------|--------------------------------------------------------------------|
| Язык, runtime       | TypeScript, Node.js 26                                             |
| HTTP                | Fastify                                                            |
| Тесты               | vitest (LLM замокан)                                               |
| Eval, red team      | promptfoo, provider `deepseek:deepseek-chat`, grader тоже DeepSeek |
| Образы              | Docker, GHCR                                                       |
| CI                  | GitHub Actions                                                     |
| Кластер             | kind                                                               |
| Bootstrap           | Makefile: `kind create`, `helm install argo-cd`, root-app          |
| IaC                 | Argo CD app-of-apps (`deploy/bootstrap/root-app.yaml`)             |
| CD (GitOps)         | Argo CD                                                            |
| Выкатка             | Argo Rollouts                                                      |
| Метрики             | Prometheus (kube-prometheus-stack или минимальный chart)           |
| Feature flags       | flagd (OpenFeature SDK), процентный rollout версии промпта         |
| State               | Redis                                                              |
| Облачный IaC (опц.) | Terraform, этап 9                                                  |

## Этапы

| # | Что делаем                                                           | Подпункт темы      |
|---|----------------------------------------------------------------------|--------------------|
| 1 | API + CLI + DeepSeek + Redis, локально через `docker compose`        | база               |
| 2 | Промпты в файлах, `release.json` с sha256, Dockerfile, `/metrics`    | 1. версионирование |
| 3 | GitHub Actions: typecheck, vitest, manifest check, promptfoo         | 2. release checks  |
| 4 | Makefile + Argo CD app-of-apps: Rollouts, Prometheus, Redis из git   | 5. IaC             |
| 5 | GitOps: CI коммитит тег в `deploy/`, Argo CD синхронизирует          | CD                 |
| 6 | Canary с AnalysisTemplate, feature flag на версию промпта            | 3. выкатка         |
| 7 | Сценарии отката: «сломанный» релиз; v2 пишет историю в новом формате | 4. rollback        |
| 8 | PR template, CODEOWNERS на `prompts/`, отчёт promptfoo в PR, runbook | 6. review и docs   |
| 9 | (опц.) Terraform в облаке: managed LLM endpoint + budget alert       | 5. IaC             |

**Критерии готовности:**

1. Диалог из CLI работает, история переживает рестарт API.
2. Правка промпта без bump версии ловится скриптом проверки manifest.
3. PR со сломанным промптом или injection-уязвимостью красный, merge заблокирован.
4. `make up` с нуля поднимает стенд, вся инфраструктура кроме Argo CD синхронизируется из git;
   `make down` полностью сносит кластер.
5. Merge в `main` сам доезжает до кластера без ручных команд.
6. Плохой релиз откатывается сам по метрикам; флаг переключает промпт без деплоя.
7. После отката v1 читает записи, сделанные v2, или есть обратная миграция.
8. Runbook отката проходится по шагам без подсказок.
9. (опц.) `terraform plan` показывает diff, `apply`/`destroy` управляют endpoint и budget
   alert, state не в git.

## Что нужно от GitHub

| Компонент         | Зачем                                  | Что настроить                     |
|-------------------|----------------------------------------|-----------------------------------|
| Репозиторий       | код, промпты, k8s-манифесты для GitOps | создать                           |
| GitHub Actions    | CI, сборка образа, bump тега           | ничего, workflow лежат в репо     |
| GHCR              | хранение образов                       | ничего, push через `GITHUB_TOKEN` |
| Secrets           | `DEEPSEEK_API_KEY` для promptfoo       | вручную или `gh secret set`       |
| Branch protection | merge только после зелёного eval gate  | правило на `main`                 |

**Рекомендация: public репозиторий.**

| Что                 | Public           | Private (free plan)                       |
|---------------------|------------------|-------------------------------------------|
| Минуты Actions      | без лимита       | 2000 мин/мес                              |
| Branch protection   | есть             | недоступно                                |
| Argo CD читает репо | без доступа      | deploy key или PAT                        |
| Pull образа из GHCR | без авторизации* | `imagePullSecret` с PAT (`read:packages`) |

\* После первого push проверить visibility пакета: у GHCR-пакета своя настройка видимости.

## Секреты

- `DEEPSEEK_API_KEY` хранится только в GitHub Secrets (для CI) и в k8s Secret в локальном
  кластере (создаётся вручную или `make up` из переменной окружения пользователя, не в git).
- В репозитории нет ключей, `.env` в `.gitignore`, `terraform.tfstate` в `.gitignore`
  (для этапа 9).
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
| Feature flags | flagd: процент и таргетинг по `sessionId`, смена без рестарта пода      |

## Открытые вопросы

1. Облако для этапа 9 (Bedrock / Azure OpenAI / Vertex)? Решить перед этапом 9.
