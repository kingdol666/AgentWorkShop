#!/usr/bin/env node
/**
 * project-terminate-live.mjs —— 人类交互/消息队列/终止运行 实机验收（REST 驱动）。
 *
 * 链路：
 *   ① 蓝图一键实例化（本体+工艺两频道，technical，免批）→ active
 *   ② dispatch W1（mock 快速完成）→ submit → review → dispatch W2（RUNNING 在飞）
 *   ③【人类交互+队列】owner 向办公室频道连发 3 条 task 消息（进 leader 队列）
 *      → 轮询消费：3 条全部 consumed 且 consumed_at 顺序 = created_at 顺序（FIFO pop）
 *      → leader 产生回复（≥1 条，fromLabel/agent 归属）
 *   ④【Channel 状态可见面】projectSnapshot.channels[].rootTasks 透出 W2 在飞 root 任务态
 *   ⑤【终止】POST /projects/:id/terminate → 全部工作项 CANCELED + root 任务 CANCELED
 *      + 待批审批过期 + 项目 canceled；snapshot.rootTasks 清空
 *
 * 用法：node scripts/_audit/project-terminate-live.mjs --base http://127.0.0.1:3580
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3580').replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-terminate-live`)))

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 300) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 170)}`)
  return ok
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000, agentToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...((agentToken ? { authorization: `Bearer ${agentToken}`, 'x-aw-agent-token': agentToken } : (token ? { authorization: `Bearer ${token}` } : {}))),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}

async function main() {
  const setup = await api('GET', '/api/users/setup-status')
  if (setup.data?.needsSetup) {
    const reg = await api('POST', '/api/users/register', { name: 'pilot', email: 'admin@awshop.local', password: 'admin123' })
    token = reg.data?.token ?? ''
  } else {
    const lg = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
    token = lg.data?.token ?? ''
  }
  if (!step('S1-auth', Boolean(token), 'admin token ok')) return finish(false)

  // ① 蓝图一键实例化（两频道：本体→工艺）
  const tplName = `终止验收模板-${randomUUID().slice(0, 5)}`
  await api('POST', '/api/workshop/project-blueprints', {
    name: tplName,
    blueprint: {
      name: '终止验收会话', objective: '终止级联实机验收', routingPolicy: 'technical', planApprovalRequired: false,
      leaderHarness: 'omp', leaderProvider: 'lm-studio', leaderModel: 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2',
      channels: [
        { key: 'ont', name: '本体频道', charter: 'c1', leadHarness: 'mock', leadConfig: { delayMs: 600000 } },
        { key: 'proc', name: '工艺频道', charter: 'c2', leadHarness: 'omp', leadConfig: { provider: 'lm-studio', model: 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2' } },
      ],
      plan: {
        deliverables: [
          { key: 'd1', name: '守卫工件', channelKey: 'ont' },
          { key: 'd2', name: '寻优报告', channelKey: 'proc' },
        ],
        work_items: [
          { key: 'w1', title: 'W1 守卫编译', deliverableKey: 'd1', channelKey: 'ont' },
          { key: 'w2', title: 'W2 工艺寻优', deliverableKey: 'd2', channelKey: 'proc' },
        ],
      },
    },
  })
  const inst = await api('POST', '/api/workshop/projects/instantiate', { template: tplName })
  const pid = inst.data?.projectId
  if (!step('S2-instantiate', inst.data?.status === 'active', `project=${pid} status=${inst.data?.status}`)) return finish(false)
  const office = (await api('GET', `/api/workshop/projects/${pid}/snapshot`)).data?.project?.officeChannelId
  const leader = (await api('GET', `/api/workshop/projects/${pid}`)).data?.leadAgentId
  if (!office || !leader) return finish(false)

  // ② W1 全链 → W2 在飞
  const snap = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const items = snap.data?.workItems ?? []
  const w1 = items.find(x => x.title.startsWith('W1'))?.id
  const w2 = items.find(x => x.title.startsWith('W2'))?.id
  if (!w1 || !w2) {
    console.error('titles:', JSON.stringify(items.map(x => x.title)))
    return finish(false)
  }
  const cidByKey = inst.data?.channelIdByKey ?? {}
  const ont = { cid: cidByKey.ont, leadId: (await api('GET', `/api/workshop/channels/${cidByKey.ont}/agents`)).data?.find(a => a.role === 'lead')?.id }
  const proc = { cid: cidByKey.proc, leadId: (await api('GET', `/api/workshop/channels/${cidByKey.proc}/agents`)).data?.find(a => a.role === 'lead')?.id }
  await api('POST', `/api/workshop/projects/${pid}/work-items/${w1}/dispatch`)
  const doneW1 = await waitRootDone(pid, w1, { cid: ont.cid, leadId: ont.leadId }, 180_000)
  if (!step('S3a-root-done-W1', doneW1.ok, doneW1.detail)) return finish(false)
  // W2 派发 → 在飞（本脚本主体=队列/可见面/终止级联；submit→review 全链已由
  // blueprint-live 17/17 覆盖，此处不再依赖 reconcile-draft 时序）
  const dW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  if (!step('S3-W2-dispatched', dW2.status === 200, `W2 dispatch=${dW2.status} ${dW2.message}`)) return finish(false)
  // 派发后 400ms 抓 Channel 可见面（rootTasks 应含 W2 在飞条目）
  await sleep(400)
  const snapInflight = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const chsInflight = snapInflight.data?.channels ?? []
  const w2Root = chsInflight.flatMap(c => c.rootTasks ?? []).find(rt => rt.workItemId === w2)
  step('S7-channel-rootTasks-visible', Boolean(w2Root?.taskId), `rootTasks 含 W2: taskId=${String(w2Root?.taskId ?? '').slice(0, 8)} taskState=${w2Root?.taskState}`)

  // ③【终止】派发后立刻级联（W2 root 处于 SUBMITTED/WORKING → cancelTree 真实取消）
  const term = await api('POST', `/api/workshop/projects/${pid}/terminate`, { reason: '实机终止验收' })
  if (!step('S8-terminate-call', term.status === 200 && term.data?.status === 'canceled', `terminate=${term.status} status=${term.data?.status}`)) return finish(false)
  const snap3 = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const items3 = snap3.data?.workItems ?? []
  const w1After = items3.find(x => x.id === w1)
  const w2After = items3.find(x => x.id === w2)
  const w2Settled = w2After.state === 'CANCELED' || w2After.state === 'COMPLETED'
  step('S9-cascade', w2Settled && w1After.state === 'COMPLETED' && w2After.state === 'CANCELED', `W1=${w1After.state}（完成态保留）W2=${w2After.state}（${w2After.state === 'CANCELED' ? '在飞级联取消 ✔' : 'mock 先完成'}）`)
  const chs3 = snap3.data?.channels ?? []
  const noInflight = chs3.every(c => (c.rootTasks ?? []).length === 0 && (c.inFlight ?? 0) === 0)
  step('S10-channels-clean', noInflight, '终止后各频道无在飞（rootTasks 清空）')
  const aps = await api('GET', `/api/workshop/projects/${pid}/approvals`)
  const apRows = aps.data?.approvals ?? aps.data ?? []
  const stillPending = apRows.filter(a => a.status === 'pending').length
  step('S11-approvals-expired', stillPending === 0, `终止后待批审批 ${stillPending} 项`)
  const detail = await api('GET', `/api/workshop/projects/${pid}`)
  const resumeLike = await api('POST', `/api/workshop/projects/${pid}/resume`)
  step('S12-terminal-state', detail.data?.status === 'canceled' && resumeLike.status === 409, `status=${detail.data?.status} resume=${resumeLike.status}（终态不可恢复）`)

  // ④【人类交互+队列】终止后办公室频道 leader 仍在线：owner 连发 3 条 task 消息 → FIFO pop
  const sentIds = []
  for (const i of [1, 2, 3]) {
    const m = await api('POST', `/api/workshop/channels/${office}/messages`, {
      toAgentId: leader, text: `owner 问题${i}：请评估当前进度并汇报`, fromLabel: 'owner', priority: 'task', requireReply: true,
    })
    sentIds.push(String(m.data?.messageId ?? m.data?.id ?? i))
  }
  step('S4-queue-send', sentIds.length === 3, '3 条消息已入 leader 队列（task 优先级+requireReply）')
  let fifoOk = false, consumedCount = 0, replyCount = 0
  for (let i = 0; i < 60; i++) {
    await sleep(4000)
    const ms = await api('GET', `/api/workshop/channels/${office}/messages?limit=50`)
    const arr = ms.data?.messages ?? ms.data ?? []
    const norm = arr.map(m => {
      // parts 可能是 JSON 字符串或已解析数组——统一解析出纯文本（String(array) 会变 [object Object]）
      let parts = m.parts_json ?? m.parts ?? []
      if (typeof parts === 'string') { try { parts = JSON.parse(parts) } catch { parts = [{ text: parts }] } }
      if (!Array.isArray(parts)) parts = []
      const text = parts.map(p => p.text ?? '').join('')
      return {
        id: m.id ?? m.messageId,
        from: m.from_agent_id ?? m.fromAgentId ?? '',
        state: m.state ?? '',
        consumed: m.consumed_at ?? m.consumedAt ?? null,
        created: m.created_at ?? m.createdAt ?? '',
        text,
      }
    })
    const mine = norm.filter(m => m.text.includes('owner 问题'))
    const pending = mine.filter(m => m.state === 'pending')
    consumedCount = mine.length - pending.length
    replyCount = norm.filter(m => m.from === leader && !m.text.includes('owner 问题')).length
    if (mine.length >= 3 && pending.length === 0) {
      const ordered = [...mine].sort((a, b) => a.created.localeCompare(b.created))
      const consumedAts = ordered.map(m => String(m.consumed))
      fifoOk = consumedAts.filter(Boolean).length >= 3 && consumedAts.slice(1).every((c, idx) => c >= consumedAts[idx])
      break
    }
  }
  step('S5-queue-fifo-pop', fifoOk && consumedCount >= 3, `队列消费 ${consumedCount}/3，FIFO 顺序=${fifoOk}`)
  step('S6-leader-activity', replyCount >= 1, `leader 消息/回复 ${replyCount} 条（omp leader 桥消费）`)

  finish(steps.every(s => s.ok))
}

/** 确定性驱动 root：等 mock 领取(WORKING) → lead token 完成(带 artifact) → reconcile 收敛 draft。
 * mock 的自由发挥（延迟/停滞/input-only 抢完成）不再影响验收时序。 */
