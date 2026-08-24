## 目标

对照你贴出的需求文档，在现有 AgentWorkShop（Nuxt4 + Vue3 + Three.js + SQLite + WS）基础上补齐「3D 数字孪生小镇」的关键缺口，不破坏既有功能（Phaser 2D 渲染器、角色资产上传/绑定、设备孪生控制等全部保留）。

## 现状差距（已核实）

| 需求 | 现状 | 动作 |
|---|---|---|
| 设备场景实例持久化（位置/旋转/缩放，刷新恢复） | ❌ 设备节点纯内存，位置丢失；缩放仅 localStorage | 设备孪生扩充 transform + PATCH 路由 + 场景恢复 |
| 编辑/浏览双模式 + 设备移动/旋转 | ❌ 只有缩放滑杆，无模式 | 新增模式开关 + 地面拖拽 + 旋转滑杆 |
| 服务端设备模型资源扫描 | ❌ 仅前端 Vite import.meta.glob，运行期不生效 | 新增服务端扫描 API |
| WebSocket 场景事件（device.\*） | ❌ 无 | AEP 新事件类型 + 服务端广播 |
| SVG 赛博背景贴图 | ❌ 无（纯色背景） | 新建 SVG + 作为地面贴图/页面背景 |
| Channel→默认角色模型绑定语义 | ⚠️ 仅 agent 级 modelRef | Channel 级默认模型 + Agent 继承/覆盖 |
| 角色不可被普通用户拖拽 | ✅ 3D 渲染器本就不支持角色拖动 | 编辑模式增加管理员布局位（可选小项） |
| 模型加载失败提示/不白屏 | ✅ 已有 fallback | 保持 |

## 实施内容（按模块）

### 1. 服务端 — 设备孪生 transform + PATCH + WS 广播
- `server/services/workshop/assets/device-twin.repo.ts`：DeviceTwin 行增加 `posX? posZ? rotationY? scale?`；create/update 支持。
- `server/api/workshop/device-twins/[id].patch.ts`（新增）：PATCH { name?, modelRef?, posX?, posZ?, rotationY?, scale? } → repo.update → 广播 `device.updated`。
- `server/api/workshop/device-twins/index.post.ts`：create 接受可选位置字段 → 广播 `device.created`。
- `server/api/workshop/device-twins/[id].delete.ts`：删除后广播 `device.deleted`。
- `server/api/workshop/ws.ts`：新增 `broadcastSceneEvent(type, payload)`（遍历 hub peerChannels 全部 peer，sendControl 发 AEP 信封，channelId=''），REST 处理函数调用。

### 2. 服务端 — 设备模型资源扫描
- `server/api/workshop/assets/devices.get.ts`（新增）：readdir `process.cwd()/public/assets/game/devices`，扫描 `.glb/.gltf/.obj/.fbx`，返回 `{ devices: [{ id, name, file, fileType, category:'device', defaultScale, size }] }`；目录缺失返回空数组（不报错）。同时扫描 `character` 目录的 `.glb` 作为补充角色 3D 资产。

### 3. 共享协议
- `shared/workshop-protocol.ts`：AepEvent 增加 `device.created | device.updated | device.deleted`（payload 含 id/name/modelRef/pos/rotation/scale/state）；文档注释 + AEP_GROUPS 补充。

### 4. 前端 composable
- `app/composables/workshop/useDeviceTwins.ts`：`DeviceTwinView` 加 transform 字段；新增 `update(id, patch)`（走 PATCH）。
- `app/composables/workshop/useCharacterAssets.ts`：设备模型来源改为主拉服务端 `GET /api/workshop/assets/devices`（合并进 kind='dev' 清单），Vite glob 降级为 fallback。

### 5. 3D 场景 TownScene3D.ts
- 新增 `setMode('browse' | 'edit')` / `getMode()`。
- **设备交互（编辑模式）**：`tryStartDeviceDrag(cx,cy): boolean`（编辑模式指针按下命中设备→按住拖曳，xz 平面跟随）、`moveDeviceDrag(cx,cy)`、`endDeviceDrag()`（结束→防抖 `devices.update` 保存位置，上报 saveState）；`setModelRotation(id, deg, kind)` 旋转设备（编辑模式）；已有 setModelScale 保留，编辑模式结束时把设备 scale 一并 `devices.update` 持久化。
- **场景恢复/同步**：`syncDevices(twins)` —— 遍历服务端 twins：有位置且未建节点→按保存的 pos/rotation/scale 重建节点；已有→更新 state/telemetry（并仅当无拖拽时收敛 transform）；已删除→移除节点。启动时 + `device.*` 事件 + 现有轮询（bindDevicePoll 扩展）调用。
- **Agent home 持久化（编辑模式管理员布局）**：ensureAgent 读取实体 baseline 的 `homeX/homeZ`（来自 config）作为初始位置；编辑模式允许拖动 Agent 改 home，结束经 `devices` 同款注入的 `agents.updateHome(agentId, x, z)` 走既有 `updateChannelAgent`（config 合并）持久化。
- **SVG 地面**：initRenderer 用 TextureLoader 加载 `/scene/background/cyber-town-background.svg` 作为 ground 贴图（WRAP repeat、低对比度、失败回退现纯色）。
- 选中设备时显示高亮环（编辑模式）；`getDebugState()`/`getMinimapState()` 扩展设备节点可见性。

### 6. TownView.vue（HUD / 壳层）
- 顶栏加 **浏览/编辑模式切换**（编辑模式禁用时设备点击仅信息；编辑模式显示"布局编辑中"提示）。
- 与场景协作：canvas pointerdown 先问 `scene.tryStartDeviceDrag()`，命中则跳过相机平移；move/up 分派。
- 选中面板（编辑模式）增加设备**旋转滑杆**（0–360°），与缩放滑杆并列。
- 保存状态 HUD chip：未保存/保存中/已保存/保存失败（监听 scene saveState 事件）；加「保存布局」按钮强制全量 flush。
- townBus 订阅扩展：`device.created/updated/deleted` → `scene.syncDevices(deviceTwins.twins)` 即时同步（轮询兜底不变）。
- `.town-page` 背景用 SVG。

### 7. 资源
- `public/scene/background/cyber-town-background.svg`（新增）：深色渐变 + 透视网格 + 发光线路 + 节点数据流 + 城区轮廓 + 低对比度 + 1600×1200 高宽比；不写死文字。

### 8. 验证
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全绿。
- 服务端扫描/设备 PATCH 用 node 冒烟脚本（直接调 repo/扫描函数）验证。
- 若可行，跑现有 `pnpm dev` + 现有 E2E 脚本（test-town-drag.mjs）确认未回归。

## 明确不做的（控制范围）
- 不改 Phaser 2D 渲染器（保持 `?render=2d` 可用）。
- 不改 SQLite schema（Agent home 走 config_json；设备 transform 走 JSON repo，与现有资产/孪生仓库一致）。
- 不做场景区域命名（Central Plaza 等）装饰、不在场景内造建筑挤出（现状环形领地已满足"可同时容纳多 Agent/设备"）。
- 不引入 TransformControls（与自研相机冲突风险，地面拖拽+滑杆更稳）。

## 交付后说明
完成后汇总：新增/修改文件清单、API 列表、事件列表、资源路径、启动命令、遗留限制。