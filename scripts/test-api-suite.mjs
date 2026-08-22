// -*- coding: utf-8 -*-
// AgentWorkShop 全 API 冒烟套件(mock harness;node scripts/test-api-suite.mjs)
//
// 覆盖:用户鉴权(401/越权 403)、channel CRUD、成员管理(增/改/启停/删)、
// 任务(默认路由/HITL 直发/参数校验/队列总览)、消息(实时/排队/回执/错误路径)、
// 记忆(存/取/搜/删)、事件流、终端 API + 终端 WS 鉴权与 NO_SESSION 路径。
import { env } from 'node:process'

const BASE = env.AW_BASE ?? 'http://127.0.0.1:3002'
const TOKEN = env.AW_TOKEN ?? 'ut-636e563104b844b591de8aadf6071aea'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 不抛错的请求:返回 { status, code, data } */
async function raw(method, path, body, token = TOKEN) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = await res.json().catch(() => null)
  return { status: res.status, code: d?.code, data: d?.data ?? d }
}
async function api(method, path, body) {
  const r = await raw(method, path, body)
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.code)}`)
  return r.data
}
async function pollUntil(fn, timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(300)
  }
}

/** 连 WS 并等待 term.error + close code(终端错误路径) */
function expectTermError(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let errCode = null
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        ws.close()
      }
      catch { /* 已关闭 */ }
      reject(new Error('timeout'))
    }, timeoutMs)
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data)
        if (m.type === 'term.error') errCode = m.code
      }
      catch { /* ignore */ }
    })
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer)
      resolve({ closeCode: ev.code, errCode })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('ws error'))
    })
  })
}

async function main() {
  const stamp = Date.now().toString(36)

  // ===== 1. 鉴权 =====
  console.log('\n--- 1. 用户鉴权 ---')
  {
    const r1 = await raw('GET', '/api/workshop/channels', null, null)
    check('无 token → 401', r1.status === 401)
    const r2 = await raw('GET', '/api/workshop/channels', null, 'ut-not-a-token')
    check('假 token → 401', r2.status === 401)
  }

  // ===== 2. Channel 生命周期 =====
  console.log('\n--- 2. Channel CRUD ---')
  const created = await api('POST', '/api/workshop/channels', {
    name: `api-suite-${stamp}`,
    description: 'API 冒烟套件(自动清理)',
    leadAgent: { name: 'suite-lead', harness: 'mock', config: { delayMs: 80 } },
  })
  const cid = created.channelId
  const leadId = created.leadAgentId
  check('创建 channel(带 lead)返回 channelId/leadAgentId', typeof cid === 'string' && typeof leadId === 'string')
  {
    const ch = await api('GET', `/api/workshop/channels/${cid}`)
    check('GET channel:名称/lead', ch.name === `api-suite-${stamp}` && ch.leadAgentId === leadId)
    const list = await api('GET', '/api/workshop/channels')
    check('channel 列表包含新 channel', Array.isArray(list) && list.some(c => c.id === cid))
    await api('PATCH', `/api/workshop/channels/${cid}`, { description: '已更新' })
    const ch2 = await api('GET', `/api/workshop/channels/${cid}`)
    check('PATCH channel 描述生效', ch2.description === '已更新')
  }

  // ===== 3. 成员管理 =====
  console.log('\n--- 3. 成员管理 ---')
  let workerId = ''
  {
    const w = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'suite-worker', harness: 'mock', config: { delayMs: 80 } })
    workerId = w.id
    check('新增 mock worker', typeof workerId === 'string' && w.role === 'worker')
    const members = await api('GET', `/api/workshop/channels/${cid}/agents`)
    check('成员列表 = lead + worker', members.length === 2)
    await api('PATCH', `/api/workshop/channels/${cid}/agents/${workerId}`, { name: 'suite-worker-2', config: { delayMs: 60 } })
    const m2 = await api('GET', `/api/workshop/channels/${cid}/agents`)
    check('PATCH 成员改名生效', m2.some(m => (m.id ?? m.agentId) === workerId && m.name === 'suite-worker-2'))
    await api('PATCH', `/api/workshop/channels/${cid}/agents/${workerId}`, { enabled: 0 })
    const dis = (await api('GET', `/api/workshop/channels/${cid}/agents`)).find(m => (m.id ?? m.agentId) === workerId)
    check('PATCH enabled=0 → 成员禁用', dis?.enabled === 0)
    await api('PATCH', `/api/workshop/channels/${cid}/agents/${workerId}`, { enabled: 1 })
    const stopped = await api('POST', `/api/workshop/channels/${cid}/agents/${workerId}/stop`, {})
    check('HITL stop 成员 → stopped', stopped?.stopped === true || stopped?.state === 'stopped')
  }

  // ===== 4. 任务系统 =====
  console.log('\n--- 4. 任务系统 ---')
  {
    const parent = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
      title: `默认路由-${stamp}`,
      description: 'lead 派发并收口',
      parts: [{ text: '默认路由 body' }],
    })
    const done = await pollUntil(async () => {
      const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
      return tasks.find(t => t.id === parent.id)?.state === 'COMPLETED' || null
    }, 25_000)
    check('任务默认路由 lead → 派发 → COMPLETED', !!done)
    const direct = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
      title: `直发-${stamp}`,
      description: 'HITL 直达 worker',
      assigneeId: workerId,
      parts: [{ text: '直发 body' }],
    })
    const done2 = await pollUntil(async () => {
      const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
      return tasks.find(t => t.id === direct.id)?.state === 'COMPLETED' || null
    }, 20_000)
    check('任务 HITL 直发 worker → COMPLETED(stopped 成员被任务自动重激活)', !!done2)
    const bad1 = await raw('POST', `/api/workshop/channels/${cid}/tasks`, { assigneeId: 'not-a-member', title: 'x' })
    check('直发无效成员 → 404 MEMBER_NOT_FOUND(错误附当前名册)', bad1.status === 404 && bad1.code === 'MEMBER_NOT_FOUND' && String(bad1.data?.message ?? '').includes('名册'))
    const bad2 = await raw('POST', `/api/workshop/channels/${cid}/tasks`, { description: 'no title' })
    check('缺 title → 400 校验失败', bad2.status === 400)
    const q = await api('GET', `/api/workshop/channels/${cid}/queue`)
    check('队列总览返回成员队列上下文', Array.isArray(q) && q.length === 2 && q.every(x => 'state' in x))
  }

  // ===== 5. 消息系统 =====
  console.log('\n--- 5. 消息系统 ---')
  {
    const m = await api('POST', `/api/workshop/channels/${cid}/messages`, {
      toAgentId: workerId, fromAgentId: leadId,
      text: '回执探针', priority: 'immediate', requireReply: true,
    })
    const reply = await pollUntil(async () => {
      const rows = await api('GET', `/api/workshop/channels/${cid}/messages?limit=100`)
      return rows.find(r => r.fromAgentId === workerId && r.metadata?.['x-aw-in-reply-to'] === m.messageId) ?? null
    }, 15_000)
    check('实时消息(requireReply)→ worker 逐条回执', !!reply)
    const m2 = await api('POST', `/api/workshop/channels/${cid}/messages`, {
      toAgentId: workerId, fromAgentId: leadId, text: '排队探针', priority: 'task',
    })
    const delivered = await pollUntil(async () => {
      const rows = await api('GET', `/api/workshop/channels/${cid}/messages?limit=100`)
      const row = rows.find(r => r.id === m2.messageId)
      return row && row.state !== 'pending' ? row : null
    }, 15_000)
    check('排队消息送达并被消费(state≠pending)', !!delivered, delivered?.state)
    const bad1 = await raw('POST', `/api/workshop/channels/${cid}/messages`, { toAgentId: 'ghost', text: 'x' })
    check('消息目标不存在 → 404', bad1.status === 404)
    const bad2 = await raw('POST', `/api/workshop/channels/${cid}/messages`, { toAgentId: workerId, fromAgentId: 'fake-agent', text: 'x', priority: 'immediate' })
    check('伪造发送方(非成员)→ 404 MEMBER_NOT_FOUND(不被降级为人类消息)', bad2.status === 404 && bad2.code === 'MEMBER_NOT_FOUND')
  }

  // ===== 6. 记忆系统 =====
  console.log('\n--- 6. 记忆系统 ---')
  {
    // 私有记忆 → 成员列表;共享记忆 → 团队域(__team__)
    await api('POST', `/api/workshop/channels/${cid}/agents/${leadId}/memories`, {
      title: `记忆-${stamp}`, content: '协作链路验证唯一内容 7f3k9', importance: 0.8,
    })
    await api('POST', `/api/workshop/channels/${cid}/agents/${leadId}/memories`, {
      title: `共享-${stamp}`, content: '团队共享记忆探针 7f3k9', importance: 0.8, scope: 'shared',
    })
    const mine = await api('GET', `/api/workshop/channels/${cid}/agents/${leadId}/memories`)
    check('私有记忆保存 + 成员列表', mine.length > 0 && mine.some(x => x.title === `记忆-${stamp}`))
    const hit = await api('POST', `/api/workshop/channels/${cid}/agents/${leadId}/memories/search`, { query: '7f3k9' })
    check('记忆检索命中', Array.isArray(hit) && hit.length > 0)
    const team = await api('GET', `/api/workshop/channels/${cid}/memories`)
    check('团队记忆列表(shared 落 __team__ 域可见)', team.length > 0 && team.some(x => x.title === `共享-${stamp}`))
    if (mine[0]?.id) {
      await api('DELETE', `/api/workshop/channels/${cid}/agents/${leadId}/memories/${mine[0].id}`)
      const after = await api('GET', `/api/workshop/channels/${cid}/agents/${leadId}/memories`)
      check('记忆删除生效', !after.some(x => x.id === mine[0].id))
    }
  }

  // ===== 7. 事件流 =====
  console.log('\n--- 7. 事件流 ---')
  {
    const ev = await api('GET', `/api/workshop/channels/${cid}/events?limit=50`)
    const types = new Set((ev.items ?? []).map(e => e.type))
    check('事件流含任务/消息事件', types.has('task.status') && types.has('a2a.message'))
    check('事件流 maxSeq 对齐', (ev.maxSeq ?? 0) > 0)
  }

  // ===== 8. 终端 API + 终端 WS =====
  console.log('\n--- 8. 终端(镜像/控制通道) ---')
  {
    const terms = await api('GET', `/api/workshop/channels/${cid}/terminals`)
    check('GET terminals:mock 成员无 omp 进程 → 空列表', Array.isArray(terms) && terms.length === 0)
    const e1 = await expectTermError(`${WS_BASE}/api/system/monitor/terminal/ws`)
    check('终端 WS 无 token → term.error + close 4401', e1.closeCode === 4401 && e1.errCode === 'USER_UNAUTHORIZED')
    const e2 = await expectTermError(`${WS_BASE}/api/system/monitor/terminal/ws?token=${TOKEN}&pid=999999`)
    check('终端 WS 未知 pid → NO_SESSION + close 4404', e2.closeCode === 4404 && e2.errCode === 'NO_SESSION')
    const e3 = await expectTermError(`${WS_BASE}/api/system/monitor/terminal/ws?token=${TOKEN}&agentId=${leadId}&channelId=${cid}`)
    check('终端 WS mock agent(无 omp 进程)→ NO_SESSION + close 4404', e3.closeCode === 4404 && e3.errCode === 'NO_SESSION')
    const e4 = await expectTermError(`${WS_BASE}/api/system/monitor/terminal/ws?token=${TOKEN}`)
    check('终端 WS 缺 pid/agentId → BAD_PID + close 4400', e4.closeCode === 4400 && e4.errCode === 'BAD_PID')
  }

  // ===== 9. 用户隔离(第二用户越权) =====
  console.log('\n--- 9. 用户隔离 ---')
  {
    const reg = await raw('POST', '/api/users/register', {
      name: `suite-u2-${stamp}`, email: `u2-${stamp}@suite.test`, password: 'Suite-Pass-123',
    })
    const u2tok = reg.data?.token ?? reg.data?.user?.token
    if (reg.status === 200 && u2tok) {
      const cross = await raw('GET', `/api/workshop/channels/${cid}`, null, u2tok)
      check('第二用户访问他人 channel → 403/404(隔离)', cross.status === 403 || cross.status === 404, `status=${cross.status}`)
      const cross2 = await raw('POST', `/api/workshop/channels/${cid}/tasks`, { title: 'x' }, u2tok)
      check('第二用户向他人 channel 提交任务 → 拒绝', cross2.status === 403 || cross2.status === 404)
    }
    else {
      check('注册第二用户(依赖可注册)', reg.status === 200, `status=${reg.status}`)
    }
  }

  // ===== 10. 清理 + 删除后状态 =====
  console.log('\n--- 10. 清理 ---')
  {
    const ghost = await raw('GET', '/api/workshop/channels/00000000-0000-0000-0000-000000000000')
    check('GET 不存在的 channel → 404', ghost.status === 404)
    await api('DELETE', `/api/workshop/channels/${cid}`)
    const gone = await raw('GET', `/api/workshop/channels/${cid}`)
    check('DELETE 后 channel → 404(级联清理)', gone.status === 404)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('API 套件异常:', err.message)
  process.exit(1)
})
