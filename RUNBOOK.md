# Runbook: агент в кластере

Что делать, когда релиз агента пошёл не так. Каждый сценарий: **симптомы → диагностика →
действие → проверка → что после**. Устройство canary, отката и eval gate — в
[README](README.md): [Canary](README.md#canary), [Откат](README.md#откат),
[CI и eval gate](README.md#ci-и-eval-gate).

## 0. Подготовка

Нужны `kubectl`, `gh` (с доступом к репо), `curl`, Node.js и клон репо. Команды ниже
выполняются из корня репо.

```bash
alias k='kubectl --context kind-llm-platform -n agent'
# итог AnalysisRun по метрикам, используется в сценарии 1
AR='{range .status.metricResults[*]}{.name}: {.phase} {.measurements[*].value}{.message}{"\n"}{end}'
make -C ../llm-platform status          # адреса Argo CD, Prometheus, Langfuse, LiteLLM
make -C ../llm-platform argocd-password # пароль admin в UI Argo CD
```

| Что               | Где                                                                |
|-------------------|--------------------------------------------------------------------|
| API агента        | `http://localhost:13000`                                           |
| Argo CD UI        | `http://localhost:18080`, Application `agent`                      |
| Prometheus        | `http://localhost:19090`                                           |
| Langfuse          | `http://localhost:13300`, проект `agent`, теги `release:<version>` |
| LiteLLM UI        | `http://localhost:14000/ui`                                        |

**Что сейчас в проде и что хочет git.** С этого начинается любой сценарий:

```bash
curl -s localhost:13000/healthz                     # release, который отвечает
k get rollout agent                                 # реплики; статус — в UI или ниже
k get rollout agent -o jsonpath='{.status.phase} {.status.message}{"\n"}'
k get rs -o wide                                    # ReplicaSet → образ, у какого реплики
k get analysisrun --sort-by=.metadata.creationTimestamp | tail -3
git fetch -q && git log --oneline -5 origin/main -- deploy/agent/kustomization.yaml
```

- У ReplicaSet с репликами — текущий stable. Пустые ReplicaSet — прошлые ревизии, тег их образа
  годится для отката.
- Тег в `deploy/agent/kustomization.yaml` на `main` — то, что хочет git. Если он не совпадает
  с образом stable, выкатка идёт или прервана.
- Argo CD опрашивает git раз в несколько минут. Ускорить:

  ```bash
  kubectl --context kind-llm-platform -n argocd annotate application agent \
    argocd.argoproj.io/refresh=normal --overwrite
  ```

**Чего не делать.** `kubectl argo rollouts undo`, `kubectl patch` или `kubectl edit` Rollout:
у Application включён `selfHeal`, Argo CD вернёт состояние из git за секунды. Состояние
выкатки меняется только через git: merge, `rollback.yml`. Исключение — действия Rollout
(`promote-full`, `retry`, `abort`) в UI Argo CD: они меняют статус, а не spec.

## 1. Canary прервался по анализу

**Симптомы.** Application `agent` в Argo CD — Synced, но Degraded. У Rollout фаза `Degraded`,
в сообщении `RolloutAborted`. Последний AnalysisRun — `Failed`. Пользователи затронуты мало:
canary получал около половины трафика минуты две-три, потом весь трафик вернулся на stable.

**Диагностика.**

1. Какая метрика провалилась:

   ```bash
   k get analysisrun --sort-by=.metadata.creationTimestamp | tail -1
   k get analysisrun <имя> -o jsonpath="$AR"   # метрика: фаза, значения, ошибка
   ```

   | Метрика                  | Провал | Куда смотреть                                         |
   |--------------------------|--------|-------------------------------------------------------|
   | `error-rate-diff`        | > 0.05 | логи и `agent_chat_requests_total{status="error"}`    |
   | `p95-latency-ratio`      | > 2    | `agent_chat_duration_seconds`, ответ длиннее, модель  |
   | `cost-per-request-ratio` | > 1.5  | `agent_llm_cost_usd_total`, токены, `maxTokens`       |

2. Что именно сломалось. Canary-под после abort удалён, поэтому смотреть Prometheus по
   метке `release` и Langfuse по тегу `release:<новая версия>`:

   ```promql
   sum by (release, status) (rate(agent_chat_requests_total[10m]))
   ```

3. Что поменял релиз: diff PR, который выкатывался, и комментарий eval в нём.
   `git log --oneline -3 origin/main` — merge-коммит PR и коммит тега от бота.

**Действие.** Прод уже на stable, срочно откатывать нечего, но git и кластер расходятся:
следующая синхронизация снова попробует плохой тег. Порядок:

1. Вернуть в git тег stable. Rollout сразу станет Healthy: желаемое совпало с stable, canary
   не нужен.

   ```bash
   k get rs -o wide   # образ ReplicaSet с репликами, тег вида 0.12.0-b023859
   gh workflow run rollback.yml -f tag=<тег stable>
   gh run list --workflow rollback.yml --limit 1   # id прогона
   gh run watch <id>
   ```

2. Исправить код в `main` через PR (пока он не влит, следующий merge снова выкатит HEAD):
   - **revert:** `git revert -m 1 <merge-коммит>` в новой ветке. `version` в `release.json`
     после revert уменьшится, а `check:manifest` это запрещает: поднять до следующей версии.
     Выпущенный промпт при этом не трогается, manifest просто снова ссылается на старый id;
   - **fix-forward:** исправление с новой версией, если причина понятна и чинится быстро.

**Проверка.** `k get rollout agent` — 2/2, фаза `Healthy`; `curl -s localhost:13000/healthz`
отвечает версией stable; Application `agent` — Synced, Healthy.

**Что после.** PR с revert или фиксом проходит обычный canary: на время выкатки нужна нагрузка
`npm run load`. Если причина в отсутствии теста, добавить тест в golden или injection.

## 2. Аварийный откат тегом

Релиз прошёл canary, но плохой: жалобы, падает `agent_review_score`, в Langfuse плохие ответы,
кончается бюджет. Анализ canary этого не поймал.

**Диагностика.**

1. На какую версию откатываться:

   ```bash
   k get rs -o wide                                       # прошлые ревизии и их образы
   git log --oneline origin/main -- deploy/agent/kustomization.yaml | head
   ```

   Тег должен быть собран (есть в GHCR) — это любой тег из истории `kustomization.yaml`.

2. Совместима ли история в Redis. Целевая версия должна читать формат, который пишет текущая:

   | Текущая пишет | Целевая версия       | Что делать           |
   |---------------|----------------------|----------------------|
   | v1            | любая                | откат тегом          |
   | v2 (≥ 0.12.0) | читает v2 (≥ 0.11.0) | откат тегом          |
   | v2 (≥ 0.12.0) | только v1 (≤ 0.10.0) | за окном: сценарий 3 |

   Меняет ли релиз формат, написано в его PR, раздел «План отката» шаблона.

**Действие.**

```bash
gh workflow run rollback.yml -f tag=<тег>
gh run list --workflow rollback.yml --limit 1     # id прогона
gh run watch <id>
kubectl --context kind-llm-platform -n argocd annotate application agent \
  argocd.argoproj.io/refresh=normal --overwrite   # не ждать опроса git
k get rollout agent -w                            # Ctrl-C, когда 2/2 на новом образе
```

- `rollback.yml` проверяет формат тега и наличие образа и коммитит тег в `main` с `[skip ci]`.
- Ревизия не дальше двух назад (`rollbackWindow`) выкатывается сразу на 100%, без canary и
  нагрузки, обычно за 1–2 минуты. Более старая проходит canary: запустить `npm run load` и
  ждать анализа.

**Проверка.**

```bash
curl -s localhost:13000/healthz                                    # release = целевой версии
curl -s localhost:13000/metrics | grep agent_history_skipped_total # нет роста
k get rs -o wide                                                   # реплики у целевого образа
```

Короткий диалог в `npm run cli`: вопрос, ответ, разбор.

**Что после.** Код в `main` прежний: следующий merge снова выкатит HEAD. Revert или
fix-forward через PR, как в шаге 2 сценария 1.

## 3. Откат за окно совместимости истории

Целевая версия не читает формат, который уже записала текущая: например, откат на 0.10.0
после 0.12.0. Без миграции сессии в v2 отвечают `409 no_question`, а смешанные сессии теряют
реплики v2 молча.

**Порядок важен: сначала откат, потом миграция.** В обратном порядке ещё работающая новая
версия успеет дописать v2.

1. Откат тегом — шаги [сценария 2](#2-аварийный-откат-тегом). Целевая ревизия может быть за
   `rollbackWindow`: тогда она идёт через canary, нужна нагрузка.
2. Убедиться, что новой версии не осталось ни одной реплики: `k get rs -o wide`.
3. Обратная миграция v2 → v1:

   ```bash
   k port-forward svc/redis 16379:6379 &
   npm run migrate:history -- --url redis://localhost:16379 --dry-run   # сколько перепишет
   npm run migrate:history -- --url redis://localhost:16379
   kill %1
   ```

   Миграция идемпотентна, TTL сохраняет, параллельные записи API не теряет (WATCH/MULTI).
   Повторный запуск должен показать 0 записей.

**Проверка.** Сессия, начатая на новой версии, в CLI снова продолжается: уточнение по вопросу
отвечает по теме, а не «в этой сессии вопроса нет».

**Что после.** Ответы, которые старая версия успела дать без истории, в сессиях остаются.
Revert или fix-forward в `main`, как в сценарии 1.

## 4. Eval gate красный

**Симптомы.** У PR или push в `main` красный job `eval`. Merge заблокирован, а на `main` не
запускается `release`: прод не затронут, новая версия просто не выезжает.

**Диагностика.** Комментарий бота в PR или Job Summary прогона:

| Что в отчёте                              | Что это                 | Действие                 |
|-------------------------------------------|-------------------------|--------------------------|
| Фейл injection после повторов             | стабильная уязвимость   | чинить промпт, не        |
|                                           |                         | перезапускать            |
| Golden ниже 90%, причины grader по делу   | регресс поведения       | чинить промпт            |
| Причина grader противоречит output модели | двусмысленный rubric    | уточнить rubric, bump    |
| Ошибки провайдера: 429, 5xx, timeout      | сбой DeepSeek или сети  | `gh run rerun <id>`      |
|                                           |                         | `--failed`               |
| Flaky при зелёном gate                    | шум, gate прошёл        | повторяется — rubric     |

Output модели и причина grader — в HTML-отчёте promptfoo:

```bash
gh run download <id> -n eval-reports -D reports-ci
xdg-open reports-ci/injection.html
```

**Действие.** Перезапускать прогон, чтобы «проскочить», можно только при ошибках провайдера.
Фейл после повторов — это три фейла из трёх, а не случайность.

**Проверка.** Новый push: комментарий бота обновился, `eval` зелёный.

## 5. Ответы с ошибкой LLM

**Симптомы.** CLI получает `event: error`, растёт `agent_chat_requests_total{status="error"}`
у всех версий сразу, а не только у canary.

**Диагностика.**

```bash
# warn (40) и error (50): «ошибка при генерации ответа» с текстом ошибки шлюза
k logs -l app.kubernetes.io/name=agent --tail=500 | grep -E '"level":(40|50)' | tail -20
kubectl --context kind-llm-platform -n argocd get application litellm langfuse
kubectl --context kind-llm-platform -n llm get pods
```

| В логе                          | Причина                       | Действие                      |
|---------------------------------|-------------------------------|-------------------------------|
| `422 Budget has been exceeded!` | кончился бюджет virtual key   | поднять бюджет, см. ниже      |
| `ECONNREFUSED`, 502, 503        | LiteLLM не работает           | поды в `llm`, Application     |
|                                 |                               | `litellm` в Argo CD           |
| 401 от LiteLLM                  | Secret `platform-llm` устарел | `make tenant`, затем удалить  |
|                                 |                               | поды агента: env читается при |
|                                 |                               | старте                        |

```bash
make -C ../llm-platform llm-budget KEY=agent BUDGET=<usd>
make tenant && k delete pod -l app.kubernetes.io/name=agent
```

- Бюджет: spend ключа виден в LiteLLM UI (Virtual Keys → `agent`). Поднимать бюджет — решение
  о деньгах, сначала понять, откуда расход: `agent_llm_cost_usd_total` по `mode` и `release`.
- Ошибки только у одной версии — это не шлюз, а релиз: сценарий 1 или 2.

**Langfuse без трейсов.** Ответы идут, но в проекте `agent` нет новых trace. На клиента это не
влияет: агент только логирует сбой Langfuse.

```bash
kubectl --context kind-llm-platform -n langfuse get pods
k logs -l app.kubernetes.io/name=agent --tail=500 | grep 'score в Langfuse'
```

Trace пишет LiteLLM, а не агент, поэтому при живом Langfuse смотреть логи LiteLLM в
namespace `llm`. По trace id из лога агента (`вызов LLM`) запрос ищется в Langfuse.

**Проверка.** Запрос из `npm run cli` проходит, `status="ok"` растёт, trace появился.
