# 共鸣城邦 · AgentTeam RPG 小镇 — 落地开发 Plan

> 依据 `docs/town-proposal.md` 产品策划，拆解为可执行、可验收、可回退的开发计划。
> 已核对真实代码基线（Phaser `^4.2.1`、`app/components/workshop/town/TownScene.ts`、`app/game/rpg-scene.ts`、`app/composables/workshop/useTownBus.ts`、`shared/town-behavior.ts`、`shared/town-protocol.ts`、`app/stores/workshop/entities.ts` 的 `modelRef` 已存在）。

---

## 0. 现状基线（从哪开始）

| 层 | 已有 | 缺 |
|---|---|---|
| 数据面 | `useWorkshopWs` ingest → `events/entities` store + `useTownBus.emit()` 旁路 | — |
| 决策层 | `shared/town-protocol.ts`（`eventToBubble`/`mapEnvelopeToIntent`）、`shared/town-behavior.ts`（`parseActionFromEnvelope`/`stepToward`/`ARRIVE_DIST`） | 道路样条寻路、多状态动画（idle/walk/work）映射 |
| 表现层 | `TownScene.ts`：共鸣领地、同频道同色 aura、行为 FSM（roam/approach/wait/returnHome）、全部角色可拖动、`dropModelOnWorld` 换装/生成居民、`getDebugState()` | 大坐标世界地图、2.5D 挤出、迷你地图、事件跑马灯、服务端上传 + 注册表 + 引删保护 |
| 资产 | `public/assets/game/wuwa/*`（场景/特效/精魂）、`public/assets/game/character/*`（knight/mage/bot）、`AssetLibrary.vue`、`useCharacterAssets.ts` | 服务端上传、zip/manifest 支持、单帧支持、预览/校验/引删 |

**结论**：数据面零改动；决策层已具备 `ActionContext` 抽象，可直接扩展；表现层是本次工作量主体；资产管线已有一半（前端拖拽加载），缺服务端持久化与多形态支持。

---

## 1. 技术选型（已定）

- **渲染**：Phaser 4（`^4.2.1`，`Phaser.Scale.FIT`、arcade 物理、`Tilemap`、`tweens`、`add.particles`）。不引 Three.js —— 用「斜俯视 + 视差 + y-排序 + 阴影 + 建筑挤出」做伪 2.5D。
- **框架**：Nuxt 4（`<script setup>`），组件自动导入（`app/components/workshop/*.vue` → `<Workshop*>`），Pinia stores，`@vueuse/core`，UnoCSS + 设计系统 token（`--paper/--ink/--accent/--glass-*`）。
- **数据**：AEP 协议（`shared/workshop-protocol.ts`），WS 经 `useWorkshopWs`，小镇经 `useTownBus` 旁路（与时间线同源，不新增连接）。
- **服务端**：`server/api/workshop/**` + `server/services/workshop/**`（`defineApiHandler` / `AppError` / `resolveUser` / `getWorkshopManager` 既有惯例）。资产落盘用文件系统 + JSON 注册表（轻量，无需迁移 DB；如需跨实例再换 SQLite）。

---

## 2. 架构设计（三层驱动链，沿用现状）

```
┌─ 数据层(零改动) ─────────────────────────────────────────────┐
│ useWorkshopWs.ingest → events/entities store                 │
│   └── townBus.emit(e)  (旁路,注释一行回退)                    │
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─ 决策层(纯函数,可单测) ──────────────────────────────────────┐
│ shared/town-protocol.ts  事件→气泡/意图                      │
│ shared/town-behavior.ts  事件→ActionContext + stepToward      │
│ shared/town-nav.ts  (新) 道路样条样条点 + 寻路步进(纯函数)    │
│ shared/town-anim.ts  (新) 模型id→ idle/walk/work 帧映射(纯函数)│
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─ 表现层(TownScene) ──────────────────────────────────────────┐
│ FSM + 相机 + 2.5D 渲染 + 迷你地图 + 事件 HUD                  │
│ 模型: modelRef → 注册表 → 纹理 key → 动画状态                 │
└──────────────────────────────────────────────────────────────┘
         ▲                                        ▲
         │ 用户拖拽加载(drop)                     │ 用户上传(AssetLibrary)
         └────────────────────────────────────────┘
```

