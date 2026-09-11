# UI 视觉评审(harsh pass)

- 目标:`http://127.0.0.1:3111`(生产构建,1680×1050 / 1280×800,Edge 152 headless,`--force-device-scale-factor=1`)
- 取证目录:`.e2e-shots/design-review/`(242 个文件:94 张 PNG 截图 + 131 张路由过渡真帧 + 10 个只读探针脚本 `capture.mjs` / `probe{,2,3,4,5,6,7,8,9}.mjs` + 7 份原始测量数据 `measurements.json` / `probe{,2,3,4,5,6,7}.json`)
- 已存在基线:`.e2e-shots/design/`(20 张亮/暗静态页)
- 评审模型:`huashu-design/references/critique-guide.md`(概念为第 0 关,执行 5 维)
- 本次**只读** `app/**`、`server/**`,未改动任何产品代码。

---

## 0. 总评 + 5 维度打分(0-10,并说明扣分点)

**总评:5.4 / 10 —「需改进」**。这不是"再打磨一下"的 8 分作品。它有一套**真的从内容里长出来的视觉母题**(Instrument Bench:品牌刻线、量规刻度、mono 读数、墨色药丸),但 v4「Instrument Glass」这一层**在生产构建里根本没有运行**,加上**所有趋势可视化在种子数据下都是空的**,再叠一层**系统性低对比度**,把"控制室"讲成了"很精致的静态样张"。

