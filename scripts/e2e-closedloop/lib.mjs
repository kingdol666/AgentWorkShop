/**
 * 配置(BASE)/ 断言与计数 / HTTP 辅助 / 插件清单解析 / 轮询等待
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */

/**
 * scripts/e2e-full-closedloop.mjs —— AgentWorkShop 全链路端到端闭环验证
 *
 * 覆盖(全部走真实 HTTP / 真实构建产物,不打桩):
 *
 *   S1  账号与权限      注册 → 角色 → 产线级三态授权(none/readonly/operate)
 *   S2  工业建模        产线 → 产品 → 配方(含工艺窗口) → 数采/数控节点 → 设备孪生绑定
 *   S3  驱动可用性      逐驱动 available/test(mock 必通;真实协议栈缺失须明确报"不可用"而非静默)
 *   S4  数采闭环        开跑 → 采样入队 → 消费 → TSDB 落库 → WS/REST 可读 → 批次打标
 *   S5  多形态帧管线    vector 帧入 buffer → 广播 thumbUrl/contentUrl → **立刻回查 content 必须 200**
 *                      (P0-4 内存读穿透回归:这条断言在修复前必然是 404)
 *   S6  数控闭环        下发 → 回读校验 → ACK 记账 → 写历史 → 参数锚入册 → 单步回退
 *   S7  回退账本算法    锚上限/稳定锚索引/lastStableBefore/chainRollbackCount 复杂度回归
 *   S8  Agent 鉴权矩阵  未绑定拒 / 绑定放行 / manual 挂起审批 / **dcw_rollback 必须同样鉴权**
 *                      (P0-D 回归:修复前未绑定 agent 可回退任意节点)
 *   S9  工具桥越权     用户 A 的 token + 用户 B 的 agentId → 必须 403
 *                      (P0-E 回归:修复前会以 B 的身份执行)
 *   S10 插件系统        项目作用域装载 → setup → 路由 → client 脚本 → 停用 → 热重载 → 无幽灵态
 *                      (P0-1/P0-2/P1-H/P1-I 回归)
 *   S11 数据根唯一性    运行期落盘必须全部位于配置根 data/(P0-B 回归)
 *
 * 用法:
 *   node scripts/e2e-full-closedloop.mjs [base]
 *   默认 base = http://127.0.0.1:3111
 *   环境: AW_E2E_TOKEN 复用既有用户 token
 *
 * 退出码:0 = 全绿;1 = 有 FAIL。
 */

export const BASE = process.argv[2] ?? process.env.AW_BASE ?? 'http://127.0.0.1:3111'

// 计数器保持在模块内可变:跨模块 `export let` 会被 import/no-mutable-exports 拒绝,
// 且可变绑定被多个模块直接改容易失控。外部读快照用 counters(),记一次失败用 countFail()。
let pass = 0
let fail = 0
const failures = []

export function counters() {
  return { pass, fail, failures }
}

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
export const section = t => console.log(`\n━━━ ${t} ━━━`)
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function raw(method, path, { body, token, agentToken, timeoutMs = 60_000, raw: rawRes = false } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (agentToken) headers['x-aw-agent-token'] = agentToken
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (rawRes) return res
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
export const api = (m, p, o) => raw(m, p, o)

/**
 * 从插件清单响应里取 plugins 数组。
 * GET /api/workshop/plugins 用 defineEventHandler(**不套 {code,message,data} 信封**),
 * 且本文件的 api() 是 `{ status, ...json }` —— 所以数组在 `resp.plugins`;
 * 早期断言写 `resp.data?.plugins` 永远取到 undefined,把"接口好着"误判成"插件没装载"。
 * 这里同时兼容信封形态,避免接口日后加信封再次踩坑。
 */
export function manifestPlugins(resp) {
  return resp?.plugins ?? resp?.data?.plugins ?? resp?.data?.data?.plugins ?? []
}

/** 轮询直到条件成立(或超时);返回最后一次取值 */
export async function waitUntil(label, fn, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    }
    catch (err) {
      last = err
    }
    await sleep(intervalMs)
  }
  console.log(`    · waitUntil 超时: ${label} (last=${JSON.stringify(String(last)).slice(0, 160)})`)
  return null
}
