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
