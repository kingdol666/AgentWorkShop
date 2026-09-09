#!/usr/bin/env bash
# crush 探针:用 impl 生成的同款 .crushrc 实测智谱 openai-compat 网关(凭据走 env)
set -u
KEY="${ZHIPU_API_KEY:?export ZHIPU_API_KEY first}"
export AW_CRUSH_API_KEY="$KEY"
T="$(mktemp -d)"
BRIDGE="D:/codes/ABO/AgentWorkShop/server/harness/aw-mcp-bridge.mjs"
NODE="$(command -v node)"
cat > "$T/.crushrc" <<EOF
mcp add aw --command "$NODE" --args "$BRIDGE" --timeout 30
provider add zhipu --type openai-compat --base-url https://open.bigmodel.cn/api/coding/paas/v4 --api-key "\${AW_CRUSH_API_KEY}"
model add zhipu/glm-5.3-flash
model large zhipu/glm-5.3-flash
EOF
cd "$T"
echo "== generated .crushrc =="
cat .crushrc
echo "== crush run -q =="
timeout 90 crush run -q "reply with exactly: ok" 2>&1 | head -c 1500
echo; echo "== exit=$? =="
cd /; rm -rf "$T"
