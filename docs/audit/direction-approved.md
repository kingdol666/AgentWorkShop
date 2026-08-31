# Direction Approved · huashu-design 美化轮(2026-08-31)

## 豁免依据(huashu-design「唯一豁免」第 2 条)

本任务为**已选定方向后的迭代**:项目视觉方向早已由用户选定并落档——
「Town design constitution」(夜航仪原则 + 控制室配色 绿主 #35e0a0 / 数据青 #41c8f4 / 深海军蓝,
令牌以 TownView.vue 为准)+ 全站 Warm Editorial / Aurora Glass 设计系统
(用户在 2026-08-30 Aurora Glass 轮验收通过)。本轮不产生新视觉方向,故不重过三方向门。

依据原文:用户指令「根据这个skill设计理念和哲学,去对我当前的项目包括数字孪生场景页的UI/UX进行美化」
——是**对既有方向的美化迭代**,不是新视觉设计。

## 本轮应用的设计哲学(huashu-design)

- 系统优先,不要填充:消灭「趋势分析」57 路 chip 墙(容量溢出 = 数据 slop 呈现)
- 一次 well-orchestrated page load:/town HUD 上电 Boot 序列(左轨→右轨→底部坞)
- 诚实呈现:健康环语义保持(中心绿=健康率,环=状态构成);gauge 35% 经核实为动画瞬时态,非 bug
- 反 slop:重复文案降噪(dcw 卡墙兜底提示);不新增装饰
- 一个细节做到 120%:/town 上电序列即本轮签名细节

## 改动清单

1. TownView 趋势卡:头部通道计数徽标 + chip 区两行封顶受控滚动(画布高度恒定)
2. TownView HUD boot 进场编排(CSS only,reduced-motion 收敛)
3. TownView i18n 漏网修复(「下发 write」按钮 / 保存布局 title,zh+en)
4. dcw 卡墙兜底提示降透明度
