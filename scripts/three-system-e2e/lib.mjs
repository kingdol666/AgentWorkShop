/**
 * 配置(BASE/KB/KBWEB/DIAG/FULL/ROOT/DCW_NODE/通道名)/ 断言与计数 / HTTP 辅助
 * (由 scripts/three-system-e2e.mjs 按职责拆出;内容逐行原文搬运)
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 本文件位于 scripts/three-system-e2e/(比原入口 scripts/ 深一层)→ 上溯两级仍为仓库根
export const ROOT = resolve(__dirname, '..', '..')
export const FULL = process.argv.includes('--full')

export const BASE = process.env.AW_BASE ?? 'http://localhost:3021'
export const KB = process.env.KB_BASE ?? 'http://127.0.0.1:8770'
export const KBWEB = process.env.KB_WEB ?? 'http://127.0.0.1:6789'
export const DIAG = process.env.DIAG_BASE ?? 'http://127.0.0.1:3210'
export const DCW_NODE = process.env.E2E_DCW_NODE ?? 'dw-e92bb0e7' // 压力设定器(mock 驱动)
export const CH_A = '产线数据分析组'
export const CH_B = '闭环控制组'

// 计数器保持模块内可变:跨模块 `export let` 会被 import/no-mutable-exports 拒绝,
// 且可变绑定被多个模块直接改容易失控。外部读快照用 counters(),记一次失败用 countFail()。
let pass = 0
let fail = 0
const failures = []

export function counters() {
  return { pass, fail, failures }
}

/** 记一次失败而不打印断言行(阶段级兜底用) */
export function countFail(label) {
  fail += 1
  failures.push(label)
}

export function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(label)
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function raw(method, url, { body, token, agent, timeoutMs = 20000 } = {}, retried = 0) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (agent) headers['x-aw-agent-token'] = agent.token
  let res
  try {
    res = await fetch(url, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (e) {
    // 瞬时网络抖动(代理/服务重启窗口)重试一次,避免整场 e2e 因单点超时中止
    if (retried < 1) {
      await sleep(1500)
      return raw(method, url, { body, token, agent, timeoutMs }, retried + 1)
    }
    throw e
  }
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
export const api = (method, path, opts = {}) => raw(method, `${BASE}${path}`, opts)
export const envelopeData = r => r?.json?.data
export const resultText = r => String(r?.json?.data?.result?.text ?? '')
export const invoke = (agent, tool, args, timeoutMs = 60000) => api('POST', '/api/workshop/agent-tools/invoke', {
  agent, timeoutMs, body: { agentId: agent.id, tool, args },
})
