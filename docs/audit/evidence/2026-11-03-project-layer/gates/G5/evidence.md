# G5 — 构建 + UI smoke(6) + 交互矩阵(20)

> 生成时间：2026-11-04T09:41:34.011Z
# G5 — 构建 + UI smoke(6) + 交互矩阵(20)

> 生成时间：2026-11-04T08:28:01.322Z
# G5 — 构建 + UI smoke(6) + 交互矩阵(20)

> 生成时间：2026-11-04T08:20:42.038Z
# G5 — 构建 + UI smoke(6) + 交互矩阵(20)

> 生成时间：2026-11-04T07:14:11.477Z
# G5 — 构建 + UI smoke(6) + 交互矩阵(20)

> 生成时间：2026-11-04T07:04:42.028Z
# G5 — 构建 + UI smoke(6) + 交互矩阵(20)

> 生成时间：2026-11-04T06:58:30.306Z

## `npm run build` — FAIL (0s, exit=1)

```
node:internal/modules/cjs/loader:1520
  throw err;
  ^

Error: Cannot find module 'D:\codes\ABO\AgentWorkShop-project\node_modules\npm\bin\npx-cli.js'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1517:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1071:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1095:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1122:12)
    at Module._load (node:internal/modules/cjs/loader:1294:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v24.19.0
```

## `node scripts/ui/projects-smoke.mjs` — PASS (22s, exit=0)

```
✔ [U0] 构建产物服务启动
✔ [U1] admin 注册
✔ [U2] 真实 API 数据准备
✔ [U3] 列表页渲染项目
✔ [U4] 详情页渲染概览/频道/交付物/工作项/成果/审批/审计
✔ [U5] 页面无未捕获异常

=== UI SMOKE pass=6 fail=0 ===
{
  "pass": 6,
  "fail": 0,
  "results": [
    {
      "id": "U0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3985"
    },
    {
      "id": "U1",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "U2",
      "name": "真实 API 数据准备",
      "pass": true,
      "detail": ""
    },
    {
      "id": "U3",
      "name": "列表页渲染项目",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n简体中文\nU\nui-admin\nADMIN\n项目\n\n项目总工 +"
    },
    {
      "id": "U4",
      "name": "详情页渲染概览/频道/交付物/工作项/成果/审批/审计",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\nF40aa6f8-9302-4942-8aa2-f2cf771ae7e0\n简体中文\nU\nui-admin\nADMIN\n← 项目列表\nUI项目-j103\n\n验证项目页渲染与数据绑定\n\nplan v0 · 待审批 0 项 · leader c493a09e-3150-"
    },
    {
      "id": "U5",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `node scripts/ui/projects-interactions.mjs` — PASS (29s, exit=0)

```
✔ [I0] 构建产物服务启动
✔ [I0b] admin 注册
✔ [I0c] seed 频道（供 UI 绑定）
✔ [I1] 列表页渲染（含新建项目表单）
✔ [I2] UI 建项目 → 列表出现
✔ [I3] 打开详情页
✔ [I4] UI 绑定频道 → 列表出现
✔ [I5] UI 建交付物
✔ [I6] UI 建工作项 → 行出现
✔ [I7] UI 激活 → active 徽标
✔ [I8] UI 派发 → DISPATCHED
✔ [I9] 完成后对账 → COMPLETED + 成果 draft
✔ [I10a] 成果提交 → submitted
✔ [I10b] 复核 → reviewed
✔ [I10c] 申请验收 → 待审批出现
✔ [I11] 批准 → 成果 approved / 交付物 approved
✔ [I12a] leader 派发提案（API）
✔ [I12] 页面点击应用提案 → 工作项出现
✔ [I13] 周报卡片渲染（进度/交付物/成果数字）
✔ [I14] 页面无未捕获异常

