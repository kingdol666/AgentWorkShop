# 全站自适应 / README / 文档站 —— 实测验收报告(2026-09-15)

> 本文件的每个数字都来自**真实浏览器**(本机 Chrome,devtools 协议驱动)对
> **正在运行的实例**的几何量测,不是估算、不是设计意图描述。复现命令写在文末。

## 0. 一句话结论

| 项目 | 结果 |
|---|---|
| 全站视口矩阵(7 视口 × 16 页面 × 明暗双主题 = **224 组合**) | **224 通过 / 0 失败** |
| 抽屉导航交互(开 / 遮罩 / Esc / 路由跳转自动收 / 滚动锁) | **10 通过 / 0 失败** |
| 生产构建 | 0 error,16 条路由全部 200 |
| eslint(app/server/shared/cli/sdk/i18n/scripts/ui) | **0 error**(18 warning 为既有) |
| README 结构自检(标签配平 / 图片存在 / 表格列数 / 模板残留) | 中英双版全部通过 |
| VitePress 构建 | 0 error,48 个 HTML 页 |

**验收判据**(`scripts/ui/verify-responsive.mjs` 的 `THRESHOLDS`,唯一口径):

- 文档级横向溢出 = 0
- 元素右边缘越出视口 = 0(可横向滚动容器内的元素豁免)
- 视口外固定元素 = 0(窄屏收起的抽屉已 `visibility:hidden`,不再计入可达树)
- 字号:窄屏(≤640)正文/标签 ≥ 11px,桌面 ≥ 9.5px
- 触摸目标:粗指针下文本控件高度 ≥ 30px;纯图标控件两向 ≥ 30px 或已用伪元素外扩命中区
- 对比度:WCAG 2.1 AA(正文 4.5:1,大字 3:1)。非活动控件豁免(WCAG 1.4.3 明文);
  背景为渐变/图片的元素豁免(无法由计算样式推导)

## 1. 改了什么(按层)

### 1.1 全局响应式层(新增,唯一口径)

**`app/assets/css/main.css` v5 响应式层** —— 断点数值的唯一定义处。
形态是**「叠层仪表台」**(桌面三栏 → 平板双栏 → 手持抽屉),不是把桌面缩小:

- 结构性兜底:`html,body{overflow-x:clip}`(用 clip 而非 hidden:不产生滚动容器、不破坏 sticky)
- 页头 `.aw-page-head` 窄屏纵向堆叠(修复 /daq「暂停全部采集」被压成竖排单字)
- antd Segmented 窄屏横扫 + 右缘渐隐;表格成「账页条」+ 首列钉住
- 粗指针触摸目标 ≥40px,命中区用伪元素外扩(不动视觉尺寸)
- 字号地板:语义级 `body small`(一次修 155 处)、壳层铭牌、`.aw-gauge-label` 等
- 侧栏三形态:`body.nav-drawer` 驱动 fixed 抽屉 + 遮罩 + 关闭态 `visibility:hidden`

**`app/composables/useResponsive.ts`(新增)** —— 全站唯一断点判据,SSR 安全,
并把档位镜像到 `<html data-vp-tier>` 供 E2E 断言。

### 1.2 壳层

- `AppSidebar`:窄屏改抽屉(汉堡开合 / 遮罩 / Esc / 路由跳转自动收 / body 滚动锁)
- `AppHeader`:窄屏撤掉航迹页签轨改为当前页标题,按信息优先级逐级卸载功能簇

### 1.3 修掉的两处真实水合缺陷(不是警告,是错位)

1. 侧栏 admin-only 条目在 SSR 少一条 → 客户端多一条 → 「插件管理/系统设置」的图标与文案
   整体错位一格(Vue 同时报 class 与 text mismatch)。用挂载后门控修好。
2. 顶栏 WS 状态点由客户端状态决定却在服务端渲染 → 节点类型不匹配。

### 1.4 页面级(14 个页面 + 7 个组件)

| 页面/组件 | 核心修复 |
|---|---|
| `daq/index.vue` | 控制条禁收缩 + 窄屏分层;报警条纵向堆叠;筛选区两列网格 |
| `DaqNodeRow.vue` | 节点行微字地板 + 语义级 small 兜底 |
| `dcw/index.vue` / `dcw/[id].vue` | 卡片单列;编辑/删除图标触屏常显(原 hover-only = 手机上不存在);节点表横扫 + 首列钉住 |
| `aml/index.vue` | 4 张主表包 .tbl-scroll + 诚实 min-width + 首列 sticky |
| `settings.vue` | 根因:窄屏堆叠规则被误写进 `prefers-reduced-motion:reduce`(只有 “减少动效” 的用户才看到正确布局)→ 改回宽度断点 |
| `logs/index.vue` | 7 列表格 → 窄屏「事件卡」三段堆叠(原被 overflow:hidden 裁掉 4 列) |
| `monitor.vue` | 空表时 antd 固定列被 980px 撑出视口的 sticky 修正 |
| 7 个管理页 | 页头堆叠、筛选条横扫、表格卷轴 + 身份列钉住、320px 硬下限移除 |
| `TownView.vue` | 三栏 → 单列;左右轨改底部抽屉页;坞可收起;26 处 8.5–9px 微字抬到 10px |
| `workshop/w/[wsId].vue` + 6 组件 | 四区并列 → 单通道示波器(一次一区);Composer 恒在底部;泳道/看板 snap 横滑 |

