#!/bin/bash
# 自包含探针(同主两团队):东线(含共享记忆)+ 西线 → 西线 lead 的 list_other_teams
set -e
B=http://127.0.0.1:3000/api/workshop
STAMP=$(date +%s)
TA=$(curl -s --noproxy 127.0.0.1 -X POST $B/users/register -H "content-type: application/json" -d "{\"name\":\"ovw2-a-$STAMP\"}" | python -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
AA="authorization: Bearer $TA"

# 东线团队(含共享记忆)
CHA=$(curl -s --noproxy 127.0.0.1 -X POST $B/channels -H "$AA" -H "content-type: application/json" -d "{\"name\":\"东线团队-$STAMP\"}" | python -c "import json,sys;print(json.load(sys.stdin)['data']['channelId'])")
TEA=$(curl -s --noproxy 127.0.0.1 -X POST $B/teams -H "$AA" -H "content-type: application/json" -d "{\"name\":\"东线组-$STAMP\"}" | python -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
curl -s --noproxy 127.0.0.1 -X POST "$B/teams/$TEA/members" -H "$AA" -H "content-type: application/json" -d '{"agentId":"tpl-default-lead","role":"lead"}' > /dev/null
curl -s --noproxy 127.0.0.1 -X POST "$B/teams/$TEA/deploy" -H "$AA" -H "content-type: application/json" -d "{\"channelId\":\"$CHA\"}" > /dev/null
curl -s --noproxy 127.0.0.1 -X POST "$B/channels/$CHA/memories" -H "$AA" -H "content-type: application/json" -d '{"title":"东线工艺结论","content":"淬火 182℃ 保温 30 分钟硬度达标 HRC58","importance":0.9}' > /dev/null

# 西线团队(观察视角)
CHB=$(curl -s --noproxy 127.0.0.1 -X POST $B/channels -H "$AA" -H "content-type: application/json" -d "{\"name\":\"西线团队-$STAMP\"}" | python -c "import json,sys;print(json.load(sys.stdin)['data']['channelId'])")
TEB=$(curl -s --noproxy 127.0.0.1 -X POST $B/teams -H "$AA" -H "content-type: application/json" -d "{\"name\":\"西线组-$STAMP\"}" | python -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
curl -s --noproxy 127.0.0.1 -X POST "$B/teams/$TEB/members" -H "$AA" -H "content-type: application/json" -d '{"agentId":"tpl-default-lead","role":"lead"}' > /dev/null
curl -s --noproxy 127.0.0.1 -X POST "$B/teams/$TEB/deploy" -H "$AA" -H "content-type: application/json" -d "{\"channelId\":\"$CHB\"}" > /dev/null
LEADB=$(curl -s --noproxy 127.0.0.1 "$B/channels/$CHB/agents" -H "$AA" | python -c "import json,sys;print([a['id'] for a in json.load(sys.stdin)['data'] if a['role']=='lead'][0])")

echo "--- 西线 lead 视角 list_other_teams ---"
curl -s --noproxy 127.0.0.1 -X POST $B/agent-tools/invoke -H "$AA" -H "content-type: application/json" \
  -d "{\"agentId\":\"$LEADB\",\"tool\":\"list_other_teams\",\"args\":{}}" \
  | python -c "import json,sys;print(json.load(sys.stdin)['data']['result']['text'])"
echo "--- 东线 lead 视角 search_other_teams_memory(本例只有东线,预期空)---"
LEADA=$(curl -s --noproxy 127.0.0.1 "$B/channels/$CHA/agents" -H "$AA" | python -c "import json,sys;print([a['id'] for a in json.load(sys.stdin)['data'] if a['role']=='lead'][0])")
curl -s --noproxy 127.0.0.1 -X POST $B/agent-tools/invoke -H "$AA" -H "content-type: application/json" \
  -d "{\"agentId\":\"$LEADA\",\"tool\":\"search_other_teams_memory\",\"args\":{\"query\":\"淬火\"}}" \
  | python -c "import json,sys;print(json.load(sys.stdin)['data']['result']['text'])"
