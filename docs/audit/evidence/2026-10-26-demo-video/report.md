# 宣传演示视频制作报告（2026-10-26）

## 任务与约束

用户要求：约 3 分钟、真实实机录屏、英文讲解（优质神经语音）、汉英双语字幕、浅色主题、功能间过渡动画、替换 VitePress 演示资源并提供可直接在线播放的独立外链（供论文审稿人打开）。

## 采用能力

- Skill 路由：`video-agent-kit:video-edit-agent` → `video-edit-assembly`（多素材组装 + 旁白 + 字幕）。
- 录制：CDP `Page.startScreencast`（Puppeteer + 本机 Chrome），1920×1080、30fps、浅色主题（localStorage `app` 持久态 `isDark:false`）。
- 语音：Edge 神经语音 `en-US-AndrewNeural`，-4% 语速（`edge-tts` 7.2.8；升级后消除了 403）。
- 混音：逐句合成 → 绝对时间 adelay 对齐 → `loudnorm=I=-16` 单轨；无音乐（避免版权）。
- 字幕：ASS 烧录（白色主文 + 中文次行 + 深色半透明底框）+ 外挂 en/zh-Hans `.srt/.vtt`（逐句人工撰写中文）。
- 转场：`xfade=fade` 0.5s × 10；静态页给 1.03 倍轻推镜，避免"死画面"。
- QC：ffprobe 时长/分辨率/音轨覆盖；失败帧与接触表抽检；字幕对齐以 cue 表为准。

## 成片

- 文件：`docs/site/public/demo/agentworkshop-core-demo.mp4`
- 时长 **172.97 s（2:53）**，1920×1080 @30fps，H.264 CRF21 + AAC 192k，18.4 MB，`+faststart`。
- 分幕：标题卡 → 控制室仪表盘 → 实时遥测 → **EDA 分析管道**（导入 40 行 → 代码过滤 35 行 → 绘图 → 存模板）→ 受治理产线操作 → 已发布本体（v1）→ Agent 工作台 → 插件面（11 装载）→ 分析台账 → EDA 图库 → 结尾卡。
- 19 条双语字幕；英文旁白 132 s 语音 + 呼吸留白。

## 素材真实性

- 全部为真实实机界面录屏，非合成 UI；录制实例为共享数据根的**一致性快照**（`VACUUM INTO` 取 workshop/users 库）+ 本次播种：目标线 `Injection Molding · Demo Line`（8 DCW + 6 DAQ，mock 驱动）、本体 v1（5 实体/4 关系/2 条已批准规则，双人复核后发布）、2 张 EDA 图表 + 看板 + 模板。
- 遥测由录制期 1 Hz 采样器回放（历史 20 分钟 + 实时），页面数值真实增长；**未连接真实 PLC，未向真实设备写入**（页面上"产线操作"为只读日志面）。
- 视频中"保压 65→70 bar 固化配方 v3"的旁白对应本仓库此前实机闭环的既有证据（`bench/results/injection-pressure-loop-*`、`docs/audit/2026-10-25-live-demo-full-stack.md`），当前录制以分析台账页面呈现该链路。

## 已知取舍（如实记录）

1. 因 mock 驱动不自产样本，遥测用采样器回放；`daq/query` 在快照实例上返回空点集，故未在片中展示趋势图查询（管道幕用 CSV 导入路径，本身即为产品功能）。
2. 在线查看器满屏图表在 puppeteer 截图时刻偶发未绘制（异步组件时序），插入式"英雄镜头"因此撤除；片中保留查看器按钮与整段绘图流程。
3. Pages 站点的演示页引用 `agentworkshop-core-demo.*` 七件套与 `player.html`；主分支部署后即生效。

## 交付清单

| 文件 | 说明 |
| --- | --- |
| `agentworkshop-core-demo.mp4` | 成片（替换旧版） |
| `agentworkshop-core-demo-poster.png` / `poster.jpg` | 封面（管道幕实拍帧） |
| `agentworkshop-core-demo.en.srt/.vtt` | 英文字幕 |
| `agentworkshop-core-demo.zh-Hans.srt/.vtt` | 中文字幕 |
| `agentworkshop-core-demo-voiceover.mp3` | 独立旁白音轨 |
| `player.html` | 独立在线播放页（浅色，含双语字幕轨） |
| 证据 | `docs/audit/evidence/2026-10-26-demo-video/`（timeline/qc/contact-sheet/record.log） |