| 维度 | 分数 | 扣分点(每条都有证据) |
|---|---|---|
| **哲学一致性** | **6.5** | 暖编辑部 + 仪表台的语汇高度自洽,墨色药丸确是全站唯一 CTA,语义色只表状态。但:①v4 的玻璃振动层**运行时为 0**(见 §1),即"哲学里写了的材质在成品里不存在";②`main.css:1445` 全局 `:focus-visible { border-radius: 1px }` 把药丸 CTA 在键盘聚焦瞬间压成方角,直接违反自家「形状锁:CTAs 药丸」;③侧栏 hover 用 `--tone-success-bg`(#eaf7ef 薄荷,一个语义成功色)当**中性 hover 底**,违反自家「彩色只表语义状态」。 |
| **视觉层级** | **5.5** | h1 36px / 正文 12.5px = 2.9×,字阶比例达标。但落点错了:`/` 首屏 252px hero + 84px KPI 带 + 135px 执行引擎面板,把唯一的实时图表挤到 **y=587(视口 56% 处)**,而它是空的;`/daq` 的节点表在 1680 起于 **y=748**,在 1280×800 起于 **y=842** → **首屏 0 行数据**(`probe2.json fold.visibleRowsAtFold = 0`)。视线先落在 kicker/徽标/chip 云上,而不是传感器值。 |
| **细节执行** | **4.5** | 12 列节点表行高 **54.75px = 字号 4.38×**(`probe.json density.ratio`);`趋势` 列宽 128px × 6 行全为空(`polyline points=""`);hero 正文把"一屏尽 / 览,"拆出一个**孤字收行**;大量 10px 中文标签、8.5px `logo-sub`;`--ink-fainter` 在约 30 处元素上只有 2.75:1;聚焦时按钮圆角被全局规则改形。 |
| **功能性** | **4.5** | 产品承诺是"实时值 / 趋势 / 执行器状态"。实际:**每一个趋势面都是空的**(仪表盘 934×342 空图区 + 6 行空 sparkline),且**没有任何空态文案**告诉操作员是"产线没开跑"还是"图表坏了";`添加节点` 浮层既不能 Esc 关闭、也**盖不住侧栏**(对话框开着还能点侧栏跳走);1280×800 上主表 100% 在折叠线以下。得分靠 KPI 量规带、采集控制条、实时事件流这几处真正好用的仪表组件撑住。 |
| **创新性** | **6.0** | 34px 品牌刻线、量规刻度尺、注册角标、"单位比读数低一档"的 mono 读数、`Agent 优化记录` 折叠条、事件流——是**内容推导出来的**语言,不是模板套皮,这部分值 8 分。扣分:柔粉极光背景是 AI-SaaS 最烂大街的一个母题(且此处还是死的);玻璃三档直接借 macOS `NSVisualEffectView` 词汇贴在产线控制室上;"执行引擎"整片 chip 云里一半是 `暂无源 / 未安装`,读起来就是通用 AI 平台的装饰。 |

> 概念关(未计入 5 维):Instrument Bench 是真 idea,给 **7.0**,不触发 ≤5 封顶规则,所以总评按 5 维均值 **5.4** 计。

---

## 1. 玻璃材质是否成立(逐项判定 + 证据)

### 判定一:❌ **不成立。v4 的 `backdrop-filter` 振动层在生产构建里完全没有运行。**

不是"看不清",是**一次都没生效**。三重证据:

**(a) 构建产物里,所有手写的 `backdrop-filter` 只剩 `-webkit-` 前缀版本**

```
entry.DWpOvSJS.css   : unprefixed=1(unocss 的 --un-backdrop-*)  webkit=18
default.BbqhPkzQ.css : unprefixed=0                            webkit=3
daq.Bb6l44-O.css     : 只有硬编码的 .modal-mask{backdrop-filter:blur(2px)} 保留了无前缀版本
```
`--vibrancy-chrome` / `--vibrancy-float` / `--glass-blur` / `--frost-blur` / `--aurora-blur` 这些**变量驱动的声明全部只剩 `-webkit-backdrop-filter`**。

**(b) 该前缀在本机 Chromium 上不被支持**

```
CSS.supports('backdrop-filter','blur(10px)')        → true
CSS.supports('-webkit-backdrop-filter','blur(10px)') → false      ← Edge/152.0.0.0
inline backdrop-filter:blur(10px) saturate(1.9)…     → 生效
inline -webkit-backdrop-filter:blur(10px)…           → 计算值 none
```

**(c) 运行时计算值全是 `none`**

| 选择器 | 声明值(CSS) | 计算值 |
|---|---|---|
| `.app-sider` | `var(--vibrancy-chrome)` = `blur(30px) saturate(1.9) brightness(1.06)` | **none** |
| `.app-header` | 同上 | **none** |
| `.app-footer` | 同上 | **none** |
| `.modal`(`/daq` 添加节点) | `var(--aurora-blur)` = `blur(22px) saturate(1.1)` | **none** |
| `.ant-dropdown-menu`(顶栏用户菜单) | `var(--vibrancy-float)` | **none** |

**后果**:全站**没有任何一处模糊/提饱和/提亮**。面板档(`.aw-bench` / `.aw-gauge-band`)按设计本来就不付 backdrop 成本,所以等于"三档材质阶梯"只剩**一档半**——壳层与面板的差别仅剩 62%/84% 的不透明度差。

**附带 bug**:`daq/index.vue:1696`、`logs/index.vue:542/559/623` 写成 `blur(var(--aurora-blur)) saturate(1.15)`,而 `--aurora-blur` 本身已经是 `blur(22px) saturate(1.1)` → 展开为 `blur(blur(22px) saturate(1.1)) saturate(1.15)`,**即便前缀修好也仍是非法值**。

### 判定二:❌ **看不见极光透出壳层——不是因为没有极光,是因为玻璃底太实。**

先证明极光层真的画了东西:把壳层 `background/backdrop-filter` 全部强制置空后截图,侧栏背后是一道清楚的**蜜桃→薄荷渐变**:
- `.e2e-shots/design-review/probe5-sider-light-normal.png`(正常,一片均匀 `#fafaf6`)
- `.e2e-shots/design-review/probe5-sider-light-noglass.png`(去掉玻璃底,极光可见)

再证明它被玻璃底抹平了(逐像素):

| 区域 | 取样 | 结果 |
|---|---|---|
| 顶栏空白区 480×44px | `probe5.json flat-light.headerEmpty` | **3 个 6-bit 色簇**,RGB 跨度 **[2,1,1]**,mode 占比 0.718 |
| 顶栏空白区(暗) | `flat-dark.headerEmpty` | **4 个色簇**,跨度 **[1,5,4]**,mode 0.912 |
| 侧栏空白区 180×560px | `flat-light.siderEmptyGap` | mode 占比 **0.964**(96.4% 像素是同一个颜色) |
| 极光层本身(藏掉整个 app) | `aurora-light.auroraRange` | `#e9f0eb → #f6f4f2`,跨度仅 **[13,4,7]** |
| 同上(暗) | `aurora-dark.auroraRange` | `#04070f → #0d262b`,跨度 [9,31,28] |

把壳层透明前后的同一像素对比(`probe.json aurora.*.points`):侧栏 (120,160) `#f9f9f7` → 去玻璃 `#eff3ee`,**差 10/255**;顶栏 (500,40) 暗色 `#152135` → `#0a1b23`,**差 18/255**。

**结论**:极光本身只有 ~5% 的强度,再被 `--mat-chrome-bg: color-mix(#fffefc 62%, transparent)`(暗色 46%)压掉大半 → 合成后是**一个平色**。肉眼与逐像素都测不出"背后有东西在流动"。`light-00-dashboard-idle.png` 与 `light-04-probe-chrome-transparent.png` 并排几乎无法区分。

### 判定三:⚠️ **面板档有"厚度",浮层档没有。**

`.aw-bench` 的 `box-shadow` 计算值确实带了物理三件套里的两件:
```
inset 0 1px 0 rgba(255,255,255,0.52)   ← 顶部镜面高光
inset 0 -1px 0 rgba(12,10,9,0.05)      ← 底部环境遮蔽
```
这是全站唯一真正"有厚度"的一层,**记一功**(KPI 量规带上缘那道亮边在 `probe5-kpiband-light.png` 里能看出来)。

但浮层 `.modal` 只用了一件:
```
.modal box-shadow: inset 0 1px 0 rgba(255,255,255,0.45),
                   0 8px 28px rgba(12,10,9,0.12)
```
**没有底部遮蔽**(它用的是 `--glass-edge` 而不是 `--glass-specular`)。按项目自己的规范原话——「只有高光没有遮蔽 = 塑料片」——`添加节点` 弹窗就是一张塑料片。

暗色实测更糟(`probe6-edge-modal-dark.png` + `probe6.json modal-edge-gradient`,沿弹窗上缘逐像素):
```
y=406 #04080e   ← 遮罩底
y=407 #1d2e46   ← 1px 边框
y=408 #242933   ← 1px "镜面高光"
y=409 #0b111b   ← 弹窗内部
```
弹窗内部比遮罩底只亮 **约 7/255**,1px 的高光在 2× 缩放下等于不存在;`.modal` 的 `backdrop-filter` 又是 `none`,所以**暗色浮层读起来就是一个带描边的洞,不是压在上面的玻璃板**。

### 判定四:⚠️ **顶栏用户菜单的 float 材质被覆盖掉了。**

`probe6.json dropdown-light` 实测 `.ant-dropdown-menu`:
```
background-color : rgba(0,0,0,0)        ← 期望 var(--mat-float-bg)
backdrop-filter  : none
border-top-color : rgb(12,10,9)         ← 是一根近黑实线,不是 --glass-line(ink 10%)
box-shadow       : none                 ← 期望 var(--shadow-lift-2)
```
v4 给 `.ant-dropdown-menu` 写的那条 `background: var(--mat-float-bg) !important` 没有赢。截图 `probe6-userdropdown-light.png` 里菜单是一张**无投影、硬描边**的白卡。

### 判定五:✅/❌ 逐问回答

| 问题 | 判定 | 证据 |
|---|---|---|
| 能透过侧栏/顶栏看到极光吗? | **不能** | 顶栏 480×44 只有 3 个色簇、跨度 [2,1,1];去玻璃前后差 ≤10/255 |
| 有可见的顶部镜面高光吗? | **面板有,浮层几乎没有** | `.aw-bench` inset white 0.52 ✅;`.modal` 高光实测 1px 且暗色下 `#242933` vs 底 `#04080e` |
| 有材质厚度感吗? | **面板有,壳层没有** | 壳层只有单一平色,没有遮蔽/渐变,`backdrop-filter:none` |
| 暗色玻璃读起来像玻璃还是平海军蓝? | **平海军蓝** | 侧栏 `#0a0e1a`(有玻璃)vs `#060a16`(无玻璃),差 4/255;`dark-04-probe-chrome-transparent.png` 与 `dark-00-dashboard-idle.png` 肉眼同图 |

---

## 2. 对比度实测(表格:选择器 / 实测比值 / 是否达标)

方法:遍历视口内所有含直接文本的元素,取 `getComputedStyle().color` 作为**规格前景色**;背景取该元素外接矩形内截图像素的**众数色**(4-bit 桶)。阈值按 WCAG AA:正文 4.5:1,≥24px 或 ≥18.66px+bold 为 3:1。

### 2.1 亮色主题(`/` 97 条文字,15 条未达 AA)

| 选择器 | 字号 | 实测前景 / 背景 | 比值 | 需 | 判定 |
|---|---|---|---|---|---|
| `span.aw-gauge-label`(运行产线/控制节点/数采通道/累计采集样本/写命令成功率/活跃告警 **全部 6 个 KPI 标签**) | 10px | `#a29a90` / `#fefefa` | **2.75** | 4.5 | ❌ |
| `p.aw-bench-kicker`(hero `DIGITAL TWIN · 产线运营 · DEV`) | 10px | `#a29a90` / `#fefefa` | **2.75** | 4.5 | ❌ |
| `small.aw-bench-sub`(面板副标题、"按节点量程归一化 · 近 3 分钟") | 11px | `#a29a90` / `#fefefa` | **2.75** | 4.5 | ❌ |
| `span`(量程占比 % / `/14` / `/1 运行产线` / `失败 0`) | 10px | `#a29a90` / `#fefefa` | **2.75** | 4.5 | ❌ |
| `.app-footer .sep` | 10px | `#a29a90` / `#fefefa` | **2.75** | 4.5 | ❌ |
| `span.live-badge`(`LIVE`) | 10px | `rgb(76,143,99)` / `#fefefa` | **3.83** | 4.5 | ❌ |
| `/daq` `span.st-pill.idle`(`未运行`) | 10.5px | — / `#eeeeee` | **2.17** | 4.5 | ❌ 最差 |
| `/daq` `small.lp-idle`(`待机`) | 10.5px | — / `#eeeae6` | **2.32** | 4.5 | ❌ |
| `/daq` `.filter-bar` 标签(产线/绑定设备/产线运行/节点状态/模板/驱动/数据时间) | 10px | `#a29a90` / `#fefefa` | **2.75** | 4.5 | ❌ |
| `/daq` `span.run-pill`(`未运行`) | 10.5px | — / `#fefefa` | **2.75** | 4.5 | ❌ |
| `/daq` `span.strip-label`(`产线状态`) | 10.5px | — / `#fefefa` | **2.75** | 4.5 | ❌ |
| `/daq` 告警条 `span.txt` | 12.5px | — / `#faf2de` | **3.30** | 4.5 | ❌ |
| `/daq` `span.src-badge.user`(`用户`) | 10px | — / `#fefefa` | **3.83** | 4.5 | ❌ |
| `span.menu-item` 非激活项 | 12px | `#4b463f` / `#fafaf6` | 8.99 | 4.5 | ✅ |
| `h1`(hero) | 36px | `#0c0a09` / `#fffefc` | 20.4 | 3.0 | ✅ |
| 表格 `th` | 12.5px | `#0c0a09` / `#eeeae6` | 16.45 | 4.5 | ✅ |

### 2.2 暗色主题(`/` 96 条,15 条未达 AA)

| 选择器 | 字号 | 实测前景 / 背景 | 比值 | 需 | 判定 |
|---|---|---|---|---|---|
| `span.aw-gauge-label`(6 个 KPI 标签) | 10px | `#5f6e84` / `#0a121e` | **3.62** | 4.5 | ❌ |
| `p.aw-bench-kicker` | 10px | `#5f6e84` / `#0e1622` | **3.50** | 4.5 | ❌ |
| `small.aw-bench-sub` | 11px | `#5f6e84` / `#0a121e` | **3.62** | 4.5 | ❌ |
| `/daq` `span.st-pill.idle` | 10.5px | — / `#1a222e` | **3.49** | 4.5 | ❌ |
| `/daq` `.filter-bar` 标签 ×7 | 10px | `#5f6e84` / `#0a121a` | **3.63** | 4.5 | ❌ |
| `/daq` `small.lp-idle` / `span.run-pill` | 10.5px | — | **3.62 / 3.71** | 4.5 | ❌ |
| `span.menu-item`(侧栏 `--sider-ink #b9c6d8`) | 12px | `#b9c6d8` / `#0a121e` | 9.6 | 4.5 | ✅ |
| 激活航迹 chip(`)`--on-accent` on `--accent`) | 12px | `#08130d` / `rgb(63,228,171)` | 9.2 | 4.5 | ✅ |
| 顶栏 `span.logo-sub` | 8.5px | `#7b8ca3` / `#0e1a26` | 5.13 | 4.5 | ✅(但 8.5px 本身不可接受) |

### 2.3 结论:根因是**两个"淡墨"档的用法**

- `--ink-faint`:`#6f6860`(亮,5.00–5.45) / `#8fa0b5`(暗,7.0) → **两档都过 AA**,可以用。
- `--ink-fainter`:`#a29a90`(亮,**2.53–2.75**) / `#5f6e84`(暗,**3.50–3.63**) → **在任何字号下都不可能过 AA**(要过 4.5:1 亮色得 ≥ 约 34px)。
- **而全站的微标签档(KPI 标签、面板副标题、kicker、过滤条字段名、状态胶囊、页脚分隔符)几乎全部挂在 `--ink-fainter` 上**——这是 §5 里最"便宜也最致命"的一条。
- 另有 10px 中文标签遍地:10px 中文在 100% 缩放下笔画已经糊在一起,叠上 2.75:1,等于操作员**看不到标签**。

---

## 3. 层级与密度

### 3.1 `/`(仪表盘):眼睛落不到数据上

首屏几何(1680×1050,视口高 1050,`probe2.json dash-geometry` + `probe5.json geo-light`):

| 块 | 位置 / 尺寸 | 判定 |
|---|---|---|
| 顶栏 | y 0–56 | — |
| **hero**(`虚实映射的产线 运营中枢`) | y=74,**1408×252** | 内容只有 1 行 36px 标题 + 2 行 12px 说明 + 2 个药丸;`heroRegion` 单色占比 **0.753**。252px 换 5 行字,首屏 24% 高度花在"刊头"上 |
| KPI 量规带 | y=340,1408×84 | ✅ 全站最优秀的一块 |
| 执行引擎 chip 云 | y=424,1408×135 | 14 个 chip,其中 `暂无源`/`未安装` 占近半;信息价值低却占据第二屏位置 |
| **实时工况趋势(唯一实时图)** | y=**587**,934×342 | 视口 56% 处才开始,而且**是空的**(见 §5-2) |
| 产线运行状态环 | y=587,460×342 | 一张大环 + `0/1` + 两行图例,大量留白 |
| 页脚 | y 1004–1050 | — |

**问题**:①实时趋势不是 hero,刊头是 hero;②hero 的两个 CTA(`进入数字孪生` 墨色实心 / `产线运营管理` outline)权重接近、并列,首页没有唯一主动作;③hero 正文换行把"一屏尽 / 览,"拆出**孤字收行**(`probe5-hero-light.png` 可数);④右侧 `LIVE / 运行产线 / 累计采集样本 / 活跃告警` 小卡与 hero 内容垂直不对齐(卡高 ~150px,hero 252px),下半截是空的。

**空图区是不是真缺陷?是,而且是本次评审最严重的一条之一:**
- 取样区域 (160,590)–(1110,940):**单一颜色占 91.1%**(`probe.json dash-plot-pixels.plotRegion.modalShare = 0.911`,只有 93 个不同色簇)。
- 面板有完整坐标系(y `0/20/40/60/80/100`)、4 条图例(`鏌张力·44pua / 出口压力·44pua / 表面相机·44pua / 产线速度·44pua`)、右上角 "量程占比 %",**没有任何数据序列**。
- X 轴刻度是 `00:00:00 06:00:00 12:00:00 18:00:00` **重复了两遍**,而面板副标题写的是"近 3 分钟"——刻度与语义不符,操作员会把 `00:00:00` 读成真实时刻。
- **没有空态文案**。看不出是"产线未开跑"还是"图表坏了"。
- 证据:`light-dashboard.png` / `dark-dashboard.png` / `probe5-plot-light.png`。

### 3.2 `/daq`(数采中心):主表被埋在折叠线以下

| 量 | 实测 |
|---|---|
| 节点表 `thead` 上沿(1680×1050) | **y=748** |
| 节点表上沿(1280×800) | **y=842** → `probe2.json fold.visibleRowsAtFold = 0`,`tableTop = 842 > viewportH 800` |
| 表格卡片总高 | **647px** |
| 行高 | **54.75px** × 6 行(`.nodes-table td` padding 9px,line-height 18.75px) |
| 行高 / 字号 | **4.38×**(字号 12.5px) |

**行内实际内容**(`probe.json density.cells`,12 列):
```
209px dn-c0b53 炉温测温·44pua / 温度传感器    ← 唯一用满两行的列
 81px 未运行        100px 168.7 ℃      144px 趋势(空)
 77px 1000ms         76px 每帧           71px mock
151px 未分配 / 热轧一线·44pua   95px 未运行   112px --   98px 未绑定   193px 停止采集|控制台
```
→ **12 列里只有 2 列需要两行,行高却按两行给足**;表头 35px + 6 行 × 54.75 = 364px,放进 647px 的卡片里。**每行浪费约 18px**,6 行约 110px——正好是一行半数据。对于"实时值/趋势/状态"这种要一眼扫过的表,行高该按内容密度给,不是按最长的那一列给。

**中列空死区**:第 4 列 `趋势` 宽 128px(`.trend-cell{width:128px}`),SVG 容器 120×26,**6 行 × 2 主题全部 `polyline[points=""]` 长度 0**(`probe9.mjs` 实测)。它就在扫描路径正中间,占了 144px 宽却什么都不画。

**1280×800 的额外问题**(`light-31-daq-1280.png`):过滤条折成两行后,`6 / 6 节点` 这个计数**单独掉到第三行左侧**,与上方字段名不对齐,读起来像一个孤儿标签。

### 3.3 `/dcw`(产线运营):四分之三屏是空的

- `.app-content` 高 936px、宽 1420px,`innerText` 总长 **258 字符**。
- 首屏只有:一张产线卡(`热轧一线 · 44pua`,含节点/产品/配方计数 + 一个下拉 + 一个 outline 药丸)和一张虚线 `+ 新建产线` 占位卡,然后右侧与下方**整片留白**(`light-dcw.png`)。
- 作为一个"产线运营"入口,首屏既没有产线列表的规模感,也没有任何汇总/对比信息。这不是留白引导视线,是**没有内容**。

### 3.4 `/aml`(建模平台):内容整体掉到折叠线以下 + 主题回退

`probe2.json` 实测(同一浏览器会话内):

| 进入方式 | `html.className` | 根 layout class | `.page` top | `document.scrollHeight` |
|---|---|---|---|---|
| 冷启动直接开 `/aml`(dark) | `dark` | `ant-layout ant-layout-has-sider` | **70** | 1255 |
| 先开 light 再切 dark 到 `/aml` | **`""`** | `ant-layout`(**缺 `ant-layout-has-sider`**) | **1120** | **2100** |
| 再进 `/aml`(light) | `""` | 同上 | **1120** | 2100 |

两个独立缺陷:
1. **布局塌陷**:非冷启动进入 `/aml`,`ant-layout-has-sider` 丢失,`.app-content` 被推到 y=1118,`.page` 起于 y=1120 → **整页内容在 1050px 视口里完全不可见**,文档高 2100px,上半屏是一整块空白。这正是随包交付的 `dark-aml.png` 看起来是"空白页"的原因。
2. **暗色主题回退**:`localStorage.app = {"isDark":true}`、cookie `aw-theme=dark` 都在,但 `html` 上没有 `dark` 类,`body` 背景计算值是 `rgb(246,244,241)`(暖纸白)。**只有冷启动那一次会正确进入暗色**。

证据:`probe2-aml-from-light.png`、`probe-aml-dark.png`、`probe2-aml-light.png`、`.e2e-shots/design/dark-aml.png`(空白)。
**对照**:`light-aml.png`(随包交付的亮色版)是**正常**的——五个面板、空态文案、顶部 badge 行都在。也就是说 AML 本身没问题,**问题只出在"非冷启动 + 暗色"这条组合路径**上,这也把缺陷范围收窄到布局 sider 探测与主题水合两处。

顺带一提:AML 的五个面板都规规矩矩写了空态("暂无数据集 —— 从产线历史批次构建对齐快照后即可提交训练。"),说明 `pane-empty` 这套空态是现成可用的——**§5-2 里两块趋势面没有空态,不是没有能力,是漏了**。

### 3.5 反 AI-slop 判定(slop 清单)

这套语言有真母题,所以它**不是**整片模板套皮;但下面 7 处读起来仍然是"通用 AI 产品"而不是"这间产线控制室":

| # | slop 项 | 为什么是 slop | 证据 |
|---|---|---|---|
| 1 | **整页柔粉极光光斑**(peach/mint/lavender/sky radial) | AI-SaaS 落地页最烂大街的一张皮;**而且此处它是死的**——被 62% 玻璃底压成不可见。即"没换来氛围,也没换来材质",只换来 3 层合成 + `aurora-drift 46s` 无限动画 | `probe5-sider-light-normal.png` vs `-noglass.png`;`flat-light.headerEmpty` 跨度 [2,1,1] |
| 2 | **"执行引擎" chip 云** | 14 个等高胶囊里近半在说"我没有"(`暂无源` / `未安装` / `in-process`),外加右上 `12 / 14` 计数。通用"能力矩阵"装饰,读不出任何可执行信息 | `light-dashboard.png` y=424 那块 1408×135 |
| 3 | **`LIVE` 脉动徽标** | 绿点 + 大写 mono `LIVE`,10px/3.83:1。AI 产品默认配饰,且与 #2 的 `暂无源` 同时出现——一边宣告"实时"一边承认一半不可用,两个装饰互相拆台 | `span.live-badge`,§2.1 |
| 4 | **8.5px / 0.2em uppercase 微字** | "极小字距大写字母 = 高级感"是模板化排版套路;`AGENTWORKSHOP / DIGITAL TWIN`(8.5px)、`AGENTWORKSHOP / DAQ CONSOLE`、`控制台/运维/系统`(9.5px)。8.5px 已低于可读下限 | `logo-sub` / `menu-group-text` / `aw-kicker` |
| 5 | **hero 右上"数据小卡"** | 4 行里 3 行是 `0` 或 `96`,信息量撑不起一张常驻卡;且与 hero 内容垂直不对齐,下半截 100px 是空的——"先排版后填内容"的痕迹 | §3.1;`probe5-hero-light.png` |
| 6 | **`UV · uv 0.12.13 (be0dbd274 2026-08-18 x86_64-pc-windows-msvc)`** | 把构建 hash + triple 当常驻 badge 铺进界面,一行 mono 几乎顶到右缘 | `light-aml.png`;§5-21 |
| 7 | **`产线运行状态` 大环** | 460×342 的面板画一个环 + `0/1` + 两行图例,单一数字用整块面板承载 | `dark-dashboard.png` / `light-dashboard.png` |

**对照(不算 slop,是真母题)**:34px 品牌刻线、量规刻度尺、mono 读数且单位降一档、`Agent 优化记录` 折叠条、行内 sparkline 的容器设计、事件流的 `时间 · 用户 · 动作` 三列节奏。这些是从"这是一间产线控制室"推出来的,换个主题就不成立——**第 1 条如果修好(极光真的透出来),它会从 slop 变成母题的一部分;修不好就干脆删掉。**

---

## 4. 动效

### 4.1 ✅ 按压物理:做得对,而且是可测量的

```
.aw-pill:active  → transform: matrix(0.972, 0, 0, 0.972, 0, 0)
transition       → transform 0.32s cubic-bezier(0.34,1.56,0.64,1),
                   box-shadow 0.2s, background 0.12s, border-color 0.12s
```
`60ms` 压下 + `320ms` 弹簧回弹,幅度 2.8%——这是"控件有物理"的正确量级,保留。
hover:`.aw-pill` `#292524 → #0c0a09`(墨色加深),`.menu-item` 有底色变化,`tr:hover` `rgba(12,10,9,0.043)`。都真实生效(`probe2.json row-hover`)。**注意行 hover 只有 4.3% 的底色,没有 elevation**,在密集表里偏弱。

### 4.2 ❌ 路由过渡:前半段是"死点击",中间是 136ms 空白,整体 ~700ms

用 CDP `Page.startScreencast` 抓真帧(不是靠 `sleep` 猜),以"点击时刻"为 0 点,按帧字节量判定画面变化:

```
−380ms … +346ms   42.9 KB 稳定不变   ← 点击后 346ms 内画面零变化
       +354ms      38.4 KB
       +358ms      34.8 KB
       +372ms      28.9 KB
       +380ms      24.7 KB
       +390ms      13.2 KB
       +399…460ms  10.4–10.5 KB  ─────── ← 内容区全空,持续约 136ms
       +527…537ms  11.6 KB
       +539ms      19.6 KB            ← 新页开始进场
       +686ms      21.3 KB            ← 稳定
```
配对 `MutationObserver` 的类名时序(两次独立测量):
```
light: 168ms page-fade-leave-active → 189ms leave-to → 334ms enter-active+enter-to
dark : 134ms page-fade-leave-active → 163ms leave-to → 292ms enter-active+enter-to
```

**中间那一帧是真的全空**:`probe6-trans-72-399ms.jpg` 显示此时只剩侧栏、顶栏航迹(已切到 `系统设置`)和页脚,**`.app-content` 完全空白**。

判定:
- **前 134–168ms 无任何反馈** → 用户会以为点空了,可能重复点击。
- **leave 只有 21–29ms**(CSS 写的是 80ms),≈ 硬切。
- **~136ms 的内容区空洞** → 这是最难看的一段:页面"闪白/闪空"。
- enter 理论 180ms,实测到 686ms 才稳定。
- CSS 注释说这是"macOS 窗口式的连续性"、"幅度极小、可感知但不抢戏"。**实测与注释描述不符**:不是连续性,是"卡一下 → 空一下 → 淡进来"。
- 另外 `.aw-readout.is-tick` 的读数提亮微动效在本次走查中没有触发到(种子数据下读数不变),未能验证。

### 4.3 ⚠️ 全局焦点动效是破坏性的

```css
/* main.css:1442 */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 1px; }
```
`:focus-visible`(0,1,0)与 `.aw-pill`(0,1,0)同特异度,但位置更靠后 → **赢**。实测:

| 元素 | 未聚焦圆角 | 聚焦圆角 | outline |
|---|---|---|---|
| `button.aw-pill.running`(`暂停全部采集`) | 9999px | **1px** | `rgb(41,37,36) solid 2px` |
| `button.aw-pill.outline.add-btn`(`模板管理`) | 9999px | **1px** | 同上 |
| `button.aw-pill.add-btn`(`添加节点`) | 9999px | **1px** | 同上 |

即**键盘用户每 Tab 到一个墨色药丸 CTA,它就从药丸变成方角矩形**,然后 Tab 走又变回药丸。这不是"细节",这是形状语言的当场自毁。

同时:
- **主 CTA 的焦点环不可见**:`.aw-pill` 底色 `rgb(41,37,36)`,聚焦 outline 也是 `rgb(41,37,36)`,只 offset 1px。黑环套黑药丸。
- **`a.line-pill` 完全没有焦点指示**:实测 `outline: none 0px`,tab 序列第 1 站就是它(`/daq` 的产线选择器),键盘用户在这里彻底迷路。
- 暗色下 outline 是 `rgb(63,228,171)`(品牌绿),可接受。

### 4.4 其他

- `@view-transition { navigation: auto }` 只对跨文档导航生效,SPA 路由不会触发;实际生效的是 Vue 的 `page-fade`(见 4.2 时序),两者不冲突但前者是死代码。
- `prefers-reduced-motion` / `prefers-reduced-transparency` 的收敛分支都写了,方向正确。
- 整站无横向滚动条:`docSW === docCW` 在 10 组(页面 × 视口)全部成立,`hOverflow` 为空。

---

## 5. 布局缺陷清单(按严重程度)

### ⚠️致命

1. **v4 Instrument Glass 振动层在生产构建里不生效。**
   所有变量驱动的 `backdrop-filter` 只以 `-webkit-` 前缀形式产出(`default.BbqhPkzQ.css` unprefixed=0 / webkit=3;`entry.DWpOvSJS.css` 18 处 webkit,唯一 1 处无前缀属于 unocss 工具类);本机 `CSS.supports('-webkit-backdrop-filter','blur(10px)') === false`;`.app-sider` / `.app-header` / `.app-footer` / `.modal` / `.ant-dropdown-menu` 计算值全为 `none`。
   修:删掉源码里的 `-webkit-backdrop-filter` 行(或把构建 target 配成不需要 webkit 前缀),一次性恢复整层;另修 `blur(var(--aurora-blur))` 的嵌套 bug(`daq/index.vue:1696`、`logs/index.vue:542/559/623`)。

2. **所有趋势可视化都是空的,且没有空态。**
   仪表盘 `实时工况趋势` 934×342:取样区单色占比 **91.1%**,坐标系 + 图例 + "量程占比 %" 齐全,**0 条序列**,X 轴 `00:00:00…18:00:00` 在"近 3 分钟"标题下**重复两遍**。节点表 `趋势` 列 128px × 6 行 × 2 主题:`polyline[points=""]` 长度全为 0。
   对一个"看实时值与趋势"的控制室,这是核心承诺未兑现。
   修:先给这两个面加**明确空态**(如"产线未开跑 · 无历史样本"),再让 `n.hist` 真的喂进 `trendPath`;X 轴刻度必须由窗口(近 3 分钟)推导,不能写死 24 小时制。
   **注意**:空态组件是现成的——`light-aml.png` 里五个 AML 面板都用了 `pane-empty`("暂无数据集 —— …"),文案规范、居中、serif 都不缺。趋势面漏的只是调用。

3. **`/aml` 非冷启动进入时整页掉到折叠线以下,并丢失暗色主题。**
   `ant-layout-has-sider` 丢失 → `.page` top=1120、`docH=2100`,1050px 视口里完全看不到内容;同一次加载 `html.className=""` 而 `localStorage.app.isDark=true` + `aw-theme=dark` 都在,`body` 背景是 `rgb(246,244,241)`。
   证据:`probe2.json aml-from-light` / `aml-light`、`probe2-aml-from-light.png`、随包交付的 `dark-aml.png`(空白页)。

### ⚡重要

4. **`--ink-fainter` 系统性不达 AA**:亮 `#a29a90` **2.75:1**、暗 `#5f6e84` **3.50–3.63:1**,覆盖 6 个 KPI 标签、所有面板副标题、kicker、`/daq` 七个过滤字段名、`未运行/待机` 状态胶囊(`/daq` 亮色最低 **2.17:1**)、`LIVE`/`用户` 徽标。字号还普遍是 10px。

5. **模态不是模态:遮罩盖不住侧栏,点击可穿透导航。**
   DOM 层叠:`.app-main{position:relative;z-index:1}` 是 `.app-sider{position:sticky;z-index:20}` 的**兄弟**;`.modal-mask{z-index:50}` 在 `.app-main` 的层叠上下文内部,所以整体低于侧栏。
   实测:`document.elementFromPoint(120,500).className === "menu-item im"`(不是 `modal-mask`);遮罩 rect 是 `0,0,1680,1050` 但没盖住。**弹窗开着点侧栏"系统设置"→ `location.pathname` 变成 `/settings`**。
   证据:`probe.json modal-stack`、`probe-modal-nav-clickthrough.png`、`light-13-modal-open.png`(侧栏未变暗、内容区已变暗,一眼可见断层)。

6. **`添加节点` 弹窗无法用 Esc 关闭,也没有关闭按钮。**
   干净测试:`openBefore=true` → `keyboard.press('Escape')` → 500ms 后 `modalStillOpen=true`。源码 `daq/index.vue` 内无任何 `Escape`/`keydown` 处理。焦点也没有 trap(第一次 Tab 会落到弹窗背后的 `a.line-pill`)。

7. **路由过渡:346ms 无反馈 + 136ms 内容全空 + 总计 ~700ms。** 见 §4.2 字节序列与 `probe6-trans-72-399ms.jpg`。

8. **`/daq` 主表在 1280×800 上 100% 在折叠线以下**(表头 y=842 > 视口高 800,可见行 0);1680×1050 上也要滚到 y=748 才见到第一批数据。首屏被 hero 说明、告警条、采集控制条、Agent 优化记录 + 实时事件全部占满。

9. **键盘焦点破坏形状语言 + 焦点环两处失效**:`:focus-visible{border-radius:1px}` 把药丸 CTA 压成方角;墨色药丸的焦点环与自身底色同色(不可见);`a.line-pill` 的 `outline: none`(无指示器)。

10. **节点表行高按最长列给,浪费约 110px**:54.75px/行 = 字号 4.38×,12 列里只有 2 列占两行;中间还有一个 128px 宽、`points=""` 的空 `趋势` 列。

### 💡优化

11. **hero 正文 CJK 孤字收行**:"…越限告警一屏尽 / 览,孪生界面与真实 PLC 同拍运行。"(`probe5-hero-light.png`)。`text-wrap: pretty` 对中文无效,需要限制 `max-width` 到整字宽度或用 `<wbr>`/手动断行。
12. **hero 高 252px 只装 5 行字**,单色占比 0.753;两个 CTA 权重接近、并列,首页无唯一主动作。
13. **`/dcw` 75% 面积空置**:内容高 936px / 宽 1420px,总文本 258 字符,只有两张小卡贴左上。
14. **浮层缺少底部遮蔽**:`.modal` 的 `box-shadow` 只有一个 inset(顶部 0.45 白),没有 `--glass-specular` 的第二条遮蔽;暗色下弹窗内部 `#0b111b` vs 遮罩底 `#04080e` 只差 7/255,暗色浮层没有"抬起来"。
15. **顶栏用户菜单材质被覆盖**:`.ant-dropdown-menu` 计算值 `background: rgba(0,0,0,0)`、`border-top-color: rgb(12,10,9)`(硬黑描边)、`box-shadow: none`。
16. **8.5–9.5px 的 chrome 文字**:`logo-sub`(8.5px/0.2em)、`user-role`(8.5px)、`menu-group-text`(9.5px)。对比度达标也读不清。
17. **语义色被当中性 hover 用**:侧栏 `.menu-item:hover` 实测底色 `rgb(234,247,239)` = `--tone-success-bg`(成功色),违反项目自己的色彩锁。
18. **行 hover 只有 4.3% 底色、无投影**,密集表里定位感弱(`rgba(12,10,9,0.043)` / 暗色 `rgba(232,238,248,0.04)`)。
19. **34 条 `Hydration completed but contains mismatches`** 控制台错误(随包 `MANIFEST.md` 与本次采样一致);这是 `/aml` 主题/布局异常最可能的来源。
20. `.aw-stagger` 的延迟在 `nth-child(n+13)` 之后全部压成 276ms,15 项以上列表的后半段会同时进入,阶梯节奏断掉。
21. **`/aml` 顶部 badge 行把机器串直接铺进界面**:`UV · uv 0.12.13 (be0dbd274 2026-08-18 x86_64-pc-windows-msvc)` 一行 mono 文本几乎顶到内容区右缘(`light-aml.png`)。这类 hash + triple 属于日志,不该作为常驻 badge;应截断为 `uv 0.12.13` + `title` 放全串。

---

## 6. Keep / Fix / Quick Wins

### Keep(这几处别动)

- **KPI 量规带** (`aw-gauge-band`,1408×84):底部量规刻度尺 + 34px 品牌刻线 + mono 读数(单位降一档),是整套语言里最"控件感"的一块。`probe5-kpiband-light.png`。
- **按压物理**:`.aw-pill:active → scale(0.972)`,60ms 压下 / 320ms 弹簧回弹,量级正确。
- **面板材质两件套**:`.aw-bench` 的 `inset 0 1px 0 rgba(255,255,255,.52)` + `inset 0 -1px 0 rgba(12,10,9,.05)`,是全站唯一真正有厚度的表面。壳层只要把不透明度降下来,同一套物理立刻能读出来。
- **色彩纪律**:全站唯一 CTA = 墨色药丸,无霓虹、无 emoji、无紫渐变;tone 色只表状态。激活航迹 chip 暗色下是 `#08130d` on `rgb(63,228,171)`(9.2:1)。
- **`prefers-reduced-motion` / `prefers-reduced-transparency` 两条降级分支都写了**,并且真的落地为 `backdrop-filter:none` + 实色回退。
- **零横向溢出**:12 组(页面 × 视口,含 `/`、`/daq`、`/dcw`、`/aml` × 亮暗 × 1680/1280)全部 `docScrollWidth === docClientWidth`,且 `hOverflow` 与文字截断列表均为空。

### Fix(按上面的严重度顺序)

1. 修构建前缀 → 恢复玻璃振动层;顺手修 `blur(var(--aurora-blur))` 嵌套。
2. 把 `--mat-chrome-bg` 从 `62%` 降到 **40–44%**(暗色 `46%` → `30–34%`),让测量到的那道蜜桃→薄荷极光真的透出来。
3. 趋势面:补空态文案 + 让 `hist` 真的进 `trendPath` + X 轴刻度由窗口推导。
4. `/aml`:修 `ant-layout-has-sider` 丢失;把主题类改成不依赖冷启动(SSR/水合一致)。
5. `--ink-fainter` 两档整体上移到 `--ink-faint` 的值(见 Quick Win 3)。
6. 模态:把 `.modal-mask` 提到 `body` 级 teleport,或把 `.app-sider` 降到 `.app-main` 之下;补 Esc + 关闭按钮 + 焦点 trap。
7. 路由过渡:把 leave 从 80ms 提到 ~160ms 并**去掉中间的空档**(让 enter 与 leave 交叠,不要让内容区归零),或者把 `NuxtPage` 的等待改成预取后同步切换。
8. 行高按内容给:`.nodes-table td{padding:6px 12px}`,目标行高 **38–42px**(现在 54.75px)。
9. `:focus-visible`:删掉 `border-radius:1px`;给墨色药丸用 `outline-color: var(--paper-raised)` + `outline-offset: 2px`;给 `.line-pill` 补回可见焦点环。

### Quick Wins(如果只有 5 分钟,做这 3 件)

- [ ] **删掉所有 `-webkit-backdrop-filter:` 行**(或把构建 target 提到不需要 webkit 前缀),一次提交恢复全站玻璃振动层。
      `app/**` 下共 **40 处**(`main.css` 17、`pages/daq/index.vue` 10、`TownView.vue` 7、`town.vue` 2、`AppHeader/AppSidebar/CommandPalette/default.vue` 各 1);这些 `-webkit-` 行必须**删掉而不是保留**,因为同值双写正是构建把它合并成前缀版的成因。修完立刻可验证:`.app-sider` 的 `getComputedStyle().backdropFilter` 应从 `none` 变成 `blur(30px) saturate(1.9) brightness(1.06)`。
- [ ] **`main.css:1445` 删掉 `border-radius: 1px;`**,并把 `:focus-visible` 的 outline 色改成与墨色药丸有对比的值(`--paper-raised` 或 `--accent` 在亮色下改 `#7a746c`)。
      一行删除 + 一行改色,直接消掉"键盘一聚焦药丸就变方"和"主 CTA 焦点环不可见"两条。
- [ ] **把 `--ink-fainter` 收敛到 `--ink-faint`**:亮 `#a29a90 → #6f6860`(2.75:1 → 5.45:1),暗 `#5f6e84 → #8fa0b5`(3.62:1 → 7.00:1)。
      两行 token 改动,一次性修掉 §2 表里 **约 30 条未达 AA 的记录**(6 个 KPI 标签、全部面板副标题、`/daq` 七个过滤字段名、状态胶囊、`LIVE`/`用户` 徽标、页脚分隔符)。

**最伤的三条(一句话版):**
1. **v4 的玻璃层在成品里根本没跑**——变量驱动的 `backdrop-filter` 全部只剩不被 Edge 152 支持的 `-webkit-` 前缀,壳层/浮层计算值均为 `none`,顶栏 480×44px 只有 3 个颜色。
2. **所有趋势面都是空的**——仪表盘 934×342 图区单色占比 91.1%、6 行 sparkline 的 `polyline points=""`,且没有任何空态文案。
3. **`--ink-fainter` 把约 30 处微标签压到 2.75:1 / 3.6:1**——包括全部 6 个 KPI 标签和 `/daq` 的 `未运行` 状态(最低 2.17:1)。
