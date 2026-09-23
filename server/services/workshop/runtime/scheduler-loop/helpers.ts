/**
 * SchedulerLoop 的模块级纯工具/常量(原 server/services/workshop/runtime/scheduler-loop.ts 类外声明,含类体之后与类无关的部分)。
 */
import { createLogger } from '../../logger'

export const log = createLogger('workshop.scheduler')

/** 调度快照注入的最近邮件条数(倒序;控制 supervise prompt 体量) */
export const MAIL_SNAPSHOT_LIMIT = 20

/** 成员摘要(快照内;含队列上下文与实时进度,供 lead 最优调配与停滞识别) */
export const IDLE_TICK_CAP_MS = 8000
/** Failed/empty Lead decision retry backoff; never replaces a decision with blind fallback. */
export const LEAD_DECISION_RETRY_MS = 5000
