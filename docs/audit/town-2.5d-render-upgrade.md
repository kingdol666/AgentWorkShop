# Agent 小镇 RPG 2.5D 游戏化渲染升级说明

> 日期：2026-08 ｜ 范围：`app/components/workshop/town/TownScene3D.ts` + `TownView.vue` + `shared/town-scene-math.ts`
> 验证：无头浏览器（Edge/puppeteer-core）真实登录截图目检 —— `docs/audit/screenshots/town-3d.png`、`town-agent-chat.png`、`town-near.png`

## 1. 目标

把 AgentWorkShop 的 Web 数字孪生/Agent 小镇从「可用的 3D 场景」升级为**真正像游戏化数字孪生 + Agent 孪生场景**的 RPG 2.5D 渲染与运动：
- 工业数字孪生专业质感（蓝灰混凝土园区、面板拼缝、网格导引、设备孪生机、遥测状态环）
- RPG 2.5D 观感（斜俯视电影化镜头、雾纵深、穹顶天幕、暗角+扫描线、角色走位与朝向平滑）
- Agent 本人聊天内容**放大渲染**并实时消费（头顶大字号气泡 + 精魂会话台）

## 2. 改动清单

### 2.1 场景氛围与镜头（TownScene3D）
- **镜头**：FOV 50→55，dolly 基线 940→1250、高度 620→760（`loop()` 与 `initRenderer()` 同步）——全园区一块入画的电影化 2.5D 框景
- **雾与天幕**：`Fog(0x0a0f18, 1500, 5400)` 纵深 + 程序化穹顶渐变球（深空→工业蓝灰→地平线辉光，BackSide 大球）
- **地面**：蓝灰混凝土地基（0x27333f）+ **程序化 Canvas 工业贴图**（分块拼缝 8×8 + 32×32 细网格导引线 + 噪点；SVG 历史贴图保留为兼容兜底）；`GridHelper` 颜色/透明度匹配新地色
- **灯光**：环境 1.35 + 新增半球光 0.55 + 主方向光 2.6（2048 阴影）+ 补光 0.6

### 2.2 领地平台（工业孪生工位基座）
- 平台半透明 0.3 + **自发光 0.18**；边缘发光环 0.75（加宽）；**中央信标灯柱**（立柱 + 发光顶球 + 底座光环）
- `Block3D.moveBy/resetAll` 同步跟随/清理新节点

### 2.3 Agent 角色与运动
- **脚下双层色环**（主环 0.85 + 外圈 0.26，角色辨识度）
- **朝向平滑插值**（左/右两态最短角差限速转向，替代瞬间 snap）
- **无动画程序化呼吸/行走浮动**（待机呼吸 1.2±1.4、行走颠簸 0~5；有 GLB clip 时仍走 mixer）
- **程序化「孪生机器人」兜底模型**（胶囊躯干 + 头部 + 面窗发光条 + 胸灯 + 天线信号球 + 悬浮底盘）——GLB 缺失/失败时角色永不隐形（替换原空 Group 回退）

### 2.4 聊天气泡放大 + 实时消费（核心命题）
- **共享 `bubbleDisplayMs`**：1.4–3.4s → **2.2–5.6s**（长句可读窗口翻倍）
- **气泡画布**：正文 14px→**16px**、头名 11→12.5px、最大宽 268→**400px**、行高 19→22、最多 3 行→**5 行**、气泡宽上限 360→**560px**、世界尺度 3.2→**2.6**（更大更醒目）
- 气泡锚点整体抬升 +16，避免压到角色名牌
- **精魂会话台（TownView 新增）**：点选 Agent 后，左下角展示**其本人**近实时消息的大字号会话窗（14.5px 正文、首条加粗、● LIVE、数据随 `townBus` 实时流 FIFO 消费）

### 2.5 HUD 电影感
- `.town-frame::before` 暗角（柔和边缘 0.3）+ `::after` 扫描线（1px/4px 低透明度，screen 混合）；`prefers-reduced-transparency` 下自动关闭

## 3. 验证

| 项 | 结果 |
|----|------|
| WebGL 渲染链路 | ✅（修复驱动转向缺 `const dir = next.dir` 导致的每帧 ReferenceError——曾使渲染循环中断、场景空白） |
| 2.5D 场景（领地/角色/泵机/网格/雾/暗角） | ✅ 截图目检 |
| 头顶大字号气泡（实时注入对话） | ✅ 截图目检（3 条消息 3 行气泡） |
| 精魂会话台（选中角色 → 本人消息实时消费） | ✅ 截图目检（● LIVE + 3 条大字号） |
| 无回归 | 页面加载无 console 错误；既有 HUD（模型库/频道坞/数字孪生/迷你地图/编辑面板）不变 |

## 4. 后续可选（本期未做，避免过度设计）
- 设备孪生机旋转/脉冲动画（当期保持静态状态环+遥测，够用）
- 建筑/绿化道具库（可经现有 AssetLibrary 上传模型扩展，无需硬编码）

---

## 5. 本轮追加：二次元角色 GLB + 设备模型 + 装饰移除 + 动画绑定修复

### 5.1 移除随机装饰物
- 删除全部「无限荒野装饰物」系统（`mulberry32/decorParts/scatterDecor/clearDecor` + InstancedMesh 散布与字段），场景回归**干净的工业园区**；随机道具不再出现在领地周围。

### 5.2 二次元角色默认模型（带动作绑定，Blender 可加载）
- **生成器 `scripts/build-anime-models.mjs`**（three.js GLTFExporter 官方管线；Node 需 FileReader polyfill）产出：
  - `public/assets/game/character/hero-anime-1..4.glb`：4 个二次元 chibi 角色（樱叶少女/苍梧少年/寒川工程师/紫檀智子），大脑袋+发色+呆毛+发光眼+群摆，每模型 **idle + walk 两段命名节点动画**（非骨骼，glTF node TRS channels——Blender 导入即得动作，无需绑定骨骼）
  - `public/assets/game/devices/device-scanner.glb / device-console.glb / device-robot-arm.glb`：工业设备模型（扫描门/操作台/机械臂），带待机动画，**拖入场景即生成数字孪生**
- **Agent 默认加载**：`ensureAgent` 默认 `modelRef || 'hero-anime-1'`（樱叶少女），可经频道成员管理换装为任意角色/模型；服务端运行期文件系统扫描自动把新模型注册进模型库/换装下拉（`GET /api/workshop/assets/devices`）。

### 5.3 动画绑定缺陷修复（关键）
- `loadGltf()` 曾只返回 `{ scene }`，把 `gltf.animations` 丢弃——hero-3d（无动画）不暴露，换动漫模型后 idle/walk 全部丢失。修复：返回 `{ scene, animations }` 并写入 `agentAnimClips`；`mountModel` 初始播放后记录 `activeAction`，与 `playWalkAnim` 的 crossfade(idle↔walk) 对齐。
- 运行时验证：`clips=[idle,walk]`、`mixer=true`、`activeAction=idle`，行走时自动切 walk。

### 5.4 验证（无头浏览器截图目检）
- `town-3d.png`：动漫角色立于领地、装饰清空、设备库出现 device console/robot arm/scanner
- 无 console 报错；GLB 文件经 GLTFLoader 往返校验（动画数、通道数均正确）
