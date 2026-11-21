# Runbook: агент в кластере

Что делать, когда релиз агента пошёл не так. Каждый сценарий: **симптомы → диагностика →
действие → проверка → что после**. Устройство canary, отката и eval gate — в
[README](README.md): [Canary](README.md#canary), [Откат](README.md#откат),
[CI и eval gate](README.md#ci-и-eval-gate).

## 0. Подготовка

Нужны `kubectl`, `gh` (с доступом к репо), `curl`, Node.js и клон репо. Команды ниже
выполняются из корня репо.

```bash
make -C ../llm-platform tools           # плагин kubectl-argo-rollouts версии контроллера, один раз
alias k='kubectl --context llm-platform -n agent'
# у плагина флаги идут после имени: kubectl --context ... argo rollouts не работает
alias kar='kubectl argo rollouts --context llm-platform -n agent'
API=http://192.168.50.195:30000         # API агента: NodePort 30000 на хосте k3s
# итог AnalysisRun по метрикам, используется в сценарии 1
AR='{range .status.metricResults[*]}{.name}: {.phase} {.measurements[*].value}{.message}{"\n"}{end}'
make -C ../llm-platform status          # адреса Argo CD, Prometheus, Langfuse, LiteLLM
make -C ../llm-platform argocd-password # пароль admin в UI Argo CD
```

| Что               | Где                                                                |
|-------------------|--------------------------------------------------------------------|
| API агента        | `http://192.168.50.195:30000`                                      |
| Argo CD UI        | `http://192.168.50.195:30080`, Application `agent`                 |
| Prometheus        | `http://192.168.50.195:30090`                                      |
| Langfuse          | `http://192.168.50.195:30300`, проект `agent`, теги `release:<v>`  |
| LiteLLM UI        | `http://192.168.50.195:30400/ui`                                   |

Платформа — k3s на хосте `192.168.50.195`, context `llm-platform`.

**Что сейчас в проде и что хочет git.** С этого начинается любой сценарий:

```bash
curl -s $API/healthz                     # release, который отвечает
kar get rollout agent                               # шаги, ревизии, поды, AnalysisRun
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
  kubectl --context llm-platform -n argocd annotate application agent \
    argocd.argoproj.io/refresh=normal --overwrite
  ```

**Действия над идущей выкаткой.** Меняют статус Rollout, а не spec, поэтому `selfHeal` их не
откатывает:

| Когда                                         | Плагин                    | UI Argo CD     |
|-----------------------------------------------|---------------------------|----------------|
| пауза `InconclusiveAnalysisRun`, причина ясна | `kar promote agent`       | `promote-full` |
| abort после Error анализа (не было нагрузки)  | `kar retry rollout agent` | `retry`        |
| остановить выкатку вручную                    | `kar abort agent`         | `abort`        |

- Promote после `Inconclusive` не пропускает анализ: контроллер запускает новый AnalysisRun
  (`<имя>.1`), поэтому нагрузка должна идти. Без плагина и UI тот же promote — патч status:

  ```bash
  k patch rollout agent --subresource=status --type=merge \
    -p '{"status":{"pauseConditions":null}}'
  ```

- Перед promote убрать причину паузы: нет нагрузки, исчерпан бюджет LLM (сценарий 5).

**Чего не делать.** `kubectl argo rollouts undo`, `kubectl patch` или `kubectl edit` spec
Rollout: у Application включён `selfHeal`, Argo CD вернёт состояние из git за секунды. Образ и
шаблон пода меняются только через git: merge, `rollback.yml`.

## 1. Canary прервался по анализу

**Симптомы.** Application `agent` в Argo CD — Synced, но Degraded. У Rollout фаза `Degraded`,
в сообщении `RolloutAborted`. Последний AnalysisRun — `Failed`. Пользователи затронуты мало:
canary получал около половины трафика минуты две-три. Через полминуты после abort canary-под
удаляется, stable снова 2/2.

AnalysisRun в фазе `Successful` с сообщением `Run Terminated` — не одобрение: эту ревизию
сменила следующая, не дождавшись анализа. Так бывает, если PR меняет `deploy/`: Argo CD сначала
синхронизирует merge-коммит со старым образом, а через пару минут — коммит тега от `release`.

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

2. Что именно сломалось. Canary-под после abort удалён, поэтому смотреть Prometheus по хэшу
   шаблона пода (хэш canary — в имени AnalysisRun, `agent-<хэш>-<ревизия>`) и Langfuse по
   тегу `release:<версия>`. Метка `release` не поможет, если версия не менялась:

   ```promql
   sum by (rollouts_pod_template_hash, status) (rate(agent_chat_requests_total[10m]))
   ```

3. Что поменял релиз: diff PR, который выкатывался, и комментарий eval в нём.
   `git log --oneline -3 origin/main` — merge-коммит PR и коммит тега от бота. Главный вопрос
   для действия — менялся ли `deploy/`:

   ```bash
   git diff --stat <merge-коммит>^1 <merge-коммит> -- deploy/
   ```

**Действие.** Прод уже на stable, срочно откатывать нечего, но git и кластер расходятся:
Rollout остаётся Degraded, пока git не вернут к рабочему состоянию. Как — зависит от того, где
плохое изменение:

| PR менял                                  | Действие                                      |
|-------------------------------------------|-----------------------------------------------|
| только образ: код, промпт, `release.json` | шаг 1 (тег stable), затем шаг 2               |
| `deploy/`: env, ресурсы, анализ           | **только шаг 2**, `rollback.yml` не запускать |

`rollback.yml` меняет только тег образа. Если плохое изменение в `deploy/`, тег stable вместе с
ним даёт шаблон, которого у stable нет. Если такой шаблон уже был ревизией в пределах
`rollbackWindow`, Argo Rollouts выкатит его сразу на 100% без анализа: плохой релиз в проде.

1. Вернуть в git тег stable. Шаблон совпадёт со stable, Rollout сразу станет Healthy без
   canary.

   ```bash
   k get rs -o wide   # образ ReplicaSet с репликами, тег вида 0.12.0-b023859
   gh workflow run rollback.yml -f tag=<тег stable>
   gh run list --workflow rollback.yml --limit 1   # id прогона
   gh run watch <id>
   ```

2. Исправить `main` через PR (пока он не влит, следующий merge снова выкатит HEAD):
   - **revert:** `git revert -m 1 <merge-коммит>` в новой ветке. Если PR поднимал `version`,
     после revert она уменьшится, а `check:manifest` это запрещает: поднять до следующей
     версии. Выпущенный промпт не трогается, manifest снова ссылается на старый id;
   - **fix-forward:** исправление с новой версией, если причина понятна и чинится быстро.

   Merge проходит canary с анализом: нужна нагрузка `npm run load`.

**Проверка.** `k get rollout agent` — 2/2, фаза `Healthy`; `curl -s $API/healthz`
отвечает версией stable; Application `agent` — Synced, Healthy.

**Что после.** Если причина в отсутствии теста, добавить тест в golden или injection.

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
   `rollback.yml` откатывает только образ. Если после целевого тега менялся `deploy/`, эти
   изменения останутся: сначала решить, нужен ли их revert (см. сценарий 1).

   ```bash
   git log --oneline <коммит тега>..origin/main -- deploy/ ':!deploy/agent/kustomization.yaml'
   ```

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
kubectl --context llm-platform -n argocd annotate application agent \
  argocd.argoproj.io/refresh=normal --overwrite   # не ждать опроса git
k get rollout agent -w                            # Ctrl-C, когда 2/2 на новом образе
```

- `rollback.yml` проверяет формат тега и наличие образа и коммитит тег в `main` с `[skip ci]`.
- Ревизия не дальше двух назад (`rollbackWindow`) выкатывается сразу на 100%, без canary и
  нагрузки, обычно за 1–2 минуты. Более старая проходит canary: запустить `npm run load` и
  ждать анализа.

**Проверка.**

```bash
curl -s $API/healthz                                    # release = целевой версии
curl -s $API/metrics | grep agent_history_skipped_total # нет роста
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
| Golden ниже 90% после повторов            | регресс поведения       | чинить промпт            |
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
у всех версий сразу, а не только у canary. Идущая выкатка встаёт на паузу
`InconclusiveAnalysisRun`: canary и stable падают одинаково, сравнивать нечего. Так было
2026-11-20 при исчерпанном бюджете: после его подъёма — promote, см. раздел 0.

**Диагностика.**

```bash
# warn (40) и error (50): «ошибка при генерации ответа» с текстом ошибки шлюза
k logs -l app.kubernetes.io/name=agent --tail=500 | grep -E '"level":(40|50)' | tail -20
kubectl --context llm-platform -n argocd get application litellm langfuse
kubectl --context llm-platform -n llm get pods
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
kubectl --context llm-platform -n langfuse get pods
k logs -l app.kubernetes.io/name=agent --tail=500 | grep 'score в Langfuse'
```

Trace пишет LiteLLM, а не агент, поэтому при живом Langfuse смотреть логи LiteLLM в
namespace `llm`. По trace id из лога агента (`вызов LLM`) запрос ищется в Langfuse.

**Проверка.** Запрос из `npm run cli` проходит, `status="ok"` растёт, trace появился.

## Проверено на стенде (2026-11-20)

Сценарии 1 и 2 пройдены по тексту, без подсказок; по итогам поправлен сценарий 1.

1. Плохой релиз (PR #27, `FAULT_ERROR_RATE: "0.5"` в `deploy/`) под `npm run load`:
   ревизия 19 (merge-коммит со старым образом) — `Run Terminated`, ревизия 20 с новым тегом —
   `error-rate-diff` 0.20 и 0.44, abort, Degraded. Canary-под удалён через полминуты.
2. Диагностика: итог AnalysisRun через `$AR`, Prometheus по `rollouts_pod_template_hash`
   показал ошибки только у canary, `git diff --stat` — изменение в `deploy/`.
3. Действие по таблице сценария 1: `rollback.yml` не запускался, revert через PR #28. Две
   ревизии под нагрузкой, обе Successful, Application Synced и Healthy.
4. Сценарий 2: `rollback.yml` на `0.12.1-38202cb` (ревизия 21, в `rollbackWindow`):
   50 секунд от запуска workflow до Healthy, без canary и анализа; `/healthz` и счётчики
   ошибок и пропусков истории — в норме.

Ошибка, найденная проходом: прежний сценарий 1 велел вернуть тег stable через `rollback.yml`.
При плохом изменении в `deploy/` это дало бы шаблон ревизии 19 и выкатку на 100% без анализа.
