/**
 * 错误台账(error ledger):把"服务器侧异常"变成可审计、可报警的持久记录。
 *
 * 生产落地语义:任何 5xx / 进程级故障 / 插件装载失败都必须在 /logs(system 域,level=error)
 * 留下一条可追溯记录 —— 人读一行摘要 + 完整堆栈进 detail_json。此前这些异常只进 console
 * (进程重启即失),运维在日志页看不到"系统到底什么时候坏过、坏在哪"。
 *
 * 三个入口:
 *  - captureServerError(event, error):nitro 'error' 钩子接线(未捕获异常 / 5xx 响应)
 *  - captureProcessFault(kind, reason):unhandledRejection / uncaughtException(dev-stability-guard 转接)
 *  - capturePluginError(scope, err):插件宿主初始化 / 单插件装载失败(aw-plugins 转接)
 *
 * 设计约束(全部为硬要求):
 *  - 限流去重:同 key(method+path+消息指纹)10s 折叠;全局 120 条/分钟,超限丢弃并计，
 *    每 60s 补一条"节流"汇总记录 —— 异常风暴时台账既不失真也不被打爆。
 *  - 自身永不抛错:台账写失败只 console.warn,绝不击穿业务主链路(与 recordOps 同纪律)。
 *  - 只记 system 域 level=error(进程瞬态 socket/db-busy 降为 warn,与 stability-severity 对齐)。
 */
import { recordOps } from './ops'
import { classifyFatalCandidate } from '../../../utils/stability-severity'

/** 单 key 折叠窗:同源异常 10s 内只记首条 */
const DEDUP_WINDOW_MS = 10_000
/** 全局限流:每分钟最多入账条数(超出丢弃,防异常风暴打爆 sqlite) */
const RATE_LIMIT_PER_MIN = 120
/** 节流汇总记录的最小间隔 */
const THROTTLE_SUMMARY_INTERVAL_MS = 60_000
/** 堆栈截断上限(完整 4KB 足够定位;超长栈多为递归渲染噪声) */
const STACK_MAX_CHARS = 4096

const dedupMap = new Map<string, number>()
let windowStart = 0
let windowCount = 0
let droppedCount = 0
// 初始取当前时刻:汇总行只在"持续丢弃满一个汇总间隔"后出现,
// 个别折叠不产生噪声行(否则折叠语义被自我抵消)
let lastThrottleSummaryAt = Date.now()

/** 测试隔离:清空全部限流状态(仅测试调用) */
export function resetErrorLedgerForTest(): void {
  dedupMap.clear()
  windowStart = 0
  windowCount = 0
  droppedCount = 0
  lastThrottleSummaryAt = Date.now()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(截断,原长 ${text.length})`
}

/** 限流判定:返回 false = 该条应被折叠/丢弃 */
function admit(key: string, now: number): boolean {
  const last = dedupMap.get(key)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return false
  dedupMap.set(key, now)
  if (dedupMap.size > 512) {
    // 简单防膨胀:清掉 30s 前的旧 key(异常源不会长期驻留)
    for (const [k, ts] of dedupMap) {
      if (now - ts > 30_000) dedupMap.delete(k)
    }
  }
  if (now - windowStart >= 60_000) {
    windowStart = now
    windowCount = 0
  }
  windowCount += 1
  return windowCount <= RATE_LIMIT_PER_MIN
}

function noteDropped(now: number): void {
  droppedCount += 1
  if (now - lastThrottleSummaryAt >= THROTTLE_SUMMARY_INTERVAL_MS) {
    lastThrottleSummaryAt = now
    writeSafe({
      action: 'server.error.throttled',
      summary: `错误台账节流:过去窗口丢弃 ${droppedCount} 条重复/超限异常(限流 ${RATE_LIMIT_PER_MIN}/min)`,
      detail: { droppedCount, rateLimitPerMin: RATE_LIMIT_PER_MIN },
      level: 'warn',
    })
    droppedCount = 0
  }
}

interface LedgerInput {
  action: string
  summary: string
  detail: Record<string, unknown>
  level?: 'info' | 'warn' | 'error'
}

/** 统一出账:recordOps 包一层永不抛错(审计失败不击穿,与全站纪律一致) */
function writeSafe(entry: LedgerInput): void {
  try {
    recordOps({
      actor: 'error-ledger',
      actorName: '错误台账',
      actorKind: 'system',
      action: entry.action,
      kind: 'system',
      scope: 'system',
      level: entry.level ?? 'error',
      summary: entry.summary,
      detail: entry.detail,
      targetKind: 'server',
    })
  }
  catch (err) {
    console.warn(`[error-ledger] 台账写入失败(已忽略): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 从任意 thrown 值提取 { name, message, stack } 结构(thrown 不一定是 Error) */
function describeThrown(reason: unknown): { name: string, message: string, stack: string } {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: truncate(reason.stack ?? '', STACK_MAX_CHARS) }
  }
  return { name: 'NonErrorThrow', message: truncate(String(reason), 500), stack: '' }
}

