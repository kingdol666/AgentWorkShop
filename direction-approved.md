# Design Direction · 已选定方向的深化迭代（豁免记录）

## 方向来源

本项目 UI 设计方向为 **「Warm Editorial」**（暖纸白画布 + 暖近黑油墨 + 粉彩光斑氛围 +
EB Garamond 衬线展示 / Geist 正文 / IBM Plex Mono 数据 + 墨色药丸唯一主动作），
该方向为用户在此前迭代中确认并固化的设计宪法：

- 记忆档 `town-design-constitution.md`（控制室配色宪法 + 轨式布局）与 `ui-design-preferences.md`
  （用户审美：极简工业、厌恶装饰堆砌与 AI 味、每轮截图目视验证）。
- 仓库 `app/assets/css/main.css` 头部设计系统注释（Warm Editorial 完整规范）。

## 本次任务定性

用户指令「依据 huashu-design / animate 规范美化项目 UI」属 **同一项目内、既有已确认方向上的
深化迭代**（改稿/加动效/统一系统），命中 huashu-design「唯一豁免」第二条：
**已选定方向后的迭代不重新过三方向门**。本文件即豁免落档。

## 本次深化范围（依据艺术家评审 agent 的基线评审）

1. 图表色板归位（--chart-1..5 暖纸同类色序，替换 ECharts 默认荧光绿）
2. 表格系统细化（tabular-nums / 行内操作渐显 / 行过渡）
3. 空态组件（.aw-empty 细线+衬线，拒绝大块剪影）
4. 页眉归队（tokens/permissions/plugins/logs 四页补 .aw-kicker 眉题）
5. 动效补全（animate 规范：.aw-live-dot 呼吸点 / .aw-liftable 卡片抬升 / stagger 扩到 12 子项 /
   全部带 prefers-reduced-motion 与 hover gating）
6. 数据清洗（测试期 GBK 坏字节实体名 → 正确 UTF-8）
7. line-sentinel 插件徽标融入 Warm Editorial（去深色浮丸/emoji）

## 2026-09-11 · 「Instrument Glass」材质层 + 实时链路算法优化(方向内深化迭代)

- **定性**:用户指令「根据 huashu-design 设计需求…在当前的基础上做美化渲染,满足现代优秀项目的前端
  风格,有毛玻璃的 MacOS 应用的高级质感,以及好看的过渡动画;做完后启动一个 Agent 截图查看确保
  真正符合审美要求」= 既有 Warm Editorial / 控制室宪法内的**同一项目改稿**,命中豁免第二条
  (已选定方向后的迭代)。用户原话「在当前的基础上」即为直接执行授权,不重新过三方向门。
- **视觉母题推导(form 来自内容的哪里)**:产品是产线控制室,屏上每块面板都是仪表 →
  玻璃不是"iOS 磨砂贴纸",而是**仪表玻璃罩**:壳层=观察窗(看得见背后极光在流动)、
  面板=有厚度的玻璃板(顶缘镜面高光 + 底缘环境遮蔽 + 发丝折射边)、浮层=压在台面上的玻璃板。
  与既有 aw-bench / 量程刻度 / 读数码同源,不是新贴一层装饰。
- **三条纪律**:① 振动 = 模糊 + 提饱和 + 提亮(只 blur 不 saturate 会发灰发脏);
  ② 玻璃要有物理(只有高光无遮蔽 = 塑料片,只有模糊无边缘 = 糊);
  ③ **backdrop-filter 只给壳层与浮层** —— 面板数量多×面积大,逐个付模糊成本会拖垮滚动,
  改用半透底 + 折射边拿到同一观感(刻意的性能取舍,并由 glass-verify 断言面板确实没有 backdrop)。
- **落地**:
  1. `main.css` v4 段:三级材质令牌(chrome/panel/float)+ 振动 + 镜面/遮蔽 + 分层投影 +
     弹簧缓动 + 按压反馈(--press-scale 0.972)+ 路由过渡 v2(scale+fade,刻意不做整页 blur)。
  2. 壳层接材质:侧栏 / 顶栏 / 页脚统一走 `--mat-chrome-bg` + `--vibrancy-chrome` + `--glass-specular`;
     浮层(modal/drawer/dropdown/popover/tooltip)接 `--mat-float-bg` + 分层投影。
