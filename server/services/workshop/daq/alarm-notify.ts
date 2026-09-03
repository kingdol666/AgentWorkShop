/**
 * AlarmNotifier —— 报警外送 + 升级扫描(S5,production-readiness-plan)。
 *
 * - notifyAlarm():webhook 外送(env ALARM_WEBHOOK_URL;POST JSON,天然兼容
 *   钉钉/企微/飞书机器人),失败重试 3 次退避;fire-and-forget,绝不阻塞采集主链路;
 * - startAlarmEscalator():60s 扫描未确认且超 ALARM_ESCALATE_MINUTES(默认 15)的
 *   报警 → escalation+1 并重发外送(升级通知);globalThis 守卫防 HMR 重复。
 */
import { randomUUID } from 'node:crypto'
import { getOps } from '../ops/ops'
import { daqRuntimeSettings } from '../settings'

const RETRIES = 3
const ESCALATE_SWEEP_MS = 60_000

const g = globalThis as typeof globalThis & { __awAlarmEscalator?: NodeJS.Timeout }

export interface AlarmNotifyPayload {
  id: string
  nodeId: string
  nodeName: string
  metric: string
  value: number | null
  rule: string
  threshold: number | null
  escalation: number
  createdAt: string
}

/** webhook 外送(单次;成功返回 true) */
async function postWebhook(payload: AlarmNotifyPayload, url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'alarm', text: `[报警] ${payload.nodeName} ${payload.metric} ${payload.rule} 阈值 ${payload.threshold ?? '-'} 当前 ${payload.value ?? '-'}(升级 x${payload.escalation})`, ...payload }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  }
  catch {
    return false
  }
}

/** 外送 + 重试退避(1s/2s/4s);结果记录进 alarm_events.notified_json */
export function notifyAlarm(payload: AlarmNotifyPayload): void {
  // daq.alarmWebhookUrl(env ALARM_WEBHOOK_URL 兼容别名);未配置 = 仅 WS/面板可见(合法降级)
  const url = daqRuntimeSettings().alarmWebhookUrl || undefined
  if (!url) return
  const repo = getOps()?.alarmEvents
  void (async () => {
    let ok = false
    for (let attempt = 1; attempt <= RETRIES && !ok; attempt++) {
      ok = await postWebhook(payload, url)
      if (!ok && attempt < RETRIES) await new Promise(r => setTimeout(r, 2 ** (attempt - 1) * 1000))
    }
    if (!repo) return
    try {
      const row = repo.list(500).find(a => a.id === payload.id)
      if (!row) return
      const log = JSON.parse(row.notifiedJson || '[]') as Array<{ url: string, ok: boolean, at: string, attempt: number }>
      log.push({ url, ok, at: new Date().toISOString(), attempt: RETRIES })
      repo.recordNotify(payload.id, JSON.stringify(log.slice(-10)))
    }
    catch {
      // 外送记录失败不影响业务
    }
  })()
}

/** 升级扫描器(懒启动;进程内单例) */
export function startAlarmEscalator(): void {
  if (g.__awAlarmEscalator) return
  const escalateMin = Math.max(1, daqRuntimeSettings().alarmEscalateMinutes)
  const timer = setInterval(() => {
    const repo = getOps()?.alarmEvents
    if (!repo) return
    try {
      const cutoff = Date.now() - escalateMin * 60_000
      for (const a of repo.listOpen(200)) {
        if (Date.parse(a.createdAt) > cutoff) continue
        repo.escalate(a.id)
        notifyAlarm({
          id: a.id, nodeId: a.nodeId, nodeName: a.nodeName, metric: a.metric,
          value: a.value, rule: a.rule, threshold: a.threshold,
          escalation: a.escalation + 1, createdAt: a.createdAt,
        })
      }
    }
    catch {
      // 升级扫描失败不致命(下一轮再扫)
    }
  }, ESCALATE_SWEEP_MS)
  timer.unref?.()
  g.__awAlarmEscalator = timer
}

/** 生成报警事件 id(raise 侧用) */
export function newAlarmId(): string {
  return `al-${randomUUID().slice(0, 8)}`
}