/** h3 事件的最小结构面(避免把 h3 类型耦合进纯服务层,便于单测) */
export interface LedgerEventLike {
  method?: string
  path?: string | undefined
  /** h3 event 上原始 node 请求 */
  node?: { req?: { method?: string, url?: string } }
}

function requestOf(event: LedgerEventLike | undefined): { method: string, path: string } {
  const method = String(event?.method ?? event?.node?.req?.method ?? 'GET').toUpperCase()
  const path = String(event?.path ?? event?.node?.req?.url ?? '(unknown)')
  return { method, path }
}

/**
 * nitro 'error' 钩子入口:只记 /api/** 且 statusCode>=500(4xx 是被拦截的业务语义,
 * 数量巨大且已由各路由给出可行动回执 —— 入账反而淹没真错误)。
 */
export function captureServerError(event: LedgerEventLike | undefined, error: unknown): void {
  try {
    const { method, path } = requestOf(event)
    if (!path.startsWith('/api/')) return
    const status = (error as { statusCode?: number })?.statusCode
    if (typeof status === 'number' && status < 500) return
    const now = Date.now()
    const info = describeThrown(error)
    const key = `${method} ${path} ${info.name}:${info.message.slice(0, 120)}`
    if (!admit(key, now)) {
      noteDropped(now)
      return
    }
    writeSafe({
      action: 'server.error',
      summary: `${method} ${path} → ${status ?? 500} ${info.name}: ${truncate(info.message, 200)}`,
      detail: { method, path, status: status ?? 500, name: info.name, message: info.message, stack: info.stack },
    })
  }
  catch (err) {
    console.warn(`[error-ledger] captureServerError 自身异常(已忽略): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 进程级故障入口(dev-stability-guard 转接):severity 与 stability-severity 对齐 ——
 * fatal/upstream/engine → error;socket/db-busy 瞬态 → warn。fatal 分支在 exit 前调用,
 * sqlite 同步写保证落账先于进程退出。
 */
export function captureProcessFault(kind: 'unhandledRejection' | 'uncaughtException', reason: unknown): void {
  try {
    const now = Date.now()
    const info = describeThrown(reason)
    const severity = classifyFatalCandidate(reason)
    const key = `process ${kind} ${info.name}:${info.message.slice(0, 120)}`
    if (!admit(key, now)) {
      noteDropped(now)
      return
    }
    writeSafe({
      action: `process.${kind}`,
      summary: `进程${kind === 'uncaughtException' ? '未捕获异常' : '未处理的 Promise 拒绝'}[${severity}] ${info.name}: ${truncate(info.message, 200)}`,
      detail: { kind, severity, name: info.name, message: info.message, stack: info.stack },
      level: severity === 'socket' || severity === 'db-busy' ? 'warn' : 'error',
    })
  }
  catch (err) {
    console.warn(`[error-ledger] captureProcessFault 自身异常(已忽略): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 插件宿主/装载失败入口(aw-plugins 转接):插件面故障必须进台账 */
export function capturePluginError(scope: string, err: unknown): void {
  try {
    const now = Date.now()
    const info = describeThrown(err)
    const key = `plugin ${scope} ${info.name}:${info.message.slice(0, 120)}`
    if (!admit(key, now)) {
      noteDropped(now)
      return
    }
    writeSafe({
      action: 'plugin.error',
      summary: `插件故障[${scope}] ${info.name}: ${truncate(info.message, 200)}`,
      detail: { scope, name: info.name, message: info.message, stack: info.stack },
    })
  }
  catch (e) {
    console.warn(`[error-ledger] capturePluginError 自身异常(已忽略): ${e instanceof Error ? e.message : String(e)}`)
  }
}
