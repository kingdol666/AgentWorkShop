/**
 * 事件块类型契约(事件聚类引擎的数据模型)。
 *
 * 块 = 时间线的呈现单元:同一 agent/任务/类别的相邻事件归并为一个块。
 * 对外契约由门面 `../useEventBlocks` 转发,外部导入路径不变。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'

export type BlockKind
  = | 'tool' // 🔧 工具调用
    | 'status' // 中间状态文本
    | 'life' // agent 生命周期(idle/busy/stopped)
    | 'route' // 点对点消息投递
    | 'stream' // LLM 输出(delta 打字机 + message 落定气泡)
    | 'task' // 任务状态迁移/进度
    | 'artifact' // 交付物
    | 'member' // 团队成员变更
    | 'memory' // 记忆沉淀
    | 'error' // 错误
    | 'other'

export interface EventBlock {
  id: string
  kind: BlockKind
  agentId: string | null
  taskId: string | null
  events: AepEnvelope[]
  firstAt: string
  lastAt: string
  /** stream:已落定(agent.message 落定 / 全文重复帧折入),渲染端隐藏打字光标 */
  settled: boolean
  /** stream:折入的重复落定帧数 */
  folded: number
  /** stream:落定全文与 delta 累计有差异(含扩展段落)时,以落定全文覆盖渲染 */
  overrideText: string | null
  /** stream:内容已被折回并块的流片块折叠为一行提示 */
  coveredBy: string | null
  /** artifact:交付物正文与相邻同源 stream 回复重复(默认折叠正文) */
  dupStream: boolean
}