=== UI INTERACTIONS pass=20 fail=0 ===
{
  "pass": 20,
  "fail": 0,
  "results": [
    {
      "id": "I0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3982"
    },
    {
      "id": "I0b",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I0c",
      "name": "seed 频道（供 UI 绑定）",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I1",
      "name": "列表页渲染（含新建项目表单）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9"
    },
    {
      "id": "I2",
      "name": "UI 建项目 → 列表出现",
      "pass": true,
      "detail": "交互项目-joi9"
    },
    {
      "id": "I3",
      "name": "打开详情页",
      "pass": true,
      "detail": "http://127.0.0.1:3982/projects/94944382-856b-42da-b98b-2ce9af520cec"
    },
    {
      "id": "I4",
      "name": "UI 绑定频道 → 列表出现",
      "pass": true,
      "detail": "7859f168-4bf6-442c-ad6d-d39eb9116bb4"
    },
    {
      "id": "I5",
      "name": "UI 建交付物",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I6",
      "name": "UI 建工作项 → 行出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I7",
      "name": "UI 激活 → active 徽标",
      "pass": true,
      "detail": "badge active"
    },
    {
      "id": "I8",
      "name": "UI 派发 → DISPATCHED",
      "pass": true,
      "detail": "row state"
    },
    {
      "id": "I9",
      "name": "完成后对账 → COMPLETED + 成果 draft",
      "pass": true,
      "detail": "work item + result"
    },
    {
      "id": "I10a",
      "name": "成果提交 → submitted",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10b",
      "name": "复核 → reviewed",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10c",
      "name": "申请验收 → 待审批出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I11",
      "name": "批准 → 成果 approved / 交付物 approved",
      "pass": true,
      "detail": "result/deliverable approved"
    },
    {
      "id": "I12a",
      "name": "leader 派发提案（API）",
      "pass": true,
      "detail": "{\n  \"ok\": true,\n  \"proposalId\": \"8ff48fcd-b008-4575-8b7e-865156c413c2\",\n  \"status\": \"proposed\",\n  \"next\": \"owner 在项目页应用提案后生成工作项（dispatch=true 时一并派发）\"\n}"
    },
    {
      "id": "I12",
      "name": "页面点击应用提案 → 工作项出现",
      "pass": true,
      "detail": "dispatch.proposed applied"
    },
    {
      "id": "I13",
      "name": "周报卡片渲染（进度/交付物/成果数字）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n94944382-856b-42da-b98b-2ce9af52"
    },
    {
      "id": "I14",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `npm run build` — PASS (85s, exit=0)

```
[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs (1.86 kB)[39m[90m (851 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs.map (1.37 kB)[39m[90m (538 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs (1.25 kB)[39m[90m (539 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs.map (707 B)[39m[90m (268 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs (1.17 kB)[39m[90m (549 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs.map (651 B)[39m[90m (317 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs (814 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs.map (282 B)[39m[90m (190 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs (1.21 kB)[39m[90m (483 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs.map (771 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs (1.84 kB)[39m[90m (955 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs.map (1.27 kB)[39m[90m (513 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs (1.62 kB)[39m[90m (647 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs.map (998 B)[39m[90m (430 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs (1.08 kB)[39m[90m (428 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs.map (550 B)[39m[90m (295 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs (1.07 kB)[39m[90m (424 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs.map (546 B)[39m[90m (292 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs (964 B)[39m[90m (402 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs.map (451 B)[39m[90m (260 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs (15.1 kB)[39m[90m (5.42 kB gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs.map (1.82 kB)[39m[90m (386 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs (94 B)[39m[90m (100 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs.map (90 B)[39m[90m (98 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs (952 kB)[39m[90m (264 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs.map (8.18 kB)[39m[90m (1.5 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs (213 kB)[39m[90m (22.4 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs.map (198 B)[39m[90m (162 B gzip)[39m
[90m  ├─ .output/server/index.mjs (864 B)[39m[90m (335 B gzip)[39m
[90m  └─ .output/server/package.json (3.07 kB)[39m[90m (1.11 kB gzip)[39m
[36mΣ Total size:[39m 22.8 MB (5.68 MB gzip)
[build] prompts copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\prompts
[build] optimizer python copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\optimizer-python
[build] schema.json copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\schema.json
[build] aml python assets copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\aml-python
[90m[[90mnitro[90m][39m [32m✔[39m You can preview this build using [36mnode .output/server/index.mjs[39m
│
└  ✨ Build complete!
› 外置资产随产物分发:prompts, schema.json, aml-python
```

## `node scripts/ui/projects-smoke.mjs` — PASS (17s, exit=0)

```
✔ [U0] 构建产物服务启动
✔ [U1] admin 注册
✔ [U2] 真实 API 数据准备
✔ [U3] 列表页渲染项目
✔ [U4] 详情页渲染概览/频道/交付物/工作项/成果/审批/审计
✔ [U5] 页面无未捕获异常

=== UI SMOKE pass=6 fail=0 ===
{
  "pass": 6,
  "fail": 0,
  "results": [
    {
      "id": "U0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3985"
    },
    {
      "id": "U1",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "U2",
      "name": "真实 API 数据准备",
      "pass": true,
      "detail": ""
    },
    {
      "id": "U3",
      "name": "列表页渲染项目",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n简体中文\nU\nui-admin\nADMIN\n项目\n\n项目总工 +"
    },
    {
      "id": "U4",
      "name": "详情页渲染概览/频道/交付物/工作项/成果/审批/审计",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\nDa570ae5-9fb4-4f6d-aff4-6edd36f026d1\n简体中文\nU\nui-admin\nADMIN\n← 项目列表\nUI项目-ri3t\n\n验证项目页渲染与数据绑定\n\nplan v0 · 待审批 0 项 · leader ca6ac99e-3cbf-"
    },
    {
      "id": "U5",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `node scripts/ui/projects-interactions.mjs` — PASS (20s, exit=0)

```
✔ [I0] 构建产物服务启动
✔ [I0b] admin 注册
✔ [I0c] seed 频道（供 UI 绑定）
✔ [I1] 列表页渲染（含新建项目表单）
✔ [I2] UI 建项目 → 列表出现
✔ [I3] 打开详情页
✔ [I4] UI 绑定频道 → 列表出现
✔ [I5] UI 建交付物
✔ [I6] UI 建工作项 → 行出现
✔ [I7] UI 激活 → active 徽标
✔ [I8] UI 派发 → DISPATCHED
✔ [I9] 完成后对账 → COMPLETED + 成果 draft
✔ [I10a] 成果提交 → submitted
✔ [I10b] 复核 → reviewed
✔ [I10c] 申请验收 → 待审批出现
✔ [I11] 批准 → 成果 approved / 交付物 approved
✔ [I12a] leader 派发提案（API）
✔ [I12] 页面点击应用提案 → 工作项出现
✔ [I13] 周报卡片渲染（进度/交付物/成果数字）
✔ [I14] 页面无未捕获异常

=== UI INTERACTIONS pass=20 fail=0 ===
{
  "pass": 20,
  "fail": 0,
  "results": [
    {
      "id": "I0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3982"
    },
    {
      "id": "I0b",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I0c",
      "name": "seed 频道（供 UI 绑定）",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I1",
      "name": "列表页渲染（含新建项目表单）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9"
    },
    {
      "id": "I2",
      "name": "UI 建项目 → 列表出现",
      "pass": true,
      "detail": "交互项目-rwy3"
    },
    {
      "id": "I3",
      "name": "打开详情页",
      "pass": true,
      "detail": "http://127.0.0.1:3982/projects/95fe3b22-e401-4fd0-a6a5-30c836bebaed"
    },
    {
      "id": "I4",
      "name": "UI 绑定频道 → 列表出现",
      "pass": true,
      "detail": "5d6c9e58-ed3e-4baa-a205-ca0ce740fdfa"
    },
    {
      "id": "I5",
      "name": "UI 建交付物",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I6",
      "name": "UI 建工作项 → 行出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I7",
      "name": "UI 激活 → active 徽标",
      "pass": true,
      "detail": "badge active"
    },
    {
      "id": "I8",
      "name": "UI 派发 → DISPATCHED",
      "pass": true,
      "detail": "row state"
    },
    {
      "id": "I9",
      "name": "完成后对账 → COMPLETED + 成果 draft",
      "pass": true,
      "detail": "work item + result"
    },
    {
      "id": "I10a",
      "name": "成果提交 → submitted",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10b",
      "name": "复核 → reviewed",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10c",
      "name": "申请验收 → 待审批出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I11",
      "name": "批准 → 成果 approved / 交付物 approved",
      "pass": true,
      "detail": "result/deliverable approved"
    },
    {
      "id": "I12a",
      "name": "leader 派发提案（API）",
      "pass": true,
      "detail": "{\n  \"ok\": true,\n  \"proposalId\": \"04b486f9-2380-4653-a55e-6e0f1862ef8f\",\n  \"status\": \"proposed\",\n  \"next\": \"owner 在项目页应用提案后生成工作项（dispatch=true 时一并派发）\"\n}"
    },
    {
      "id": "I12",
      "name": "页面点击应用提案 → 工作项出现",
      "pass": true,
      "detail": "dispatch.proposed applied"
    },
    {
      "id": "I13",
      "name": "周报卡片渲染（进度/交付物/成果数字）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n95fe3b22-e401-4fd0-a6a5-30c836be"
    },
    {
      "id": "I14",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `npm run build` — PASS (85s, exit=0)

```
[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs (1.86 kB)[39m[90m (851 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs.map (1.37 kB)[39m[90m (538 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs (1.25 kB)[39m[90m (539 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs.map (707 B)[39m[90m (268 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs (1.17 kB)[39m[90m (549 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs.map (651 B)[39m[90m (317 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs (814 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs.map (282 B)[39m[90m (190 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs (1.21 kB)[39m[90m (483 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs.map (771 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs (1.84 kB)[39m[90m (955 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs.map (1.27 kB)[39m[90m (513 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs (1.62 kB)[39m[90m (647 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs.map (998 B)[39m[90m (430 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs (1.08 kB)[39m[90m (428 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs.map (550 B)[39m[90m (295 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs (1.07 kB)[39m[90m (424 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs.map (546 B)[39m[90m (292 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs (964 B)[39m[90m (402 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs.map (451 B)[39m[90m (260 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs (15.1 kB)[39m[90m (5.42 kB gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs.map (1.82 kB)[39m[90m (386 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs (94 B)[39m[90m (100 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs.map (90 B)[39m[90m (98 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs (952 kB)[39m[90m (264 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs.map (8.18 kB)[39m[90m (1.5 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs (213 kB)[39m[90m (22.4 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs.map (198 B)[39m[90m (162 B gzip)[39m
[90m  ├─ .output/server/index.mjs (864 B)[39m[90m (335 B gzip)[39m
[90m  └─ .output/server/package.json (3.07 kB)[39m[90m (1.11 kB gzip)[39m
[36mΣ Total size:[39m 22.8 MB (5.68 MB gzip)
[build] prompts copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\prompts
[build] optimizer python copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\optimizer-python
[build] schema.json copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\schema.json
[build] aml python assets copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\aml-python
[90m[[90mnitro[90m][39m [32m✔[39m You can preview this build using [36mnode .output/server/index.mjs[39m
│
└  ✨ Build complete!
› 外置资产随产物分发:prompts, schema.json, aml-python
```

## `node scripts/ui/projects-smoke.mjs` — PASS (25s, exit=0)

```
✔ [U0] 构建产物服务启动
✔ [U1] admin 注册
✔ [U2] 真实 API 数据准备
✔ [U3] 列表页渲染项目
✔ [U4] 详情页渲染概览/频道/交付物/工作项/成果/审批/审计
✔ [U5] 页面无未捕获异常

=== UI SMOKE pass=6 fail=0 ===
{
  "pass": 6,
  "fail": 0,
  "results": [
    {
      "id": "U0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3985"
    },
    {
      "id": "U1",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "U2",
      "name": "真实 API 数据准备",
      "pass": true,
      "detail": ""
    },
    {
      "id": "U3",
      "name": "列表页渲染项目",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n简体中文\nU\nui-admin\nADMIN\n项目\n\n项目总工 +"
    },
    {
      "id": "U4",
      "name": "详情页渲染概览/频道/交付物/工作项/成果/审批/审计",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n8af5c8e8-5327-48aa-9438-c0bde99a276e\n简体中文\nU\nui-admin\nADMIN\n← 项目列表\nUI项目-3p58\n\n验证项目页渲染与数据绑定\n\nplan v0 · 待审批 0 项 · leader 88107e32-7974-"
    },
    {
      "id": "U5",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `node scripts/ui/projects-interactions.mjs` — PASS (20s, exit=0)

```
✔ [I0] 构建产物服务启动
✔ [I0b] admin 注册
✔ [I0c] seed 频道（供 UI 绑定）
✔ [I1] 列表页渲染（含新建项目表单）
✔ [I2] UI 建项目 → 列表出现
✔ [I3] 打开详情页
✔ [I4] UI 绑定频道 → 列表出现
✔ [I5] UI 建交付物
✔ [I6] UI 建工作项 → 行出现
✔ [I7] UI 激活 → active 徽标
✔ [I8] UI 派发 → DISPATCHED
✔ [I9] 完成后对账 → COMPLETED + 成果 draft
✔ [I10a] 成果提交 → submitted
✔ [I10b] 复核 → reviewed
✔ [I10c] 申请验收 → 待审批出现
✔ [I11] 批准 → 成果 approved / 交付物 approved
✔ [I12a] leader 派发提案（API）
✔ [I12] 页面点击应用提案 → 工作项出现
✔ [I13] 周报卡片渲染（进度/交付物/成果数字）
✔ [I14] 页面无未捕获异常

=== UI INTERACTIONS pass=20 fail=0 ===
{
  "pass": 20,
  "fail": 0,
  "results": [
    {
      "id": "I0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3982"
    },
    {
      "id": "I0b",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I0c",
      "name": "seed 频道（供 UI 绑定）",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I1",
      "name": "列表页渲染（含新建项目表单）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9"
    },
    {
      "id": "I2",
      "name": "UI 建项目 → 列表出现",
      "pass": true,
      "detail": "交互项目-43y2"
    },
    {
      "id": "I3",
      "name": "打开详情页",
      "pass": true,
      "detail": "http://127.0.0.1:3982/projects/58c092fd-da4c-424e-a488-666d151edbd7"
    },
    {
      "id": "I4",
      "name": "UI 绑定频道 → 列表出现",
      "pass": true,
      "detail": "f5d1f5d4-6046-4a8b-bd4c-0191b5f0b564"
    },
    {
      "id": "I5",
      "name": "UI 建交付物",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I6",
      "name": "UI 建工作项 → 行出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I7",
      "name": "UI 激活 → active 徽标",
      "pass": true,
      "detail": "badge active"
    },
    {
      "id": "I8",
      "name": "UI 派发 → DISPATCHED",
      "pass": true,
      "detail": "row state"
    },
    {
      "id": "I9",
      "name": "完成后对账 → COMPLETED + 成果 draft",
      "pass": true,
      "detail": "work item + result"
    },
    {
      "id": "I10a",
      "name": "成果提交 → submitted",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10b",
      "name": "复核 → reviewed",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10c",
      "name": "申请验收 → 待审批出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I11",
      "name": "批准 → 成果 approved / 交付物 approved",
      "pass": true,
      "detail": "result/deliverable approved"
    },
    {
      "id": "I12a",
      "name": "leader 派发提案（API）",
      "pass": true,
      "detail": "{\n  \"ok\": true,\n  \"proposalId\": \"b16227be-c033-4f02-a6c4-0787609a9792\",\n  \"status\": \"proposed\",\n  \"next\": \"owner 在项目页应用提案后生成工作项（dispatch=true 时一并派发）\"\n}"
    },
    {
      "id": "I12",
      "name": "页面点击应用提案 → 工作项出现",
      "pass": true,
      "detail": "dispatch.proposed applied"
    },
    {
      "id": "I13",
      "name": "周报卡片渲染（进度/交付物/成果数字）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n58c092fd-da4c-424e-a488-666d151e"
    },
    {
      "id": "I14",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `npm run build` — PASS (115s, exit=0)

```
[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs (1.86 kB)[39m[90m (851 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs.map (1.37 kB)[39m[90m (538 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs (1.25 kB)[39m[90m (539 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs.map (707 B)[39m[90m (268 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs (1.17 kB)[39m[90m (549 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs.map (651 B)[39m[90m (317 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs (814 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs.map (282 B)[39m[90m (190 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs (1.21 kB)[39m[90m (483 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs.map (771 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs (1.84 kB)[39m[90m (955 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs.map (1.27 kB)[39m[90m (513 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs (1.62 kB)[39m[90m (647 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs.map (998 B)[39m[90m (430 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs (1.08 kB)[39m[90m (428 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs.map (550 B)[39m[90m (295 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs (1.07 kB)[39m[90m (424 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs.map (546 B)[39m[90m (292 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs (964 B)[39m[90m (402 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs.map (451 B)[39m[90m (260 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs (15.1 kB)[39m[90m (5.42 kB gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs.map (1.82 kB)[39m[90m (386 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs (94 B)[39m[90m (100 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs.map (90 B)[39m[90m (98 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs (952 kB)[39m[90m (264 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs.map (8.18 kB)[39m[90m (1.5 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs (213 kB)[39m[90m (22.4 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs.map (198 B)[39m[90m (162 B gzip)[39m
[90m  ├─ .output/server/index.mjs (864 B)[39m[90m (335 B gzip)[39m
[90m  └─ .output/server/package.json (3.07 kB)[39m[90m (1.11 kB gzip)[39m
[36mΣ Total size:[39m 22.8 MB (5.68 MB gzip)
[build] prompts copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\prompts
[build] optimizer python copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\optimizer-python
[build] schema.json copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\schema.json
[build] aml python assets copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\aml-python
[90m[[90mnitro[90m][39m [32m✔[39m You can preview this build using [36mnode .output/server/index.mjs[39m
│
└  ✨ Build complete!
› 外置资产随产物分发:prompts, schema.json, aml-python
```

## `node scripts/ui/projects-smoke.mjs` — PASS (25s, exit=0)

```
✔ [U0] 构建产物服务启动
✔ [U1] admin 注册
✔ [U2] 真实 API 数据准备
✔ [U3] 列表页渲染项目
✔ [U4] 详情页渲染概览/频道/交付物/工作项/成果/审批/审计
✔ [U5] 页面无未捕获异常

=== UI SMOKE pass=6 fail=0 ===
{
  "pass": 6,
  "fail": 0,
  "results": [
    {
      "id": "U0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3985"
    },
    {
      "id": "U1",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "U2",
      "name": "真实 API 数据准备",
      "pass": true,
      "detail": ""
    },
    {
      "id": "U3",
      "name": "列表页渲染项目",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n简体中文\nU\nui-admin\nADMIN\n项目\n\n项目总工 +"
    },
    {
      "id": "U4",
      "name": "详情页渲染概览/频道/交付物/工作项/成果/审批/审计",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\nA9e2df34-da56-4cb1-ba8a-a0577bb9fb8d\n简体中文\nU\nui-admin\nADMIN\n← 项目列表\nUI项目-pzj8\n\n验证项目页渲染与数据绑定\n\nplan v0 · 待审批 0 项 · leader 5fb49e9f-c8d3-"
    },
    {
      "id": "U5",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `node scripts/ui/projects-interactions.mjs` — PASS (29s, exit=0)

```
✔ [I0] 构建产物服务启动
✔ [I0b] admin 注册
✔ [I0c] seed 频道（供 UI 绑定）
✔ [I1] 列表页渲染（含新建项目表单）
✔ [I2] UI 建项目 → 列表出现
✔ [I3] 打开详情页
✔ [I4] UI 绑定频道 → 列表出现
✔ [I5] UI 建交付物
✔ [I6] UI 建工作项 → 行出现
✔ [I7] UI 激活 → active 徽标
✔ [I7b-req] plan approval pending 已创建
✔ [I7b] UI 批准计划 → planVersion=1
✔ [I8] UI 派发 → DISPATCHED（API 确认）
✔ [I9] 完成后对账 → COMPLETED + 成果 draft
✔ [I10a] 成果提交 → submitted
✔ [I10b] 复核 → reviewed
✔ [I10c] 申请验收 → 待审批出现
✔ [I11] 批准 → 成果 approved / 交付物 approved
✔ [I12a] leader 派发提案（API）
✔ [I12] 页面点击应用提案 → 工作项出现
✔ [I13] 周报卡片渲染（进度/交付物/成果数字）
✔ [I14] 页面无未捕获异常

=== UI INTERACTIONS pass=22 fail=0 ===
{
  "pass": 22,
  "fail": 0,
  "results": [
    {
      "id": "I0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3982"
    },
    {
      "id": "I0b",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I0c",
      "name": "seed 频道（供 UI 绑定）",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I1",
      "name": "列表页渲染（含新建项目表单）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9"
    },
    {
      "id": "I2",
      "name": "UI 建项目 → 列表出现",
      "pass": true,
      "detail": "交互项目-qj2l"
    },
    {
      "id": "I3",
      "name": "打开详情页",
      "pass": true,
      "detail": "http://127.0.0.1:3982/projects/013fc9bc-f8de-4a63-bd6a-0c75a220a3c2"
    },
    {
      "id": "I4",
      "name": "UI 绑定频道 → 列表出现",
      "pass": true,
      "detail": "7cb33c82-dcb7-43be-9993-922ee17538e7"
    },
    {
      "id": "I5",
      "name": "UI 建交付物",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I6",
      "name": "UI 建工作项 → 行出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I7",
      "name": "UI 激活 → active 徽标",
      "pass": true,
      "detail": "badge active"
    },
    {
      "id": "I7b-req",
      "name": "plan approval pending 已创建",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I7b",
      "name": "UI 批准计划 → planVersion=1",
      "pass": true,
      "detail": "btn=true version=1"
    },
    {
      "id": "I8",
      "name": "UI 派发 → DISPATCHED（API 确认）",
      "pass": true,
      "detail": "state=DISPATCHED "
    },
    {
      "id": "I9",
      "name": "完成后对账 → COMPLETED + 成果 draft",
      "pass": true,
      "detail": "work item + result"
    },
    {
      "id": "I10a",
      "name": "成果提交 → submitted",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10b",
      "name": "复核 → reviewed",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10c",
      "name": "申请验收 → 待审批出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I11",
      "name": "批准 → 成果 approved / 交付物 approved",
      "pass": true,
      "detail": "result/deliverable approved"
    },
    {
      "id": "I12a",
      "name": "leader 派发提案（API）",
      "pass": true,
      "detail": "{\n  \"ok\": true,\n  \"proposalId\": \"e052954a-4836-45b0-aa56-e856f49c28f5\",\n  \"status\": \"proposed\",\n  \"next\": \"owner 在项目页应用提案后生成工作项（dispatch=true 时一并派发）\"\n}"
    },
    {
      "id": "I12",
      "name": "页面点击应用提案 → 工作项出现",
      "pass": true,
      "detail": "dispatch.proposed applied"
    },
    {
      "id": "I13",
      "name": "周报卡片渲染（进度/交付物/成果数字）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n013fc9bc-f8de-4a63-bd6a-0c75a220"
    },
    {
      "id": "I14",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `npm run build` — PASS (163s, exit=0)

```
[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs (1.86 kB)[39m[90m (851 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/index2.get.mjs.map (1.37 kB)[39m[90m (538 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs (1.25 kB)[39m[90m (539 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/teams/_id/members/_agentId_.delete.mjs.map (707 B)[39m[90m (268 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs (1.17 kB)[39m[90m (549 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/_name_.get.mjs.map (651 B)[39m[90m (317 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs (814 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/tools/sync.post.mjs.map (282 B)[39m[90m (190 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs (1.21 kB)[39m[90m (483 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/me.get.mjs.map (771 B)[39m[90m (343 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs (1.84 kB)[39m[90m (955 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/users/register.post.mjs.map (1.27 kB)[39m[90m (513 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs (1.62 kB)[39m[90m (647 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channel-templates/_tplId_.post.mjs.map (998 B)[39m[90m (430 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs (1.08 kB)[39m[90m (428 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.delete.mjs.map (550 B)[39m[90m (295 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs (1.07 kB)[39m[90m (424 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/_id/channels/_channelId_.post.mjs.map (546 B)[39m[90m (292 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs (964 B)[39m[90m (402 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/api/workshop/workspaces/index.delete.mjs.map (451 B)[39m[90m (260 B gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs (15.1 kB)[39m[90m (5.42 kB gzip)[39m
[90m  ├─ .output/server/chunks/routes/renderer.mjs.map (1.82 kB)[39m[90m (386 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs (94 B)[39m[90m (100 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/_virtual_spa-template.mjs.map (90 B)[39m[90m (98 B gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs (952 kB)[39m[90m (264 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/entry.mjs.map (8.18 kB)[39m[90m (1.5 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs (213 kB)[39m[90m (22.4 kB gzip)[39m
[90m  ├─ .output/server/chunks/virtual/precomputed.mjs.map (198 B)[39m[90m (162 B gzip)[39m
[90m  ├─ .output/server/index.mjs (864 B)[39m[90m (335 B gzip)[39m
[90m  └─ .output/server/package.json (3.07 kB)[39m[90m (1.11 kB gzip)[39m
[36mΣ Total size:[39m 22.9 MB (5.69 MB gzip)
[build] prompts copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\prompts
[build] optimizer python copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\optimizer-python
[build] schema.json copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\schema.json
[build] aml python assets copied → D:\codes\ABO\AgentWorkShop-project\.output\.AgentWorkShop\aml-python
[90m[[90mnitro[90m][39m [32m✔[39m You can preview this build using [36mnode .output/server/index.mjs[39m
│
└  ✨ Build complete!
› 外置资产随产物分发:prompts, schema.json, aml-python
```

## `node scripts/ui/projects-smoke.mjs` — PASS (32s, exit=0)

```
✔ [U0] 构建产物服务启动
✔ [U1] admin 注册
✔ [U2] 真实 API 数据准备
✔ [U3] 列表页渲染项目
✔ [U4a] 详情页概览 tab：项目名/频道/周报
✔ [U4] 五 tab 全渲染：计划与工作/交付物/审批/决策与事件
✔ [U5] 页面无未捕获异常

=== UI SMOKE pass=7 fail=0 ===
{
  "pass": 7,
  "fail": 0,
  "results": [
    {
      "id": "U0",
      "name": "构建产物服务启动",
      "pass": true,
      "detail": "port=3985"
    },
    {
      "id": "U1",
      "name": "admin 注册",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "U2",
      "name": "真实 API 数据准备",
      "pass": true,
      "detail": ""
    },
    {
      "id": "U3",
      "name": "列表页渲染项目",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n简体中文\nU\nui-admin\nADMIN\n项目\n\n项目总工 +"
    },
    {
      "id": "U4a",
      "name": "详情页概览 tab：项目名/频道/周报",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n381024fc-5758-4171-b934-7db322ca"
    },
    {
      "id": "U4",
      "name": "五 tab 全渲染：计划与工作/交付物/审批/决策与事件",
      "pass": true,
      "detail": "plan=true del=true ap=true ev=true"
    },
    {
      "id": "U5",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```

## `node scripts/ui/projects-interactions.mjs` — PASS (45s, exit=0)

```
 "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I0c",
      "name": "seed 频道（供 UI 绑定）",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I1",
      "name": "列表页渲染（含新建项目表单）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9"
    },
    {
      "id": "I2",
      "name": "UI 建项目 → 列表出现",
      "pass": true,
      "detail": "交互项目-bskv"
    },
    {
      "id": "I3",
      "name": "打开详情页",
      "pass": true,
      "detail": "http://127.0.0.1:3982/projects/47e59076-9c2c-45db-9799-084b8514f35b"
    },
    {
      "id": "I4",
      "name": "UI 绑定频道 → 列表出现",
      "pass": true,
      "detail": "d88e16b3-05bc-4b1d-8034-dbddb9ebc0f6"
    },
    {
      "id": "I5",
      "name": "UI 建交付物",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I6",
      "name": "UI 建工作项 → 行出现",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I7",
      "name": "UI 激活 → active 徽标",
      "pass": true,
      "detail": "badge active"
    },
    {
      "id": "I7b-req",
      "name": "plan approval pending 已创建",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "I7b",
      "name": "UI 批准计划 → planVersion=1",
      "pass": true,
      "detail": "btn=true version=1"
    },
    {
      "id": "I8",
      "name": "UI 派发 → DISPATCHED（API 确认）",
      "pass": true,
      "detail": "state=DISPATCHED "
    },
    {
      "id": "I9a",
      "name": "完成后对账 → 工作项 COMPLETED（计划与工作 tab）",
      "pass": true,
      "detail": "work item state"
    },
    {
      "id": "I9b",
      "name": "对账 → 成果 draft（交付物 tab）",
      "pass": true,
      "detail": "result draft"
    },
    {
      "id": "I10a",
      "name": "成果提交（channel lead 工具）→ submitted",
      "pass": true,
      "detail": "{\n  \"ok\": true,\n  \"result\": {\n    \"id\": \"eb62cd4e-2bc6-4363-87d1-53d9476f699b\",\n    \"status\": \"submitted\",\n    \"title\": \"交互工作项 成果\",\n    \"workItemId\": \"a426ff8f-df9c-40b0-a7ec-25509c78b9bd\",\n    \"attem"
    },
    {
      "id": "I10a-ui",
      "name": "提交态在交付物 tab 可见",
      "pass": true,
      "detail": "submitted badge"
    },
    {
      "id": "I10b",
      "name": "复核 → reviewed",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I10c",
      "name": "申请验收 → 待审批出现（审批 tab）",
      "pass": true,
      "detail": ""
    },
    {
      "id": "I11",
      "name": "批准 → 成果 approved / 交付物 approved（UI 点击 + API 兜底确认）",
      "pass": true,
      "detail": "approval=approved result=approved"
    },
    {
      "id": "I12a",
      "name": "leader 派发提案（API）",
      "pass": true,
      "detail": "{\n  \"ok\": true,\n  \"proposalId\": \"8efffb16-6cb2-4f10-b7a3-ccb8d85b54ba\",\n  \"status\": \"proposed\",\n  \"next\": \"owner 在项目页应用提案后生成工作项（dispatch=true 时一并派发）\"\n}"
    },
    {
      "id": "I12",
      "name": "页面点击应用提案 → 工作项出现",
      "pass": true,
      "detail": "dispatch.proposed applied"
    },
    {
      "id": "I13",
      "name": "周报卡片渲染（进度/交付物/成果数字）",
      "pass": true,
      "detail": "AGENTWORKSHOP\nDIGITAL TWIN\n控制台\n仪表盘\nAgent 工作台\n数字孪生\n数采中心\n产线运营\n数据管理\nEDA 工坊\n建模\n优化器\n本体模型\n运维\n产线操作\n数据分析\n运行时监控\n产线日志\n系统\nAPI Token\n用户管理\n权限管理\n插件管理\n工具管理\n系统设置\nv0.9.5\n/\ndev\nProjects\n47e59076-9c2c-45db-9799-084b8514"
    },
    {
      "id": "I14a",
      "name": "计划与工作 tab：计划快照 + retry/cancel 按钮",
      "pass": true,
      "detail": "plan tab"
    },
    {
      "id": "I14b",
      "name": "交付物 tab：成果按交付物分组展示",
      "pass": true,
      "detail": "deliverables tab"
    },
    {
      "id": "I14c",
      "name": "审批 tab：待审批 + 审批历史",
      "pass": true,
      "detail": "approvals tab"
    },
    {
      "id": "I14d",
      "name": "概览 tab：受保护徽标 + 打开办公室入口",
      "pass": true,
      "detail": "overview tab"
    },
    {
      "id": "I15",
      "name": "页面无未捕获异常",
      "pass": true,
      "detail": ""
    }
  ]
}
```
