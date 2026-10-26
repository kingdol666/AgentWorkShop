# 宣传演示视频制作报告（2026-10-26，英文界面版）

## 任务与约束

用户要求：把演示视频的界面语言切换为英文、重新实机录制；约 3 分钟、过渡顺滑、功能讲解完整；完成后嵌入 README、放入 VitePress，并提供可独立在线播放的外链；最后合并分支到 main、推送部署并发布。

## 采用能力

- Skill 路由：`video-agent-kit:video-edit-agent` → `video-edit-assembly`（多素材组装 + 旁白 + 字幕）。
- 录制：CDP `Page.startScreencast`（Puppeteer + 本机 Chrome），1920×1080、30fps、浅色主题（localStorage `app` 持久态 `isDark:false`）。
- 英文界面：录制会话使用 `aw.locale=en` cookie + localStorage，并用 API 会话 token 写入 `token` cookie，避免登录门与认证面限流；所有页面 `html lang="en"`。
- 语音：Edge 神经语音 `en-US-AndrewNeural`，-4% 语速（`edge-tts` 7.2.8）。
- 混音：逐句合成 → 绝对时间 adelay 对齐 → `loudnorm=I=-16` 单轨；无音乐。
- 字幕：ASS 烧录（英文主文 + 中文次行 + 两侧独立深色底框）+ 外挂 en/zh-Hans `.srt/.vtt`（20 条，逐句校对）。
- 转场：`xfade=fade` 0.5s × 10；静态页面用持续光标移动补帧，避免末帧冻结。
- QC：ffprobe 时长/分辨率/音轨覆盖；抽帧与接触表目视检查；字幕对齐以 cue 表为准。

## 成片

- 文件：`docs/site/public/demo/agentworkshop-core-demo.mp4`
- 时长 **180.49 s（3:00）**，1920×1080 @30fps，H.264 CRF21（yuv420p）+ AAC 192k，约 13 MB，`+faststart`。
- 分幕：标题卡 → 控制室仪表盘（实时趋势）→ DAQ 实时遥测（6 节点全英文表）→ **EDA 分析管道**（CSV 导入 40 行 → 代码过滤 35 行 → 配置 → 图表 → 在线查看器 → 存模板）→ **受治理工具目录**（125 工具、角色/可用性检索）→ 已发布本体（概览/实体/规则/绑定/版本/编译预览）→ **四个 Agent 工作区** → 插件面（11 装载）→ 分析台账详情（受治理写入核验）→ EDA 工坊（散点图）→ 结尾卡。
- 20 条双语字幕；英文旁白 128.33 s 语音 + 呼吸留白。

## 素材真实性

- 全部为真实实机界面录屏，非合成 UI。录制实例为全新隔离 home（`D:/tmp/aw-video/home-en`）：目标线 `Injection Molding · Line A`（8 DCW + 6 DAQ，mock 驱动 + 自定义信号模板）、产品与配方 `Standard window v3`、已发布本体 v1（5 实体/4 关系/2 条已批准规则，内容哈希发布）、4 个 EDA 图表 + 2 个模板 + 看板、4 个工作区/8 个频道（mock Agent 团队）、6 条英文分析报告。
- DAQ 遥测由 mock 驱动按 1 Hz 生成（自定义模板 base/amp 与量程匹配）；产线以配方开跑，写控走平台受治理路径（mock 设备回执）。**未连接真实 PLC，未向真实设备写入**。
- 分析报告与本体为演示用种子数据，用于展示界面、台账与工作流；不声称是本次录制中新产生的实验结论。
- 片中"受治理写入核验"详情页与工具目录展示的是平台真实读取的台账/注册表字段。

## 本轮发现并修复的产品缺陷

1. **EDA 管道页标题键冲突**：`studio.pipeline.title` 在 i18n 对象内被图表标题 `title` 覆盖，页面 h1 显示 "Title"。改为 `chartTitle` 并同步中英文。
2. **在线查看器图表高度为 0**：`AwChart` 的 `height` 经 `$attrs` 落到 DOM 属性而非 CSS，Teleport 外壳内 chart 容器高度 0。`AwChart` 增加 `height` prop 并写入内联样式；查看器与主图均恢复 420/380 px。
3. **英文界面本体基线残留中文**：下拉项硬编码 `基线 v{n}`，接入 `ontology.graph.baseline`。

## 已知取舍（如实记录）

1. 服务端 `ops_log` 摘要仍为中文；成片未展示 `/operations` 明细，改用全英文的工具目录页承载"受治理动作"叙事。
2. 插件页的结果库未启用提示、串口厂商字段仍含少量中文（插件/OS 数据级文案）；插件卡片主体为英文。
3. 仪表盘实时趋势只保留页面打开后的窗口（约 20 s），不是完整 24 h 历史；成片用 20 s 预热让曲线可见。
4. 机器人点击与滚动由 CDP 脚本编排，非人工操作；页面数值来自运行实例。
5. GitHub README 不支持内联 `<video>`，采用"可点击封面 → 独立播放页"的方式；VitePress 页面内嵌 `<video>` 播放器。

## 交付清单

| 文件 | 说明 |
| --- | --- |
| `docs/site/public/demo/agentworkshop-core-demo.mp4` | 成片（英文界面版，替换旧版） |
| `docs/site/public/demo/agentworkshop-core-demo-poster.png` / `poster.jpg` | 封面（EDA 工坊散点图帧） |
| `docs/site/public/demo/agentworkshop-core-demo.en.srt/.vtt` | 英文字幕 |
| `docs/site/public/demo/agentworkshop-core-demo.zh-Hans.srt/.vtt` | 中文字幕 |
| `docs/site/public/demo/agentworkshop-core-demo-voiceover.mp3` | 独立旁白音轨 |
| `docs/site/public/demo/player.html` | 独立在线播放页（浅色，含双语字幕轨） |
| `README.md` / `README-zh.md` | 可点击封面 + 独立播放页/直接 MP4/VitePress 链接 |
| `docs/site/demo.md` / `docs/site/en/demo.md` | VitePress 演示页与真实边界说明 |
| 证据 | `docs/audit/evidence/2026-10-26-demo-video/`（media/timeline/qc/contact-sheet/poster） |
