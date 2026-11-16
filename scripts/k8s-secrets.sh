#!/usr/bin/env bash
# Секреты стенда в kind, в git их нет. Ключ DeepSeek берётся из окружения и обновляется при
# каждом запуске, остальное генерируется один раз: существующий секрет не перезаписывается,
# иначе Langfuse потеряет доступ к своим данным, а LiteLLM — к ключу агента.
# Значения передаются файлами во временном каталоге, а не аргументами: не видны в ps.
set -euo pipefail

KUBECTL=${KUBECTL:-kubectl}
: "${DEEPSEEK_API_KEY:?задайте DEEPSEEK_API_KEY в окружении}"

tmp=$(mktemp -d)
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

rand() { openssl rand -hex "$1"; }

namespace() {
  $KUBECTL create namespace "$1" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
}

exists() { $KUBECTL -n "$1" get secret "$2" >/dev/null 2>&1; }

# get <ns> <secret> <key>: значение ключа из существующего секрета.
get() {
  $KUBECTL -n "$1" get secret "$2" -o "go-template={{index .data \"$3\" | base64decode}}"
}

# apply <ns> <secret> <key>=<value>...: создаёт или обновляет секрет.
apply() {
  local ns=$1 name=$2 dir="$tmp/$1-$2" pair
  shift 2
  mkdir "$dir"
  for pair in "$@"; do printf '%s' "${pair#*=}" > "$dir/${pair%%=*}"; done
  $KUBECTL -n "$ns" create secret generic "$name" --from-file="$dir" --dry-run=client -o yaml \
    | $KUBECTL apply -f - >/dev/null
  echo "secret $ns/$name"
}

# once <ns> <secret> <key>=<value>...: создаёт секрет, только если его ещё нет.
once() {
  if exists "$1" "$2"; then echo "secret $1/$2 уже есть"; else apply "$@"; fi
}

for ns in agent llm langfuse; do namespace "$ns"; done

apply llm deepseek "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY"

# Langfuse: ключи приложения, headless init (org, project, API-ключи, пользователь UI)
# и пароли его хранилищ.
once langfuse langfuse-keys \
  "salt=$(rand 32)" "encryption-key=$(rand 32)" "nextauth-secret=$(rand 32)"
once langfuse langfuse-init \
  LANGFUSE_INIT_ORG_ID=agent-deploy-lab \
  LANGFUSE_INIT_ORG_NAME=agent-deploy-lab \
  LANGFUSE_INIT_PROJECT_ID=agent \
  LANGFUSE_INIT_PROJECT_NAME=agent \
  "LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-$(rand 16)" \
  "LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-$(rand 16)" \
  LANGFUSE_INIT_USER_EMAIL=admin@agent-deploy-lab.local \
  LANGFUSE_INIT_USER_NAME=admin \
  "LANGFUSE_INIT_USER_PASSWORD=$(rand 12)"
pg=$(rand 20)
once langfuse langfuse-postgresql-auth \
  POSTGRES_USER=postgres "POSTGRES_PASSWORD=$pg" POSTGRES_DB=langfuse \
  USERDB_USER=langfuse "USERDB_PASSWORD=$pg"
once langfuse langfuse-redis-auth "default=$(rand 20)"
s3=$(rand 20)
s3_config='{"identities":[{"name":"langfuse","credentials":[{"accessKey":"langfuse","secretKey":"'$s3'"}],"actions":["Admin","Read","Write","List","Tagging"]}]}'
once langfuse langfuse-s3-auth accessKey=langfuse "secretKey=$s3" "seaweedfs_s3_config=$s3_config"
once langfuse langfuse-clickhouse-auth "password=$(rand 20)"

# LiteLLM: master key, пароль его Postgres и virtual key агента (регистрирует Job в кластере).
once llm litellm \
  "LITELLM_MASTER_KEY=sk-master-$(rand 16)" \
  "POSTGRES_PASSWORD=$(rand 20)" \
  "AGENT_KEY=sk-agent-$(rand 16)"

# Копии из источников выше: API-ключи Langfuse для LiteLLM (трейсы) и агента (score),
# virtual key для агента.
pk=$(get langfuse langfuse-init LANGFUSE_INIT_PROJECT_PUBLIC_KEY)
sk=$(get langfuse langfuse-init LANGFUSE_INIT_PROJECT_SECRET_KEY)
for ns in llm agent; do
  apply "$ns" langfuse-api "LANGFUSE_PUBLIC_KEY=$pk" "LANGFUSE_SECRET_KEY=$sk"
done
apply agent agent-llm "LLM_API_KEY=$(get llm litellm AGENT_KEY)"