## 2. 关键根因(值得记下来的几条)

1. **窄屏「竖排字」永远不是字体问题,是 flex 收缩**:按钮被压到 min-content → 中文逐字换行。
   解法是 `flex:0 0 auto` + `white-space:nowrap`,不是调字号。
2. **布局规则不能写在动效媒体查询里**(`settings.vue` 的实际 bug)。
3. **第三方组件的伪元素是「有主」的**:antd 表格展开图标用 ::before/::after 画加减号,
   拿 ::after 去扩命中区会直接把图标画坏。
4. **量触摸目标要量变换后的盒子**:antd 给展开图标带 `transform:scale(.941)`,
   30px 的布局盒实际命中区只有 28.2px。
5. **渐变背景上的对比度算不出来**:绿青渐变 + 墨字被算成 1.06:1,真值是高分。审计必须豁免。
6. **亮色档的浅色品牌色当文字色必挂**:#35e0a0 在暖纸上 1.56:1。
   解法是 `color-mix(in srgb, 品牌色 42%, var(--ink))` —— 一处改动同时服务两套主题。

## 3. 产物

- README(中/英):hero + 6 段真实流程 GIF(图 01–06)+ 9 张界面截图 + 图例索引 + 告警块 + 贡献/安全/页脚
- 文档站首页(中/英):定位三连 + 真实数字带 + FIG 仪表框 + 响应式
- 可复用工具:`scripts/ui/{lib,shots,audit-layout,verify-responsive,verify-nav,record,readme-shots,readme-assets,shot-hero,seed-demo,md-lint}.mjs`
- `package.json` 新增 ui:* / readme:* 脚本

## 4. 复现

```bash
node bin/aw.mjs build && node bin/aw.mjs start --port 3021   # 起真实实例
node scripts/ui/seed-demo.mjs                                # 幂等:建示范工作区与频道
node scripts/ui/verify-responsive.mjs                        # 224 组合门禁(非 0 退出即失败)
node scripts/ui/verify-nav.mjs                               # 抽屉交互断言
node scripts/ui/readme-assets.mjs                            # 重建 README 全部素材
node scripts/ui/md-lint.mjs README.md README-zh.md           # README 结构自检
```

## 5. 已知残留(如实)

- 插件注入面板(`workshop-plugin-slot slot-name=“plugins.page”`)在 375px 下仍偏挤:
  那段 DOM 与样式由插件自己的 client bundle 产出,不在本次改动面内。
- 亮色主题是产品的次选主题(默认暗色);本次把它一并拉到达标,但主色绿比原先深了一档
  (混黑系数 0.36 → 0.46)—— 这是为 AA 付出的代价,已记入设计宪法。

---

## 6. 追加:逐页视觉评审(设计视角,2026-09-15 晚)

几何审计只能证明“没有溢出/达标”,证明不了“好看”。所以又做了一轮**逐页看图**评审:
16 个页面 × 桌面 1440 × 移动 390 × 暗色(共 32 张截图),逐张看过,记下视觉缺陷再修。

### 6.1 这一轮修掉的**纯视觉**问题(几何审计全部漏检)

| 位置 | 看到的问题 | 修法 |
|---|---|---|
| /workshop/agents 每行首列 | 展开图标被画成一个「表格边框坏掉」的大方块 | 见下 §6.2 —— 上一轮我自己引入的回归 |
| 全站顶栏 | 语言选择器被截成「简 体…」 | 窄屏标签改用 2 字符(ZH / EN)+ 选择器收窄 |
| /tokens 移动端 | 每行 76px、7 行吃掉三屏 | ≤640 把 antd 单元格内距从 16px 收到 10px |
| /monitor 移动端 | 4 张 KPI 卡单列,每张 ~150px | 前三张两列 + 「服务进程」(长字符串)跨两列 |
| /monitor 桌面端 | 「服务进程」卡只有 1/4 宽,ISO 时间折成三行 | 该卡跨两列(列宽按内容长度分,不按数量均分) |
| /workshop 移动端 | 文字链居中、主按钮靠右,两行不同对齐轴 | 窄屏整组左对齐 + 按钮满行 |
| /aml 顶栏标题 | 显示成「Aml」—— 路由没登记进 meta 表,落到 slug 兜底 | 补登记 /aml |
| /aml 前置条件横幅 | 三角图标停在第二行行首,像走错位置 | 改顶端对齐 + 多行用面板圆角 |
| /aml 页头 | 徽标被压成一列三行、描述也被挤成两行 | 页头允许换行,放不下就整组落到第二行 |
| /logs 移动端 | 6 个筛选下拉单列占满一屏 | 两列网格 + 关键词/按钮跨列 |
| /agents 桌面端可见性列 | 「私有」在 tag 与开关里各写一遍 | 开关去掉文字,语义交给 tag |
| /teams 桌面端卡片头 | 「部署」用 text 按钮,与旁边的 owner 文本长得一样 | 改 outlined,让唯一主操作看得出来 |
| 全站表格 | 16 行 × 2 个红色文字按钮同时在喊 | 恢复设计语言里的「行内操作渐显」(仅鼠标语境) |
| /dashboard 引擎卡 | 14 张卡里 9 张把命令名写了两遍 | 标签已含命令名时不再重复渲染 |
| /settings 移动端 | 版本铭牌被拉伸成整行空药丸 | `width: fit-content`

