# 0.20.1 系统宣传片制作记录（2026-11-25）

**成片**：`docs/site/public/demo/agentworkshop-0.20.1-promo.mp4`
**母片（仓库外）**：`D:\tmp\aw-promo-20261125\out\agentworkshop-0.20.1-promo.mp4`

## 1 规格

| 项 | 母片 | 网页版 |
|---|---|---|
| 时长 | 87.70 s | 87.70 s |
| 画面 | 1920×1080 @30fps · H.264 High@4.1 · yuv420p (tv) | 同左 |
| 音频 | AAC 48 kHz 立体声 · −22.3 LUFS | AAC 128 kbps |
| 大小 | 29,216,093 B | 15,691,679 B |
| MD5 | `0dcc566703af8f0a9dd102beb3648369` | `304c49ac9ded7cb30a4df95523cc60b2` |
| 字幕 | 中文烧录字幕；无配音（字幕驱动） | 同左 |
| 海报 | `agentworkshop-0.20.1-promo-poster.jpg`（147,014 B） | 同左 |

19 个镜头：7 处叠化 / 压黑 / 擦除转场 + 12 处硬切；每镜独立 filter graph，`xfade`/`concat` 归一
`settb=1/30`，末端 `scale=out_range=tv` 压回 tv range。

## 2 素材来源

| 素材 | 来源 | 片内用途 |
|---|---|---|
| 频道控制台、数采中心、数字孪生、任务列表、任务详情、交付物 | 真实 0.20.1 桌面实例（隔离 home，端口 55418）截图 10 张 | 镜头 06–11 |
| 桌面主窗、更新中心 | 0.20.1 安装版（`D:\tmp\aw-update-calibration-20261125`） | 镜头 03–04 |
| 启动页 | `docs/design/desktop-chrome/live-splash-draw-20261124.png` | 镜头 02 |
| 数采实时会话与写控拒绝 | v0.20.0 审计证据 `daq-live-real-data.jpg`（页脚 v0.20.0/dev） | 镜头 12–13 |
| 字标 | `desktop/brand/mark.svg` 4× 扫描线栅格化 | 片头 / 收尾 |
| 音频 | ffmpeg 现场合成（55/82.5 Hz 正弦 + 粉噪 + 6 个 46 Hz 章首低脉冲） | 全片 |

**任务依据**：worker 任务 `0c3e927d-fc82-475f-a5ea-f1e0f2e60387`（COMPLETED，6 m 37 s），
`daq_query` 270 个 15 s 桶、`daq_export` 1,912 个原始点、均值 185.048 ℃、偏差 +0.048 ℃、
>205 ℃ 0/270、σ 0.297 ℃；有效数据 2026-11-25 13:54:11–15:01:23（67 分钟）。
同轮 lead 任务 `6ba58e33` 在 `read(xd://…)` 工具目录遍历后停滞并被取消，保留在任务板，片内不展示。

## 3 复现

```bash
node D:/tmp/aw-promo-20261125/render.mjs             # 19 镜 + 合成 + 音轨
node D:/tmp/aw-promo-20261125/render.mjs --timeline  # 只打印时间线
node D:/tmp/aw-promo-20261125/render.mjs --only=c3   # 单镜重渲
node D:/tmp/aw-promo-20261125/render.mjs --assemble  # 只重跑合成
```

分镜表、运镜、转场与 ffmpeg 参数见 `D:/tmp/aw-promo-20261125/edit-plan.md`；
素材清单与缺口见同目录 `materials.md`。

## 4 合规

- 演练产线 `ln-cca0c356` 为 `simulated=true` 的影子模拟；片内与海报均标注，不称物理 HIL 或投产批准。
- 有效数据仅 67 分钟，片内不写成 7 天连续趋势；节点查询时 offline。
- Mimosa 审计 `partial / inconclusive`，不作安全通过声明；V1–V6 写作 8/0（V6 跳过）。
- 安装包未签名，SHA-256 不是发布者签名；片内三处标注。
- 不展示 `task-final.json` 的 env 转储或任何令牌。
- 审计截图页脚为 v0.20.0/dev，片内字幕标注“审计轮次 v0.20.0”，不冒充 0.20.1 实拍。

## 5 已知限制

- 无配音、无版权音乐；仅低频铺底与章首脉冲。
- 无 1080p 长录屏；以真实 UI 静帧 + 运镜为主，硬切承担证据镜头的可信度。
- 未覆盖 HITL 审批、配方/批次开跑、Prefab 页面、更新下载全流程；这些是后续素材缺口。