- **独立评审 Agent(harsh pass)**:产出 `docs/audit/design-review-ui.md`(433 行)+
  `.e2e-shots/design-review/`(242 文件:94 PNG、131 路由过渡真帧、10 个只读探针、7 份测量 JSON)。
  总评 5.4/10「需改进」,并给出**逐条硬证据**——其中三条最关键:
  ① **v4 玻璃层在生产构建里根本没跑**:变量驱动的 backdrop-filter 在产物中只剩 `-webkit-` 前缀版,
     而该前缀在 Chromium/Edge 152 已不受支持(实测 `CSS.supports('-webkit-backdrop-filter')===false`,
     计算值恒为 none)→ 整层玻璃失效。
  ② 所有趋势面为空且无空态(坐标系+图例齐全、0 序列,X 轴回落到 00:00~24:00)。
  ③ `--ink-fainter` 系统性不达 AA(亮 2.53:1 / 暗 3.37:1),覆盖约 85 处微标签。
- **修复(每条均实测复验,见 `scripts/_audit/review-fix-verify.mjs` 20/0)**:
  1. 清除全部 41 处手工 `-webkit-backdrop-filter`(压缩器会折叠成只剩前缀版)→
     `scripts/_audit/glass-verify.mjs` 因果判定:开/关玻璃的渲染差异 Δ亮度 **17.68(亮)/ 3.73(暗)**,
     计算值 `blur(30px) saturate(1.9) brightness(1.06)`。
  2. 材质不透明度按实测反推(亮 62%→44%、暗 46%→32%)——不改就"等于白做"。
  3. `--ink-fainter` **取消文字资格**(压深后仍撞 --ink-faint):67 处文本用法收敛到 `--ink-faint`,
     令牌保留为纯装饰;`--focus-ring` 独立成对(亮 5.78:1 / 暗 8.68:1)。
  4. 焦点环去掉 `border-radius: 1px`(与 .aw-pill 同特异度且更靠后 → 聚焦时药丸被压成方角)。
  5. 模态回到根层叠上下文(`.app-main` 曾 `z-index:1` 自成上下文,遮罩关在里面盖不住侧栏,
     弹窗开着能点侧栏跳走)+ 新增 `esc-close.client.ts`(按 `@click.self` 契约统一 Esc 关闭)。
  6. **布局骨架自持**:`.app-layout` 曾间歇性拿不到 antd 的 `display:flex`(计算值 block),
     aside(100vh)与主区变块级堆叠 → 内容被推到 y=1050,整页掉到折叠线以下。
     骨架的 display/flex-direction 改为在布局层显式声明,不再依赖 cssinjs 注入时机。
  7. 趋势空态判据从"缓冲有没有点"改为"有没有**数值**"(采样由活动批次门控,未开跑时只有 null 占位),
     并给出说明文案;节点表 sparkline 无样本时画待数据基线而非空 polyline。
- **算法与架构优化**(独立审计 `docs/audit/audit-realtime-perf.md`,P0×2 + P1×8):
  - `DaqController.frames()` **O(n²) → O(n)**:原实现对每个 pending 行再全扫一遍 frameBuffer
    (缓冲满时单次 REST ≈4×10⁶ 次迭代 + 2000 次多余对象构造,且与 250ms 采样 sweep 同事件循环)。
    改为按节点分桶 + (nodeId,tsMs) 索引,所有 push/淘汰/flush 收敛到三个私有方法保索引一致。
  - 事件环**增量索引**:lane 曾每帧对整条 ring(≤5000)各过滤一遍(O(L×R),L=8/R=2000/30fps
    ≈4.8×10⁵ 次谓词/秒,且随会话时长线性劣化)。新增 `byAgent` 增量桶 + 时间线增量缓存,
    每帧降到 O(新增帧数)。
    ⚠️ 增量游标必须用 **seq** 而非数组下标 —— ring 满后 push+淘汰使 length 恒定而元素左移,
    用下标会静默漏掉每个新帧(由新增的等价性属性测试 `test-events-index.mjs` 抓出)。
  - `AwChart` 改 `notMerge:false + replaceMerge:['series'] + lazyUpdate`,消除"每次读数合批就整图重建"。
  - JSON 落盘按规模自动选择缩进(大库紧凑):回退账本实测体积 -32%、CPU -43%(23.2ms→13.2ms)。
  - 删除 4 处死代码(`DaqNodeRuntime.republish` / `markAllOffline` / `onlineCount` /
    DAQ repo 的 `flushDebounced` ——后者还导致"读数 5s 防抖落盘"的注释与实现不符)。
- **验收**:`glass-verify` 全绿;`review-fix-verify` 20/0;`contrast-check` 全达标;
  `e2e-full-closedloop` **124/0**;`e2e-aml --real` 0 失败;离线套件
  (lru/data-root/log-flooding/rollback-index/plugin-hardening/memory-month-query/cli-exit/
  events-index)全绿;eslint 0 error。
