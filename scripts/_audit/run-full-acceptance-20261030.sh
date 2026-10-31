#!/bin/bash
# run-full-acceptance-20261030.sh —— aw-system-acceptance 五层全量验收执行器。
# 顺序 T0→T4,逐套件落日志+results.tsv;失败继续(先全景后定位,不中断归档)。
# 用法:bash scripts/_audit/run-full-acceptance-20261030.sh(前置:验收实例 3105 已起且注册开放)
set -u
R=docs/audit/evidence/2026-10-30-full-acceptance
mkdir -p "$R"
export NO_PROXY='127.0.0.1,localhost'
export HTTP_PROXY= HTTPS_PROXY=
export AW_BASE=http://127.0.0.1:3105
export AW_EMAIL=admin@awshop.local AW_PASS=admin123
TSX="npx tsx --tsconfig .nuxt/tsconfig.server.json"
: > "$R/results.tsv"

run(){
  local name="$1" tmo="$2"; shift 2
  echo -e "$(date +%H:%M:%S)\t$name\tSTART" >> "$R/results.tsv"
  if timeout "$tmo" "$@" > "$R/$name.log" 2>&1; then
    echo -e "$name\tPASS" >> "$R/results.tsv"
    echo "[$(date +%H:%M:%S)] PASS  $name"
  else
    local code=$?
    echo -e "$name\tFAIL($code)" >> "$R/results.tsv"
    echo "[$(date +%H:%M:%S)] FAIL($code) $name"
  fi
}

echo "== T0 静态门禁 =="
run t0-lint        600 npm run lint
run t0-typecheck   900 npm run typecheck
run t0-docs-check  600 npm run docs:check
run t0-i18n-check  600 npm run i18n:check
run t0-readme-lint 600 npm run readme:lint

echo "== T1 单元与契约 =="
run t1-unit             900 npm run test:unit
run t1-mcp              900 npm run test:mcp
run t1-plugin-lifecycle 900 npm run test:plugin-lifecycle
run t1-sdk-surface      900 npm run test:sdk-surface
run t1-twin-provider    900 npm run test:twin-provider
run t1-skills           600 npm run test:skills

echo "== T2 实机核心闭环 =="
run t2-line          1800 npm run test:e2e-line
run t2-ontology      1200 $TSX scripts/e2e-ontology.mjs
run t2-ontology-live 2400 $TSX scripts/e2e-ontology-live.mjs
run t2-model-loop    2400 $TSX scripts/e2e-model-loop-live.mjs
run t2-optimizer     3600 $TSX scripts/e2e-optimizer-live.mjs
run t2-injection     1800 npm run test:e2e-injection
run t2-idd-results    900 node scripts/e2e-idd-results.mjs
run t2-idd-results-ui 900 node scripts/e2e-idd-results-ui.mjs

echo "== T3 回归面(全量十套) =="
run t3-api-live          1800 npm run test:api-live
run t3-mcp-live           900 node scripts/_audit/aw-mcp-live-e2e.mjs
run t3-agent-team         900 node scripts/e2e-agent-team.mjs --base=http://127.0.0.1:3105
run t3-hitl-live         1500 node scripts/e2e-hitl-live.mjs --base http://127.0.0.1:3105
run t3-tool-surface      1800 node scripts/e2e-tool-surface-multiagent.mjs
run t3-template-isolation 1200 env BASE_URL=http://127.0.0.1:3105 E2E_USER=admin@awshop.local E2E_PASS=admin123 node scripts/e2e-template-isolation.mjs
run t3-auth-matrix       1200 env BASE_URL=http://127.0.0.1:3105 node scripts/e2e-auth-matrix.mjs
run t3-timezone           900 node scripts/e2e-timezone-settings.mjs http://127.0.0.1:3105
run t3-rest-robustness    900 env AW_E2E_BASE=http://127.0.0.1:3105 node scripts/e2e-rest-robustness.mjs
run t3-crash-cycle       1800 node scripts/e2e-crash-cycle.mjs --port 3300

echo "== T4 插件与工具注册面 =="
TOK=$(curl -s --noproxy 127.0.0.1 -X POST "$AW_BASE/api/users/login" -H 'content-type: application/json' \
  -d '{"email":"admin@awshop.local","password":"admin123"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data?.token??''))")
{
  echo "--- plugins(全部 enabled 且 failures=[]) ---"
  curl -s --noproxy 127.0.0.1 "$AW_BASE/api/workshop/plugins" -H "authorization: Bearer $TOK" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const ps=j.data?.plugins??[];const bad=ps.filter(p=>!p.enabled||(p.failures??[]).length>0);console.log('plugins',ps.length,'bad',bad.length,bad.map(p=>p.name).join(','))})"
  echo "--- tools(builtin+plugin 全 available) ---"
  curl -s --noproxy 127.0.0.1 "$AW_BASE/api/workshop/tools" -H "authorization: Bearer $TOK" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const ts=j.data?.tools??[];const un=ts.filter(t=>t.available===false);console.log('tools',ts.length,'unavailable',un.length,un.slice(0,5).map(t=>t.name).join(','))})"
} > "$R/t4-registry.log" 2>&1
grep -q "bad 0" "$R/t4-registry.log" && grep -q "unavailable 0" "$R/t4-registry.log" \
  && echo -e "t4-registry\tPASS" >> "$R/results.tsv" \
  || echo -e "t4-registry\tFAIL" >> "$R/results.tsv"
cat "$R/t4-registry.log"

echo "ALL DONE $(date +%H:%M:%S)"
