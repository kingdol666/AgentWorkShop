# Harness UI 重构执行计划（2026-11-08）

> 输入：claude-design 三方向原型 + 既有 ChatGPT 化令牌（`--chat-*`，2026-11-07）。
> 目标：Channel / Project 两个会话界面按 ChatGPT harness 布局收口，入口页按功能优化；
> 全部分 PR 交付，可单独合并或整体回退。

## 0. 结论（方向选择）

- **主线 = 方向 A · Quiet Harness**：用户明确要求「按 ChatGPT 布置」，A 的结构最忠实；
  B 的「运行态读数」以 10.5px 弱读数的形式吸收进 A，不再另起常驻右栏。
- B/C 保留为可切换方案：结构已在画布，换向只动令牌与 5 个会话组件的样式段。

## 1. 设计纪律（不改业务）

1. 所有 `data-testid`、快捷键（1-7、⌘K）、深链 `?view=`、`?channel=` 原样保留。
2. 投递台账、@ 提及解析、HITL 审批、写控语义零改动。
3. 只改模板外壳与 scoped 样式；新增的 `harnessOf()` / `channelNameOf()` 只读既有实体/快照。
4. 窄屏（≤1023）形态不退化：输入区仍是主操作面，触摸目标 ≥40px。

## 2. PR 序列

| PR | 分支 | 文件 | 验收 |
| --- | --- | --- | --- |
| 1 | `feat/harness-ui-channel` | ChatTimeline / Composer / ComposerToolbar / StatusChip / ChannelSessionList / i18n / 设计画布与对比图 | typecheck、unit、cssvars、i18n、实机截图 |
| 2 | `feat/harness-ui-project` | `app/pages/projects/[id].vue` / 对比图 | 同上 + 项目页 smoke（tab-* / 审批流不受影响） |
| 3 | `feat/harness-ui-entry-pages` | `app/pages/projects/index.vue` / `app/pages/workshop/index.vue` / 对比图 | 同上 |

> PR-2/3 不依赖 PR-1 的代码（只消费既有的 `--chat-*` 令牌），可任意顺序合并。

## 3. 关键取舍

- **发送钮改黑白**：橙色在 2026-11-07 版里同时承担「发送 / live / 待批」三种语义，
  面积一大就抢注意力。按 ChatGPT 的做法把主操作收进油墨色，橙色只做状态。
- **Agent 无气泡**：多 Agent 频道的正文是主要阅读对象；气泡会把长文切成碎片。
- **harness 标识上桌**：AgentBlock v1 已把 harness 语义带进事件层，UI 必须能看见它，
  否则「多 harness」在界面上仍是黑盒。
- **用户消息去头像**：右侧气泡 + 时间戳已足够标识人类发言，头像列在多 Agent 场景
  反而让人误以为「人也是一个 agent」。
- **UUID 不上桌**：Project 的频道绑定行改显示频道名 / charter，短 id 只作次信息。

## 4. 未做（明确排除）

- 不改全局 Warm Paper 工业仪表声部（DAQ/DCW/分析等页面保持原设计语言）。
- 不做 B/C 的运行时主题切换（需要设计令牌分层，另立项）。
- 不动 Channel 右侧上下文面板的信息架构。