**原则**：决策层是纯函数（零 Phaser，可独立单测）；表现层只读状态、只做渲染；渲染与交互解耦。

---

## 3. 模型文件格式 & 放置目录（**你可立即准备**）

### 3.1 目录结构
```
public/assets/game/
├── wuwa/            # 内置场景/特效/精魂(已存在,勿动)
│   ├── scene-map.png
│   ├── wu-aura.png / wu-ring.png / wu-slash.png
│   ├── wu-lead.png / wu-worker-0/1/2.png
│   └── world-map-*.png   # (P1) 大世界分层背景: 远山/中景/地面
├── character/       # ★ 用户角色模型放这里(Agent 角色)
│   ├── knight.png / mage.png / bot.png   # (已示例)
│   └── <your-model>.png
├── props/           # ★ ★ 实体/建筑物体模型放这里(街区地标/工作台)
│   └── <object>.png
```

### 3.2 支持格式（按从易到难）

| 形态 | 文件 | 规则 | 适用 |
|---|---|---|---|
| **单帧 PNG** | `<name>.png` | 一张站立/静止图，透明底 | 静态物体、简单角色 |
| **精灵表 Sprite Sheet** | `<name>.png` | 水平一排，等宽高帧；运行时按 `frameWidth/frameHeight/frames` 切 | 角色（推荐，4 帧悬停已支持） |
| **多状态 Zip + manifest.json** | `<name>.zip` 内含 manifest | `manifest.json` 声明各状态起止帧；运行时按 idle/walk/work 切换 | 完整角色包 |

**约定（当前内置模型已遵循）**：
- 推荐精灵表 **48×88 像素/帧，共 4 帧**（与 `wu-*`、`knight/mage/bot` 同布局），运行时自动播 `wu-bob-<id>` 悬停动画。
- 透明背景（PNG alpha）；满帧不上色描边，`setTint` 换成频道色。
- 锚点默认 `(0.5, 1)`（脚底中心），角色"踩"地不悬浮；场景自动配同频道色落地阴影。

### 3.3 运行时如何认出模型
- 模型文件放进 `public/assets/game/character/`（角色）或 `public/assets/game/props/`（物体）。
- 前端清单 `app/composables/workshop/useCharacterAssets.ts` 的 `models: [{ id, name, file, frames, frameWidth, frameHeight }]` 注册（现在手写；P4 改为 REST 拉取）。
- `TownScene.preload()` 用 `this.load.spritesheet(id, file, { frameWidth, frameHeight })` 预载；P4 后改由批量注册动态加载。

### 3.4 物体(实体)模型
- 街区地标/工作台/共鸣核心塔等**静态装饰**用**单帧 PNG** 或精灵表，放 `props/`。
- 场景用 `add.image`（无行为）或 `physics.add.sprite`（可碰撞）。物体走「顶面+侧壁挤出」时用两片 PNG 或一张带体积感的图。

> 你现在只需把角色 PNG/精灵表放 `public/assets/game/character/`，物体 PNG 放 `public/assets/game/props/`，然后在 `useCharacterAssets.ts` 清单登记即可立即在场景换装渲染。

---

## 4. 分阶段实施（P0 → P6，每阶段可独立验收/回退）

### P0 模型管线地基（打通「现有模型 → 场景换装」闭环，半天）
- 文件：`TownScene.ts`、`useCharacterAssets.ts`、`AssetLibrary.vue`、`entities.ts`（已基本完成）
- 交付：
  - `registerModelsFromList()` 批量登记；`dropModelOnWorld()` 就近换装 / 落空生成居民。
  - `AgentView.modelRef` 透传；`getDebugState()` 暴露 `textureKey/modelRef/decorated`。
  - 内置模型（knight/mage/bot）在 `preload` 预载，纹理在 `create` 前就绪。
- 验收：把任意 PNG 放 `character/` 并登记，拖到角色即换装（E2E `scripts/test-town-drag.mjs` 全部断言 PASS）。
- 回退：`registerModelsFromList` 传空数组即回退内置精魂。

