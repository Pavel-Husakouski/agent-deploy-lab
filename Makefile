# Стенд агента — тенант llm-platform: кластер (k3s на хосте или локальный kind), Argo CD, LiteLLM, Langfuse, Prometheus и
# Argo Rollouts поднимает платформа (make -C $(PLATFORM_DIR) up). make up здесь получает ключи
# тенанта (make tenant платформы) и кладёт root-app агента в общий Argo CD, остальное Argo CD
# синхронизирует из git.

PLATFORM_DIR   ?= ../llm-platform
PLATFORM       := llm-platform
# Ветка, из которой Argo CD берёт deploy/: make up REVISION=stage-4
REVISION       ?= main
WAIT_TIMEOUT   ?= 900
# Application агента: make wait не ждёт Application платформы и других тенантов.
APPS           := agent-deploy-lab redis agent

# Тенант платформы: virtual key LiteLLM, проект Langfuse и Secret platform-llm в namespace agent.
TENANT         := agent
NAMESPACE      := agent
BUDGET         ?= 1
MODELS         ?= deepseek-flash

# Где кластер платформы — те же TARGET и HOST, что в Makefile llm-platform: k3s на HOST
# (по умолчанию) или kind в локальном docker. API агента — NodePort 30000.
TARGET         ?= k3s
HOST           ?= 192.168.50.195
ifeq ($(TARGET),k3s)
CONTEXT        := $(PLATFORM)
API_URL        := http://$(HOST):30000
else ifeq ($(TARGET),kind)
CONTEXT        := kind-$(PLATFORM)
API_URL        := http://localhost:13000
else
$(error TARGET=$(TARGET): нужно k3s или kind)
endif

KUBECTL := kubectl --context $(CONTEXT)

.PHONY: up down platform tenant root wait status

up: platform tenant root wait status

# Удаляет только приложения агента: finalizer root-app снимает agent и redis. Платформа и
# ключи тенанта остаются, следующий make up возьмёт те же ключи.
down:
	$(KUBECTL) -n argocd delete application agent-deploy-lab --ignore-not-found --wait
	$(KUBECTL) delete namespace $(NAMESPACE) --ignore-not-found --wait

platform:
	@$(KUBECTL) get --raw /readyz >/dev/null 2>&1 \
	  || { echo "кластер $(CONTEXT) недоступен: make -C $(PLATFORM_DIR) up TARGET=$(TARGET)" >&2; exit 1; }
	@s=$$($(KUBECTL) -n argocd get application $(PLATFORM) \
	  -o jsonpath='{.status.sync.status}/{.status.health.status}' 2>/dev/null || true); \
	[ "$$s" = Synced/Healthy ] \
	  || { echo "платформа не готова ($${s:-нет Application $(PLATFORM)}): make -C $(PLATFORM_DIR) up TARGET=$(TARGET)" >&2; exit 1; }

tenant:
	$(MAKE) -C $(PLATFORM_DIR) tenant TARGET=$(TARGET) HOST=$(HOST) NAME=$(TENANT) NS=$(NAMESPACE) BUDGET=$(BUDGET) MODELS=$(MODELS)

root:
	sed 's#targetRevision: main#targetRevision: $(REVISION)#' deploy/bootstrap/root-app.yaml \
	  | $(KUBECTL) apply -f -

# Ждём, пока все Application агента станут Synced и Healthy.
wait:
	@echo "ждём Synced/Healthy (до $(WAIT_TIMEOUT)s)"
	@end=$$(( $$(date +%s) + $(WAIT_TIMEOUT) )); \
	while :; do \
	  pending=''; \
	  for app in $(APPS); do \
	    s=$$($(KUBECTL) -n argocd get application $$app \
	      -o jsonpath='{.status.sync.status}/{.status.health.status}' 2>/dev/null || true); \
	    [ "$$s" = Synced/Healthy ] || pending="$$pending $$app=$${s:-missing}"; \
	  done; \
	  if [ -z "$$pending" ]; then echo "все Application агента готовы"; break; fi; \
	  if [ $$(date +%s) -ge $$end ]; then echo "timeout:$$pending"; exit 1; fi; \
	  sleep 5; \
	done

status:
	@$(KUBECTL) -n argocd get applications $(APPS)
	@$(KUBECTL) get pods -n $(NAMESPACE)
	@echo "API:        $(API_URL) (CLI: API_URL=$(API_URL) npm run cli)"
	@echo "Платформа (Argo CD, Langfuse, LiteLLM, Prometheus): make -C $(PLATFORM_DIR) status TARGET=$(TARGET)"
