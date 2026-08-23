# RPG 演练场删除 + 小镇独立页 + 模型/设备客制化 —— 落地 Plan

## 需求判读（用户 5 项）
1. **删除 RPG 演练场 page**（`app/pages/game.vue` + 其全套 `app/game/*` + 服务端 `/api/game/*` + `#shared/game-protocol`）。
2. **Agent 小镇独立成单独 page**（`/town`），脱离 workspace 控制台。
3. **真正模型↔Agent 绑定** + **实时对话消费** + **Action 行为**（沿用已建成的 TownScene3D + townBus + FSM，仅确保独立页可跑）。
4. **设备实体放到固定文件夹**让项目自动识别，**手动拖拽放置**。
5. **模型大小自适应 + 缩放调节**（选中后弹滑杆，可客制化）。

已确认 4 项决策：**全频道汇聚一镇**、**一并删除 game 全套**、**固定目录+自动扫描**、**场景内选中弹缩放滑杆**。

## 现状判读（已探明）
- 小镇 `TownScene3D.ts` 已支持多频道（`buildBlocks` 遍历 `_seed`，`TownEntityInput[]`）。
- `app/pages/game.vue` 是 `/game` 唯一前端入口，`~/game/*` 仅被它引用；删除无连带破坏。服务端 `/api/game/*` 是死代码。
- `useWorkshopWs` 是**全局单例**（`globalThis.__workshopWs`），任意页面 `subscribe(channelId)` 即可拿到实时流；Snapshot 一次性填充 `entities.channels/agents/tasks`。
- 小镇组件 `app/components/workshop/town/TownView.vue`（`<workshop-town-view>`）目前接收 `props.channelId`，内嵌在 `[wsId].vue` 的 `view==='town'`。
- 新 `/town` 页必须**自行订阅所有频道**并在卸载时退订（现有页面模式，可复用）。

## 实施步骤

### A. 删除 RPG 演练场（全链路，1 步）
- 删除文件：`app/pages/game.vue`、`app/game/`（client.ts/protocol.ts/rpg-scene.ts）、`server/api/game/`（brain/cmd/ws）、`server/services/game/`（agent/session）、`server/types/game.ts`、`shared/game-protocol.ts`、`shared/game-protocol.json`。
- 覆盖清理引用：
  - `app/components/AppSidebar.vue`：删 `/game` menu 项，新增 `/town` 项（icon `i-tabler-map-2`，label `t('menu.town')`）。
  - `app/pages/index.vue:107`：`navigateTo('/game')` → 改指向 `/town`（或删除该 hero 按钮）。
  - `i18n/locales/en.ts` & `zh-CN.ts`：`menu.game` → `menu.town`（en `'Town'`，zh `'小镇'`）。
  - `app/composables/useRouteMeta.ts`：`'/game'` 条目 → 换 `'/town'`。

### B. 小镇独立页 `/town`（核心）
- 新增 `app/pages/town.vue`，`definePageMeta({ layout: 'default', title: 'Agent 小镇' })`。
- 数据面（全频道汇聚）：
  - `useWorkspacesStore().load()` → 遍历所有 `workspace.channelIds`，`useWorkshopWs().subscribe(each)`（`onMounted` 订阅、`onBeforeUnmount` 退订）。
  - 用 `useEntitiesStore()` 构建全量 `TownEntityInput[]`（复用 `TownView.buildTownInput` 逻辑，但跨 workspace 收集 `entities.channels`）。
  - 顶层 `TownViewScene3D` 挂载（复用 `<workshop-town-view>`，传 `channel-id` 为当前聚焦频道——因为 `TownView` 内 `focusChannel` 需要单个频道；但场景 `rebuild` 会铺**全部** `entities.channels`）。为满足「全频道汇聚」，让 `TownScene3D` 直接收全量 `buildTownInput()`（`entities.channels` 已含所有已订阅频道）。
  - 处理 401/空频道：场景未 ready 时显示加载态；无任何频道时提示「到工作台挂载频道」。
- 交互与实时：沿用 `wireCommon`（事件订阅、HUD、跑马灯、迷你地图）、`bindSceneInput`（2D/3D 分发）、`bindDevicePoll`。这些逻辑目前写在 `TownView.vue` 内，独立页会**直接复用 `<workshop-town-view>`**，因此只需一个 `channel-id` 用于 `focusChannel`；其余（全频道楼层、订阅）由 `town.vue` 负责。
- `[wsId].vue`：保留 `view==='town'` 内嵌（回退）；但新增侧栏入口直达 `/town`。