### P1 大世界 + 自由相机 + 迷你地图（关键改观，2~3 天）
- 文件：`TownScene.ts`、`TownView.vue`、`shared/town-nav.ts`（新）、新增 `world-map-*.png`
- 交付：
  1. 世界坐标扩到 3200×2400，分层视差背景（远山/中景/地面）随相机不同步平移。
  2. `worldFromPage()` 相机反解（已实现）→ 左键拖拽平移 + 滚轮缩放（0.6~2.4x）。
  3. 街区沿环形大道布点（`blocks` 用 `pos` 配置而非横排计算）；中心共鸣核心塔。
  4. **迷你地图** DOM overlay：缩略世界 + 街区色点 + 事件闪烁 + 点击跳转。
  5. 点街区/点角色 → 镜头缓动聚焦（`pan` + `zoomTo`）。
- 验收：`?view=town` 自由巡视全图；点街区跳转；迷你地图同步；截图有纵深。
- 回退：切回原 1600×1200 + 横排。

### P2 2.5D 造型（体积感，2 天）
- 文件：`TownScene.ts`（`drawBlock` 重写）、素材生成脚本
- 交付：
  - 建筑「顶面 + 侧壁」挤出（侧壁随朝向变暗）；统一方向光（一侧高光一侧投影）。
  - 所有角色/建筑脚底椭圆软阴影（`wu-aura` 压低透明度）。
  - `setTexture` 后按 `scaleY 0.95` 轻微压扁 + 锚点 `(0.5,1)`。
- 验收：截图有明显纵深、建筑有体积，角色"踩"地。

### P3 渲染解耦 + 多状态动画（1~2 天）
- 文件：`shared/town-anim.ts`（新）、`TownScene.ts`
- 交付：
  - `shared/town-anim.ts`：`modelId + state(idle|walk|work) → { start, count, frameRate }` 纯函数。
  - `TownScene` 统一走 `anims.create('wu-bob-<id>')`；单帧→`add.image`/单帧 anim；sheet→多帧；zip→按 FSM 状态切。
  - 内置精魂与自定义模型走同一接口。
- 验收：内置/自定义都能播 idle/walk/work。

### P4 素材上传 + 注册表 + 校验/引删（服务端，2~3 天）
- 文件（新/改）：
  - `server/services/workshop/assets/character-asset.repo.ts`（注册表：JSON 文件持久化，`id/workspaceId/name/file/kind/sheet/anims/anchor/scale/author/createdAt/appliedTo`）
  - `server/api/workshop/assets/character.post.ts`（multipart 上传：mime 白名单 png/gif/webp/zip + 尺寸上限 + 像素校验；写入 `public/assets/game/character/<id>.png` 或解 zip）
  - `server/api/workshop/assets/character.get.ts`（列表）/ `.delete.ts`（引删保护）
  - `server/api/workshop/channels/[id]/agents/[agentId]/model.patch.ts`（`{ modelRef }` 绑定；沿用 `manager.updateChannelAgent`）
  - 前端 `useCharacterAssets.ts` 改 REST 拉取 + 上传；`AssetLibrary.vue` 加上传/预览/绑定 UI
- 交付：上传→落盘→注册→可在面板预览→拖拽/绑定到 agent；非法素材拒绝并回显；被绑定时删除→提示停用。
- 验收：上传单帧/sheet/zip 均能渲染；引删保护生效；非法文件不落盘。

### P5 绑定粒度（0.5~1 天）
- 交付：按角色 / 按角色类型(lead/worker) / 按频道 三粒度绑定；换装即时生效；缺失回退内置 + `state` 标记"自定义"。
- 验收：换装正确；非法素材有提示不白屏。

### P6 事件共鸣 + 完工打磨（2~3 天）
- 交付：说话脉冲（波纹）、任务投递沿道路样条走到面前递交档案+握手、完成光柱、错误红涟漪、频道状态旗；HUD 事件跑马灯（"此刻谁在说话"）；无障碍（色盲几何徽记）；性能压测。
- 验收：8 频道同屏流畅；lint/tsc 干净；`getDebugState()` 全断言。

---

## 5. 关键实现要点（避免踩坑）

