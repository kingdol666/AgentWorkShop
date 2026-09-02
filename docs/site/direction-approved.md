# direction-approved · 文档站控制室主题(2026-09-02)

## 方向来源与豁免依据(huashu-design 三方向门)

本次任务为**已选定方向后的迭代**(Fallback「唯一豁免」第 2 种):站点骨架与信息架构已于 e2ad551 交付,
本次为在其上做设计深化,且视觉方向**直接沿用项目已获用户批准的设计宪法**:

- `docs/audit/direction-approved.md`(2026-09-01,用户已批):控制室配色
  绿主 `#35e0a0` / 数据青 `#41c8f4` / 深海军蓝,轨式布局,刻度母题,令牌以 TownView.vue 为准。
- 用户记忆共识:极简工业、厌恶装饰堆砌与 AI 味。
- 本会话为 autonomous 模式(无人值守),三方向摆盘需停轮等选,与交付时限冲突;
  故以「已批准方向 + 真实品牌资产」为唯一诠释执行,不新开方向。

## form 推导五问

1. **叙事角色**:首页 = 控制室主入口(hero);文档页 = 仪表面板(阅读为主)。
2. **观众距离**:1m 笔记本 → 正文 16px/1.75,标签 ≥12px,正文对比度 ≥4.5:1。
3. **视觉温度**:冷静、权威、工业精密。绿只做信号色(链接/激活/状态),不做大面积渐变、无霓虹 glow。
4. **容量**:hero(文字+真实截图) → 刻度尺 → 6 feature(铭牌标签) → 全宽真实截图带 → 安装命令 → 状态带页脚。
5. **视觉母题**:**轨式 + 刻度**(产线控制台独有):侧栏轨道线、hero 下刻度尺分隔、设备铭牌式等宽大写标签
   (PKG/CLI/SDK/PLG/IND/TWN)、底部状态灯带(承载真实信息:协议/运行时/协议状态)。

## 资产清单(全部真实资产,零 SVG 手画)

- `public/favicon.svg` ← `public/favicon.svg`(AwLogo 同源,绿→青渐变六边形)
- hero 图 `public/town.png` ← `docs/readme-assets/town.png`(数字孪生控制室实拍截图)
- 展示带 `public/line-ops.png` ← `docs/readme-assets/dcw.png`(产线运营实拍截图)
- 弃用:`docs/readme-assets/dashboard.png`(实为 404 废图)

## 令牌(TownView.vue 1:1)

`--hud-bg #070b13 / panel #0d1420 / panel-2 #111a2b / raised #152034 /
line #1d2a42 / line-hi #2c4568 / text #e8eef8 / dim #8fa0b5 / faint #5f6e84 /
accent #35e0a0 / accent-dim #1f9e6e / cyan #41c8f4 / amber #f6c453 / danger #ff6b6b`