### C. 设备实体 → 固定目录自动识别
- 建目录 `public/assets/game/devices/`；`useCharacterAssets` 增加 `scanDevices()`：用 `import.meta.glob('/public/assets/game/devices/*.glb', { eager: true, query: '?url' })` 自动把该目录 `.glb` 登记为 `kind:'dev'` 模型（id=文件名，name=文件名可读化），并与内置 `device-3d` 合并。
- 把 `.glb` 丢进 `devices/` → 自动出现在 AssetLibrary「设备」卡，可拖拽进小镇生成设备节点（`TownScene3D.dropModelOnWorld` 已按 `kind==='dev'` 分支）。

### D. 场景内选中 + 缩放调节 / 自适应（客制化）
- `TownScene3D` 新增：
  - **选中**：`onPointerUp`/raycast 命中 Agent 或 DeviceNode → 设为 `selected`，回调 Vue `scene.on('select', { kind, id, scale })`。
  - **缩放滑杆**：新增公开 `setModelScale(agentIdOrDeviceId, scale)` 与 `getSelectedScale()`；`mountModel`/`spawnDeviceNode` 时用模型 `scale`（默认 `UNITS/height` 归一化即自适应）乘用户缩放。
  - **节流**：滑杆拖动时 realtime `setModelScale`。
  - **刷新持久**：`scene.on('scaleChange', ...)` 把缩放% 存入 Vue（可存 `localStorage['town.scale.<id>']`，重建时恢复）。
  - 选中 Agent/设备时弹 `<div>` 缩放滑杆（0.2x~5x），显示「缩放 xx%」。
- 自适应：`mountModel`/`loadGltfToGroup` 始终先用 `Box3` 求包围盒高 → `scale=UNITS/height` 归一化贴地（已实现）；用户缩放在其上再乘。

### E. 实时对话 + Action 行为保障
- 复用已建成的链路：`useTownBus.emit` → `handleTownEvent` → bubbles + FSM（roam/approach/wait/returnHome）+ `parseActionFromEnvelope`。独立页 `wireCommon` 已接线，确认 `resolveTaskAssignee` 注入即可。
- 验证 mock 环境下角色跑动/说话/进度与对话消费。

### F. 模型绑定点位确认
- `buildTownInput` 已带 `modelRef`；`registerModelsFromList`（带 kind）→ `mountModel` 按 `modelRef` 加载对应 GLB。独立页注册模型库（含 `devices/` 扫描结果）。

## 涉及文件
```
删除: app/pages/game.vue, app/game/*, server/api/game/*, server/services/game/*, server/types/game.ts, shared/game-protocol.{ts,json}
新增: app/pages/town.vue, public/assets/game/devices/
改动: app/components/AppSidebar.vue, app/pages/index.vue, i18n/locales/en.ts & zh-CN.ts,
     app/composables/useRouteMeta.ts, app/composables/workshop/useCharacterAssets.ts,
     app/components/workshop/town/TownScene3D.ts(选中+缩放),
     (可选) app/components/workshop/town/TownView.vue(选中回调/缩放注入), [wsId].vue(侧栏入口)
脚本: scripts/build-model-3d.mjs(保持), 新增设备扫描无独立脚本(用 import.meta.glob)
```

## 风险与取舍
- **全频道汇聚**依赖 `workspaces.load()` + 订阅所有 channel；频道多时性能靠既有 `TownScene3D` 池化/剔除。
- **`import.meta.glob` 扫 `public/`**：Nuxt 对 `public/` 的 glob 需用 `?url` 且路径相对 `app/`（用 `../../../public/...` 或 `@/../public` 处理）；若不识别可退化为「服务端 GET /api/workshop/assets/character 已含 device 上传 + 本地 glob 兜底」双轨。
- `/town` 独立页在 default layout（含侧栏/头）内渲染，高度需按 `--app-header-h/--app-footer-h` 做全屏（复用 harness 的高度计算）。
- 保留 `[wsId].vue` 内嵌小镇作为回退，不破坏现有 4 视图。

## 验收
`pnpm dev`：侧栏无 `/game`、有 `/town`；`/town` 渲染全频道 3D 小镇；模型库含 `devices/` 自动扫描的设备；拖设备进场景生成节点；点击角色/设备弹缩放滑杆且大小实时变化；对话气泡/跑动/进度正常。E2E（`test-town-*`）+ lint/tsc 干净 + 截图走查。

## 需你后续配合
- 把真实角色 GLB（带动画）放 `public/assets/game/character/`（或上传）；把设备/实体 GLB 放 `public/assets/game/devices/`（自动识别）。
- 真实设备数据采集/控制留原开放入口（`/api/workshop/device-twins/:id/telemetry|control`、MCP `device.*`）。
