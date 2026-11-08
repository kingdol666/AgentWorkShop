# AgentBlock v1：跨 harness 统一工具调用块 + `agent.block` AEP 帧

> 生产审计（2026-11-08）指控 6 的落地修复。目标：不同 harness 的 Block 统一转为系统 AgentBlock，前端与系统业务统一渲染。**适配全部 14 个兼容 harness。**

## 架构（三层，纯增量不破坏既有面）

```
omp 发射点(原生结构最全: toolName/args/isError 直取)      其余 12 个发射 harness(仅 🔧 文本)
   │ data Part + 🔧 文本 Part 并行追加                        │ 仅 🔧 文本 Part
   ▼                                                        ▼
┌──────────── ws event-mapping(全 harness 唯一汇聚点) ────────────┐
│ ① 原生 data Part 提取 → agent.block 帧（字段最全）             │
│ ② 无原生块 → normalizeToolLine 文本签名归一兜底                │
│    （13 种文案签名: omp✅❌ / 失败: / 失败 / ✓ / 🔧name(args) / 裸名）│
└───────────────────────────────────────────────────────────┘
   │ agent.status.message（文本帧,compat 不变） + agent.block（结构帧,新增）
   ▼
前端 ClusterTool：结构块优先 + 同文文本帧去重 + 正则退路径（compat）
```

- **统一协议**：`shared/agent-blocks.ts`——`AgentToolBlock`（kind='agent.tool', v=1, harness/tool/phase/status/durationMs/argsPreview/errorText/text）+ Part 提取/往返 + `normalizeToolLine`（全字符串切片实现，零正则——安全扫描器对解析类正则误报命令注入，两轮实测后改为等价字符串实现）
- **omp 原生发射**：`event-mapping.ts` start/end 在 🔧 文本旁并行追加 data Part（字段最全：toolName/args/isError 直取）
- **ws 层 adapter**：status 消息含原生块优先提取；无原生块按文本签名归一兜底——**13 个发射 harness 的文案签名全表**（claude/opencode/codex/cursor/dsh/hermes/crush/copilot/gemini/goose/qwen/pi + omp），publish 全帧型自动落 channel_events，历史/审计面零改动
- **前端**：classify 加 `agent.block`→tool；ClusterTool 结构块优先 + 同文文本帧去重 + 正则退路径保留
- **mock**：不发工具行（设计），fixture 明确记录

## 变更清单（6 文件，339+/11-）

| 文件 | 变更 |
|---|---|
| `shared/agent-blocks.ts`（新） | 块 schema + Part 提取/往返 + 文本签名归一表 |
| `server/services/workshop/agents/omp-agent/event-mapping.ts` | start/end 追加原生 data Part |
| `server/api/workshop/ws/event-mapping.ts` | `agent.block` 帧派生（原生优先/归一兜底） |
| `app/composables/workshop/event-blocks/classify.ts` | `agent.block` → tool |
| `app/components/workshop/blocks/ClusterTool.vue` | 结构优先 + 去重 + 正则退路径 |
| `tests/agent-blocks.test.ts`（新） | 26 断言 fixture |

## 验证

- fixture **26/26**（13 发射 harness 归一矩阵含 omp✅❌/opencode 失败/cursor✓/hermes·dsh 裸失败/codex 命令 label + mock 设计 + 200 截断 + Part 往返 + 坏载荷防御）
- `npm run typecheck` **0 错**
- 全量 unit **1236 tests / 1234 pass / 0 fail / 2 skip**（含新增 26 条）
- 兼容：文本面照旧（旧客户端不受影响），块是纯增量