- **已知遗留(未修,如实记录)**:`/dcw` 与 `/settings` 仍有 1 条水合告警(纯客户端状态的
  文本差异,Vue 会自行修补,不影响布局;同一 bug 类中**影响布局**的那条已修);
  `/daq` 主表在 1280×800 上仍在折叠线以下(信息密度重构,未在本次范围)。

## 2026-09-10 · 「校准仪表台 / Instrument Bench」全站视觉深化(方向内深化迭代)

- **定性**:用户指令「依据 huashu-design 规范美化项目 UI/UX 与整体布局」= 既有 Warm Editorial /
  控制室宪法内的**同一项目改稿**,命中 huashu-design「唯一豁免」第二条(已选定方向后的迭代),
  不重新过三方向门。用户原话:「根据你的最好的审美帮我把当前的项目 UI/UX、用户交互和整体的布局
  做一个优化」——即直接执行授权。
- **视觉母题推导(form 来自内容的哪里)**:这不是风格标签,是产品本身——它是一间产线控制室,
  屏上每块面板都是仪表。由此长出全站唯一重复出现的签名:**量程刻度尺**(分节即分档)、
  **读数码**(tabular-nums、单位降一档)、**注册角标**(四角 L 形,只给 hero 与主仪表)。
  与既有 --hud-* / hero-scale 同源,不是新贴一层装饰。
- **落地**:
  1. `main.css` v3 段:aw-rule / aw-bench(面板统一形态:上缘 34px 品牌短线 + 内缘折光)/
     aw-bench--marked(注册角标)/ aw-readout / aw-gauge-band + aw-gauge(统计带)/
     aw-row(设置行)/ 页头量程线;亮色画布由冷中性 `#f5f5f5` 归位为真正的暖纸 `#f6f4f1`
     (与暖油墨同族),--ink-faint 压深到 4.7:1 达标;暗阶补上亮下暗画布渐变、收敛极光、
     量规令牌独立一档。
  2. 侧栏:12 条平铺 → 控制台 / 运维 / 系统 三组(空组自动折叠),mono 分组标 + 收尾刻度线,
     激活态改左缘品牌刻度 + 悬停横向微推;底部铭牌加刻度收边。
  3. 仪表盘:KPI 六张散卡 → 一块量规统计带(发丝线分格 + 底部量程刻度 + 告警左标);
     面板头统一为「衬线题 + mono 元信息」;图表色序改为**主题双声部**(亮=暖纸编辑色板,
     暗=控制室 tone 系统);实况簇改刻度行;轴名移入面板头 meta(原本压在刻度数字上)。
  4. 全局:空态撤掉 antd 默认插画换「一道细线 + 一句」;message 下移到页头之下(top 70px);
     修 ECharts GraphicComponent 未注册(冷启动文案静默丢失)。
- **交互修复(非视觉)**:
  - 主题本地偏好被服务端 `theme.mode` 每次刷新冲掉 → 新增 `themeTouched` 显式选择位;
  - 服务端渲浅色 / 客户端首帧翻深色导致 antd cssinjs 不重注入(深色下筛选器塌成竖排单选框,
    实测复现)→ 用 `aw-theme` cookie 做 SSR 只读镜像,首帧算法两侧一致。
- **目检验收**:生产构建(`aw build` + `aw start --port 3021`)下 Playwright 全站 16 页 ×
  亮/暗双主题截图,.e2e-shots/audit/;页面错误 0;设计师视角逐屏审阅通过。

## 2026-09-09 · VitePress 首页 Hero 落地页(方向内深化迭代)

- **定性**:docs/site 首页重设计 = 既有「控制室/工程规格书」视觉宪法(--hud-*/--aw-* 令牌,
  轨式+刻度+FIG 面板母题,绿只做信号色)内的深化迭代,命中豁免第二条;用户指令
  「优化并推送部署」为直接执行授权。
- **视觉母题推导**:产品即一条数据管线(驱动→队列→TSDB→WS→Agent/孪生)——Hero 主视觉
  就是这条真实管线(FIG.00 轨式示意图 + 信号脉冲),不是装饰插画;数字带全部为可验证实数
  (5 协议/4 入口/6 引擎/73 设置项/156 断言)。
- **落地**:hw-* 组件族(hero/管线轨/数据带/分节/架构原理图/设计思路/能力网格/场景/定位框/
  终端 CTA),双语 zh+en;修复 vp-doc h2 border-top 短线、markdown 空行后 4 空格缩进断裂、
  页脚双语重复。
- **目检验收**:.e2e-shots/zh-hero-final.png 等 6 屏,设计师视角逐屏审阅通过。
