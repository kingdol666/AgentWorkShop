#!/usr/bin/env bash
# goose 探针:stream-json 帧形 + 智谱 openai 兼容网关(凭据走 env)
set -u
KEY="${ZHIPU_API_KEY:?export ZHIPU_API_KEY first}"
export GOOSE_MODE=auto GOOSE_CONTEXT_STRATEGY=summarize GOOSE_DISABLE_SESSION_NAMING=true
export GOOSE_PROVIDER=openai GOOSE_MODEL=glm-5.3-flash
export OPENAI_API_KEY="$KEY" OPENAI_HOST=open.bigmodel.cn OPENAI_BASE_PATH=/api/coding/paas/v4/v1/chat/completions
echo "== goose run stream-json =="
timeout 120 goose run --output-format stream-json -t "reply with exactly: ok" 2>&1 | head -c 3000
echo; echo "== exit=$? =="
