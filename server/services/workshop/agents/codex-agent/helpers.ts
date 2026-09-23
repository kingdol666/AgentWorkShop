/**
 * CodexAgentImpl 的模块级纯工具/常量(原 server/services/workshop/agents/codex-agent.ts 类外声明,含类体之后与类无关的部分)。
 */
import { createLogger } from '../../logger'

export const log = createLogger('workshop.codex')

/**
 * 默认回合停滞上限:整轮无任何事件(含推理模型的静默思考期)达到该时长才中止。
 * 600s 会误杀健康的沉默推理(实测推理档静默 >10 分钟后被打断,任务 FAILED→重试→CANCELED);
 * 事件到达即刷新计时,真实卡死仍会在该窗口内被发现。
 */
export const CODEX_TURN_STALL_MS = 1_800_000