### 6.2 一条值得单独记的教训:改第三方图标的**盒子**会毁掉它的**图形**

上一轮为了让 antd 表格展开图标的触摸目标达标,我给它加了
`width: 34px !important; height: 34px !important`。
几何审计通过了(命中区 32px),但视觉上它坏了:antd 的 +/− 是用**固定像素偏移**画的
(`::before{top:7px;left:3px}`、`::after{left:7px;…}`),这些偏移按 17px 的盒子调过;
盒子一变大,横竖线的交汇点就跑到左上角,每行首列看起来像「表格边框坏了」。

**正确做法是等比缩放**:antd 本来就给这个图标加了 `transform: scale(.941176)`,
把它覆盖成 `scale(1.8)` —— 图形与偏移一起放大,永不跑位,命中区同时从 16px 变成 30.6px。

普适性:凡是用伪元素 + 固定偏移绘制图形的组件,都只能缩放、不能改盒。

### 6.3 顺带修掉的一个环境级缺陷(不是前端问题,但会伪装成前端问题)

评审期间生产实例崩溃,日志里是:

```
could not resize shared memory segment /PostgreSQL.…: No space left on device
```

这句话看起来像「磁盘满了」,实际是 **Docker 给容器的 /dev/shm 只有 64MB**,而 PostgreSQL 的并行查询
会按需扩容共享内存段 —— 宿主机当时还剩 230GB。已在 `docker-compose.yml` 的 `daq-timescale`
上显式声明 `shm_size: 512mb`(Postgres 官方镜像文档的建议做法),重建容器后错误消失。

### 6.4 评审期间修掉的两个**真实功能缺陷**(它们伪装成“前端加载慢”)

逐页看图的副产品:发现 /town 有时能出 3D、有时只出空态,而且生产实例会**静默退出**。查下去是两个真 bug:

**缺陷 1 — 服务端读取 localStorage,直接把进程打挂(fatal)。**

日志里只有一行:

```
[stability-guard] fatal unhandledRejection, exiting:
ReferenceError: localStorage is not defined
    at saveActiveMap (.../workspaces-BuydxM-3.mjs:30:2)
    at Proxy.load (.../workspaces-BuydxM-3.mjs:64:4)
```

`app/stores/workshop/workspaces.ts` 的 `load()` → `saveActiveMap()` 直接写 `localStorage`,
而这个 action 完全可能被服务端调用。项目里其它 store(`app/stores/app.ts`)是显式带 `import.meta.client`
守卫的,这一个漏了。已按同一约定补齐:持久化层自己保证 SSR 安全,调用方不必先判断环境。

**缺陷 2 — /town 的认证闸门与会话恢复竞态。**

原实现在 `onMounted` 里同步判 `userStore.isLoggedIn`,而 session-restore 插件是异步的:
刷新 /town 时已登录用户会被误弹回 /workshop。更麻烦的是它**看起来是通过的** ——
弹到 /workshop 后那边的顶栏照样把 `data-vp-tier` 写上,自动化验收就把 /town 记成“通过”,
而用户看到的其实是工作台。现改为与 /workshop 总览页**完全一致**的顺序:
`watch(isLoggedIn) → await userStore.refresh() → await wsStore.load()`,并显式挡掉 SSR 分支。

> 这两个缺陷都说明同一件事:**几何量测和截图都可能“通过”一个坏掉的页面**。
> 前者因为跳转后的页面同样满足判据,后者因为空态本身不溢出、不失衡。
> 逐页看图 + 追日志,才是这一轮真正的价值。

### 6.5 本轮终验

| 项目 | 结果 |
|---|---|
| 全站视口矩阵(7 视口 × 16 页面 × 明暗双主题 = 224 组合) | **224 通过 / 0 失败** |
| 抽屉导航交互 | **10 通过 / 0 失败** |
| eslint(app/server/shared/cli/sdk/i18n/scripts/ui) | 0 error(18 warning 为既有) |
| README 结构自检(中英) | 全部通过 |
| VitePress 构建 | 0 error |
| 16 条路由 HTTP | 全部 200 |