1. **Phaser 运行时加载**：新纹理尽量在 `preload()` 预载（`create()` 前就绪）。运行时 `this.load.spritesheet` 需 `scene.load` 后 `this.scene.restart()` 或 `this.textures.addSpriteSheet` 同步注册；`dropModelOnWorld` 已用「预载 + `textures.exists`」兜底，勿依赖异步 load。
2. **anchor 与 body**：精灵表 48×88，arcade body `setSize(18,18) + setOffset(15,66)`；锚点脚底 `(0.5,1)` 用 `setOrigin(0.5,1)`。
3. **相机与页面坐标**：`Scale.FIT` → `worldFromPage` 用 `cam.worldView` + canvas `getBoundingClientRect`，避免与 `game.scale.width` 混淆（此前 bug 已修）。
4. **组件自动导入**：`app/components/workshop/AssetLibrary.vue` → 模板用 `<WorkshopAssetLibrary>`（New 组件文件需重启 `pnpm dev` 注册）。不要在根元素用 `v-if="props.compact !== false"`（Vue 模板编译不解析该写法，组件不挂载——已踩坑）。
5. **行为 FSM 与拖动互斥**：拖动时 `dragging=true` 暂停 FSM 与物理；落点即新 home。`startBehavior` 跳过 `dragging` 角色。
6. **数据持久化**：`modelRef` 走 `entities.applyEvent` 的 `agent.member`/`agent.status` 回流；REST 绑定后靠 WS 事件回流写 store（勿双源直写）。
7. **2.5D**：立体感来自 y-排序 + 阴影 + 视差 + 挤出，勿引入 3D 网格。

---

## 6. 与现有模块的集成/风险

| 模块 | 集成 | 风险 | 应对 |
|---|---|---|---|
| `useWorkshopWs` | 不动，仅在 ingest 尾部旁路 `townBus.emit` | 无 | 注释即回退 |
| `entities.ts` | 已加 `modelRef`；REST 绑定靠事件回流 | store 双源 | 以 WS 回流为准 |
| `AssetLibrary.vue` | 自动导入 `<WorkshopAssetLibrary>` | 新组件未注册 | 重启 dev |
| 上传功安全 | mime 白名单 + 尺寸限制 + 像素校验 | 恶意文件 | 拒绝 + 回显 |
| 性能 | 粒子/光柱/大图 | 卡顿 | 池化 + 可视区剔除 + 缩放警告 |
| 色盲 | 仅色相区分 | 不友好 | 颜色 + 几何徽记双通道 |
| 数据面 | 无 | — | 幂等可回退 |

---

## 7. 最终交付形态（一句话）

「一张连续平面大世界上的 2.5D 共鸣城邦」：斜俯视 + 视差 + 阴影 + 建筑挤出；自由视角相机 + 迷你地图；完整的角色模型导入管线（上传/拖拽 → 换装/生成 → `modelRef` 持久化 → `getDebugState` 断言）；每个 Channel 是可辨识的街区，每个 Agent 是可换装的会走会干活的居民，每件事件在世界中有迹可循。

**验收总标准**：`pnpm typecheck` + `eslint` 干净；`scripts/test-town-drag.mjs`（已存在）与新增 `scripts/test-town-e2e.mjs` 全断言 PASS；截图核对纵深/体积/状态可读；8 频道同屏流畅。

---

## 8. 你要先做的（按此准备素材）

1. **Agent 角色模型**：PNG 精灵表，**48×88/帧、4 帧水平排列、透明底**，放入 `public/assets/game/character/<name>.png`；在 `app/composables/workshop/useCharacterAssets.ts` 的 `models` 数组登记 `{ id, name, file, frames:4, frameWidth:48, frameHeight:88 }`。（单帧/多状态 zip 到 P4 支持。）
2. **实体/建筑物体模型**：PNG（单帧或精灵表），放入 `public/assets/game/props/<name>.png`；场景 `drawBlock` 用 `add.image`/`physics.add.sprite` 摆位。
3. **大世界背景(可选，P1)**：`public/assets/game/wuwa/world-map-far.png` / `middle` / `near`，分别远山/中景/地面，透明或整图皆可。
