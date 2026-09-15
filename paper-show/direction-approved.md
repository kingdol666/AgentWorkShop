# direction-approved.md — paper-show 设计方向档案

## 任务原话（用户）
「请你给我查看当前的系统，告诉我我当前这个项目是否能够发表论文，以及能够发表在哪个期刊上面，论文的整体写作框架和写作逻辑以及排版布局如何。先完整阅读探索当前的项目……给我一个完整的当前系统的流程图，用合理的方式展现出来 [$huashu-design] 基于这个skill把项目的整体架构和设计做成好看的流程图，创建出来HTML的详细项目介绍，并告诉我可以发表在什么期刊，最推荐哪个期刊，有没有相似的文章？给我具体完整的在HTML讲解清楚，用落地页slide的形式展示出来，做成一个show，要有好的设计感！」

## 方向决策（自主会话降级记录）
- **用户明确要求单一交付物**：一个「落地页 slide 形式」的 HTML show（含流程图 + 论文可行性 + 期刊推荐 + 相似文章 + 写作框架），未要求多方向选稿。
- **已有明确 design context**：项目自身的「控制室暗阶」设计宪法（`app/assets/css/main.css` html.dark 段 + TownView.vue 令牌）——深海军蓝 surface 阶梯 + 绿主 #3fe4ab + 数据青 #41c8f4 + 刻度/轨道/信号灯母题。设计从该真实语境生长，不套风格库。
- **假设清单**（替代检查点问答，自主会话）：
  1. 受众 = 学术审稿人 / 导师 / 同行（论文决策场景），中文为主、术语中英混排。
  2. 形态 = 单文件 HTML（双击可开），9 页 1920×1080 全屏 section，纵向 scroll-snap + 键盘导航 + 轨道式页码。
  3. 真实产品截图（docs/readme-assets/*.png）PIL 降采样后 base64 内嵌，交付物挪目录不裂图。
  4. 期刊影响因子具体小数因 Scopus/JCR 页面 JS 加载无法抓取，正文只写经验区间并标注「投稿前以官方为准」；已验证事实 = CiI 的 Aims & Scope 原文、ISSN、JIII scope、arXiv 论文标题/编号（WebFetch/curl 实抓）。
  5. 期刊影响因子具体小数因 Scopus/JCR 页面 JS 加载无法抓取，正文只写经验区间并标注「投稿前以官方为准」；已验证事实 = CiI 的 Aims & Scope 原文、ISSN、JIII scope、arXiv 论文标题/编号（WebFetch/curl 实抓）。

## 设计令牌（单一来源 = app/assets/css/main.css html.dark 段）
- paper #070b13 / paper-raised #0d1420 / paper-deep #0a111d / paper-tint #152034
- line #1d2a42 / line-strong #2c4568
- accent #3fe4ab (on-accent #08130d) / 数据青 #41c8f4 / 琥珀 #f6c453 / 告警 #ff8080
- ink #e8eef8 / ink-soft #b9c6d8 / ink-faint #8fa0b5 / ink-fainter #5f6e84
- 母题：刻度标尺（tick ruler）· 轨道（rail）· 信号灯（status dot）· 等宽字数据
