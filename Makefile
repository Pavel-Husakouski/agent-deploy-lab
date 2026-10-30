# Стенд в kind: make up поднимает кластер и Argo CD, остальное Argo CD синхронизирует из git.
# Ключ DeepSeek берётся только из переменной окружения DEEPSEEK_API_KEY, .env не читается.

CLUSTER        := agent-deploy-lab
KIND_CONFIG    := deploy/kind/cluster.yaml
KIND_IMAGE     := kindest/node:v1.37.0
ARGOCD_CHART   := 10.11.6
ARGOCD_REPO    := https://argoproj.github.io/argo-helm
IMAGE          := agent-deploy-lab:dev
# Ветка, из которой Argo CD берёт deploy/: make up REVISION=stage-4
REVISION       ?= main
WAIT_TIMEOUT   ?= 600

KUBECTL := kubectl --context kind-$(CLUSTER)
HELM    := helm --kube-context kind-$(CLUSTER)

.PHONY: up down cluster image secret argocd root wait status argocd-password

up: cluster image secret argocd root wait status

down:
	kind delete cluster --name $(CLUSTER)

cluster:
	@if kind get clusters | grep -qx '$(CLUSTER)'; then \
	  echo "cluster $(CLUSTER) уже есть"; \
	else \
	  kind create cluster --config $(KIND_CONFIG) --image $(KIND_IMAGE); \
	fi

# До этапа 5 образ не в registry: собираем локально и загружаем в ноду kind.
image:
	docker build -t $(IMAGE) \
	  --build-arg VERSION=$$(node -p "require('./release.json').version") \
	  --build-arg GIT_SHA=$$(git rev-parse --short HEAD) .
	kind load docker-image $(IMAGE) --name $(CLUSTER)
	@# Тег тот же, поэтому после пересборки под перезапускается явно.
	@if $(KUBECTL) -n agent get rollout agent >/dev/null 2>&1; then \
	  $(KUBECTL) -n agent patch rollout agent --type merge \
	    -p "{\"spec\":{\"restartAt\":\"$$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}"; \
	fi

secret:
	@test -n "$$DEEPSEEK_API_KEY" || { echo "задайте DEEPSEEK_API_KEY в окружении" >&2; exit 1; }
	@$(KUBECTL) create namespace agent --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@# Ключ идёт через stdin, а не аргументом: не виден в списке процессов.
	@printf '%s' "$$DEEPSEEK_API_KEY" | $(KUBECTL) -n agent create secret generic deepseek \
	  --from-file=DEEPSEEK_API_KEY=/dev/stdin --dry-run=client -o yaml | $(KUBECTL) apply -f -

argocd:
	$(HELM) upgrade --install argocd argo-cd --repo $(ARGOCD_REPO) --version $(ARGOCD_CHART) \
	  --namespace argocd --create-namespace \
	  --values deploy/bootstrap/argocd-values.yaml --wait --timeout 10m

root:
	sed 's/targetRevision: main/targetRevision: $(REVISION)/' deploy/bootstrap/root-app.yaml \
	  | $(KUBECTL) apply -f -

# Ждём, пока все Application станут Synced и Healthy.
wait:
	@echo "ждём Synced/Healthy (до $(WAIT_TIMEOUT)s)"
	@end=$$(( $$(date +%s) + $(WAIT_TIMEOUT) )); \
	while :; do \
	  states=$$($(KUBECTL) -n argocd get applications \
	    -o jsonpath='{range .items[*]}{.metadata.name}={.status.sync.status}/{.status.health.status}{"\n"}{end}'); \
	  total=$$(printf '%s\n' "$$states" | grep -c '=' || true); \
	  ready=$$(printf '%s\n' "$$states" | grep -c '=Synced/Healthy$$' || true); \
	  if [ "$$total" -ge 5 ] && [ "$$ready" -eq "$$total" ]; then echo "все $$total Application готовы"; break; fi; \
	  if [ $$(date +%s) -ge $$end ]; then echo "timeout:"; printf '%s\n' "$$states"; exit 1; fi; \
	  sleep 5; \
	done

status:
	@$(KUBECTL) -n argocd get applications
	@$(KUBECTL) get pods -n agent
	@echo "API:        http://localhost:3000"
	@echo "Argo CD UI: http://localhost:8080 (admin, пароль: make argocd-password)"
	@echo "Prometheus: http://localhost:9090"

argocd-password:
	@$(KUBECTL) -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \
	  | base64 -d; echo
