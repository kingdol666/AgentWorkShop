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
