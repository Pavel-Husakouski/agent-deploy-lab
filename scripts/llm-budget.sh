#!/usr/bin/env bash
# Меняет бюджет virtual key агента в LiteLLM: make llm-budget BUDGET=0 — проверить отказ
# по бюджету, BUDGET=1 — вернуть. Ключ идёт через stdin, master key уже есть в поде LiteLLM.
set -euo pipefail

KUBECTL=${KUBECTL:-kubectl}
budget=${1:?usage: llm-budget.sh <usd>}

$KUBECTL -n llm get secret litellm -o 'go-template={{.data.AGENT_KEY | base64decode}}' \
  | $KUBECTL -n llm exec -i deploy/litellm -- python -c '
import json, os, sys, urllib.request
body = {"key": sys.stdin.read().strip(), "max_budget": float(sys.argv[1])}
req = urllib.request.Request(
    "http://localhost:4000/key/update",
    data=json.dumps(body).encode(),
    headers={
        "authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"],
        "content-type": "application/json",
    },
)
info = json.load(urllib.request.urlopen(req))
print("max_budget:", info.get("max_budget"), "spend:", info.get("spend"))
' "$budget"