async function waitRootDone(pid, workItemId, force, timeoutMs = 180_000) {
  const t0 = Date.now()
  let done = false
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000)
    const chain = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${workItemId}`)
    const cd = chain.data ?? {}
    const attempt = (cd.attempts ?? []).find(x => !x.closedAt) ?? (cd.attempts ?? [])[0]
    const taskId = attempt?.channelTaskId ?? cd.task?.id
    if (!taskId) continue
    const task = await api('GET', `/api/workshop/tasks/${taskId}`)
    const st = task.data?.state
    if (st === 'COMPLETED') { done = true; break }
    if (st !== 'WORKING') continue
    const agentToken = await leadToken(force)
    if (!agentToken) continue
    const done2 = await api('POST', `/api/workshop/tasks/${taskId}/complete`, {
      artifacts: [{ artifactId: `a-${workItemId}`, name: 'out.html', parts: [{ text: '<html>ok</html>' }] }],
    }, 30_000, agentToken)
    if (done2.status === 200) { done = true; break }
    await sleep(1500)
  }
  if (!done) return { ok: false, detail: `驱动超时(${timeoutMs}ms)` }
  for (let i = 0; i < 10; i++) {
    await api('POST', `/api/workshop/projects/${pid}/reconcile`)
    const items = await api('GET', `/api/workshop/projects/${pid}/work-items`)
    const wi = (items.data?.workItems ?? items.data ?? []).find(x => x.id === workItemId)
    if (wi?.state === 'COMPLETED') return { ok: true, detail: 'work item=COMPLETED（确定性驱动）' }
    await sleep(1500)
  }
  return { ok: false, detail: 'root 完成 but 工作项未收敛' }
}

async function leadToken(ch) {
  const rot = await api('POST', `/api/workshop/channels/${ch.cid}/agents/${ch.leadId}/rotate-token`, {})
  return rot.data?.token ?? rot.data?.newToken ?? ''
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'terminate-live.json'), JSON.stringify({ at: new Date().toISOString(), base, verdict, steps }, null, 2))
  const md = [`# 终止/队列/交互 实机验收 · ${verdict}`, '', `- base=${base}`, ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), ''].join('\n')
  writeFileSync(join(outDir, 'terminate-live.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => {
  console.error(`FAIL: ${err?.message ?? err}`)
  finish(false)
})
