/**
 * 真实场景端到端实测:『产品 v2.5 发布准备团队』(omp + glm-5-turbo):
 *  - 场景:双 worker 协作 —— 撰写员产出发布说明草稿 → 检查员核对并给 GO/NO-GO
 *  - API 断言:场景/角色 prompt 注入、双 worker 参与作业、防重复、goal 结语、
 *              中文+要点交付、邮件协作留痕、supervise 节流
 *  - UI 监控(puppeteer):实时观测时间线块累积(单调不减)、类型分发(task/artifact/
 *              message 等分块渲染)、无重复渲染、交付块可展开、header 航迹存在
 * 运行:node scripts/test-real-scenario.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const PROVIDER = 'zhipu-coding-plan'
const MODEL = 'glm-5-turbo'
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const SCENARIO = [
  '本团队为「Acme 产品 v2.5」发布做准备。所有 Agent 必须遵守:',
  '1. 所有交付使用中文,结构化要点(- 开头),不超过 120 字',
  '2. 每份最终交付的最后一行必须是指定标记 [READY] 或 [BLOCKED]',
  '3. 结论必须明确,不含糊;不编造数据,引用上游产出时保留其标记',
].join('\n')

async function main() {
  mkdirSync('data/shots', { recursive: true })

  // ═══ 1. 组队(API) ═══
  const email = `release-e2e-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `release-e2e-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  const token = reg.data?.token ?? reg.token
  if (!token) throw new Error('注册失败')

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'v2.5-release-team',
      scenarioPrompt: SCENARIO,
      leadAgent: { name: 'release-lead', harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
    token,
  })
  if (ch.code !== 0) throw new Error('channel 创建失败: ' + JSON.stringify(ch).slice(0, 140))
  const channelId = ch.data.channelId

  const w1 = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'draft-writer',
      harness: 'omp',
      role: 'worker',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a senior release-note writer. You ALWAYS write deliverables as Chinese markdown bullet points (- item), concise and factual. Your final line is a status marker like [READY].',
      },
    },
    token,
  })
  const w2 = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'release-checker',
      harness: 'omp',
      role: 'worker',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a release readiness checker. You verify upstream deliverables and always end with an explicit GO or NO-GO verdict line in Chinese, followed by the status marker [READY] or [BLOCKED].',
      },
    },
    token,
  })
  if (w1.code !== 0 || w2.code !== 0) throw new Error('worker 创建失败')
  check('团队就绪(omp lead + 撰写员 + 检查员)', true, `channel=${channelId.slice(0, 8)}`)

  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'release-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${channelId}`, { token })

  const tasksOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  const eventsOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/events?limit=800`, { token })).data?.items ?? []

  // ═══ 2. 提交 GOAL 任务并打开前端监控 ═══
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'v2.5-release-readiness',
      description: '[mode:goal][criteria:最终交付包含中文发布说明要点与明确的 GO 或 NO-GO 结论] 先让撰写员 draft-writer 产出 v2.5 发布说明草稿(3-5 个要点,末行 [READY]);再让检查员 release-checker 核对草稿,给出 GO/NO-GO 结论(末行 [READY] 或 [BLOCKED])。你汇总两者的产出为最终交付。',
    },
    token,
  })
  const parentId = task.data?.id
  if (!parentId) throw new Error('任务提交失败')
  console.log('  任务已提交,打开前端监控…')

  // ── puppeteer 前端实时监控 ──
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,900'],
    defaultViewport: { width: 1500, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  // 登录门 → 表单登录(点击进入控制台后等 SPA 导航完成再校验 URL)
  let inConsole = false
  for (let attempt = 0; attempt < 2 && !inConsole; attempt++) {
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        await sleep(2500)
        inConsole = page.url().includes('/workshop/w/')
        break
      }
    }
    if (inConsole) break
    const emailInput = await page.$('input[type="email"]')
    if (!emailInput) break
    await emailInput.type(email, { delay: 8 })
    const pwd = await page.$('input[type="password"]')
    await pwd.type('Passw0rd!123', { delay: 8 })
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.replace(/\s/g, '') === '登录') {
        await b.click()
        break
      }
    }
    await sleep(2200)
  }
  check('前端登录并进入控制台', inConsole, page.url().slice(-40))
  await sleep(2500)

  // header 航迹(新功能)存在
  const trailNodes = await page.$$eval('.trail-node', els => els.length).catch(() => 0)
  check('header 航迹导航渲染', trailNodes >= 1, `nodes=${trailNodes}`)

  // 监控循环:块数单调不减 + 类型采样
  const samples = []
  const kinds = new Set()
  let monotonic = true
  const deadline = Date.now() + 720_000
  let finalState = ''
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      blocks: document.querySelectorAll('.event-block').length,
      kinds: [...document.querySelectorAll('.event-block .kind')].map(e => e.textContent.trim()),
    })).catch(() => null)
    if (snap) {
      if (samples.length && snap.blocks < samples[samples.length - 1].blocks) monotonic = false
      samples.push({ t: Date.now(), blocks: snap.blocks })
      snap.kinds.forEach(k => kinds.add(k))
    }
    const st = (await tasksOf().catch(() => [])).find(t => t.id === parentId)?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) {
      finalState = st
      break
    }
    await sleep(4000)
  }
  // 宽限:子任务全完成、父任务最终汇总轮进行中的常见尾延(模型延迟波动)
  if (!finalState) {
    for (let i = 0; i < 12; i++) {
      const st = (await tasksOf().catch(() => [])).find(t => t.id === parentId)?.state ?? ''
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) {
        finalState = st
        break
      }
      await sleep(5000)
    }
  }
  const blockSamples = samples.map(s => s.blocks)
  check('时间线实时块渲染(有块且持续更新)', samples.length > 0 && Math.max(...blockSamples, 0) >= 8, `peak=${Math.max(...blockSamples, 0)}, 采样${samples.length}次`)
  check('块数单调不减(无重复消费/重置)', monotonic, `${blockSamples.slice(0, 8).join('→')}…`)
  check('类型化分发渲染(task/artifact 等各自成块)', kinds.has('task') && kinds.has('artifact'), [...kinds].join(','))
  check('成员/生命周期事件入轨', kinds.has('team') || kinds.has('state') || kinds.has('event'), '')

  if (samples.length > 2) await page.screenshot({ path: 'data/shots/real-scenario-live.png' })

  // ═══ 3. API 侧协作逻辑断言 ═══
  check('goal 父任务完成', finalState === 'COMPLETED', `state=${finalState}`)

  const tasks = await tasksOf()
  const children = tasks.filter(t => t.parentId === parentId)
  check('子任务派发(≥2,两名 worker 均参与)', children.length >= 2 && new Set(children.map(c => c.assigneeId)).size >= 2, `children=${children.length}, assignees=${new Set(children.map(c => c.assigneeId)).size}`)

  const active = children.filter(c => ['ASSIGNED', 'WORKING', 'WAITING'].includes(c.state))
  const titles = children.map(c => c.title.replace(/\s+/g, ' ').trim().toLowerCase())
  const dupCount = titles.filter((t, i) => titles.indexOf(t) !== i).length
  // 同标题重派仅在"前次完成且无交付"时被守卫放行(有交付会 409 拒绝,由 test-collab-e2e 专项证明);
  // 此处断言终态无在途 + 记录重派数供观察
  check('无并发在途重复(终态在途为 0)', active.length === 0, `active=${active.length}, 同标题重派=${dupCount}(设计允许:前次无交付)`)

  const doneChildren = children.filter(c => c.state === 'COMPLETED' && (c.artifacts?.length ?? 0) > 0)
  check('worker 子任务完成且带交付', doneChildren.length >= 2, `done=${doneChildren.length}`)

  const parent = tasks.find(t => t.id === parentId)
  const parentText = JSON.stringify(parent?.artifacts ?? '')
  check('父任务含 goal 结语交付(GO/NO-GO 判定)', (parent?.artifacts?.length ?? 0) > 0 && /GO/i.test(parentText), parentText.slice(0, 100))

  // 场景遵守抽查:worker 交付含中文
  const cjk = s => /[\u4e00-\u9fff]/.test(s)
  const childText = JSON.stringify(doneChildren.map(c => c.artifacts))
  check('交付使用中文(场景规范 1)', cjk(childText), '')

  // 邮件协作留痕:agent 间通信事件(agent.message / agent.status.message / a2a.message)
  const evs = await eventsOf()
  const members = (await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })).data ?? []
  const leadId = (members.find(m => m.role === 'lead') ?? {}).id ?? ch.data.leadAgentId
  const mailEvents = evs.filter(e => ['agent.message', 'agent.status.message', 'a2a.message'].includes(e.type)).length
  check('邮件流含协作记录(团队知情)', mailEvents >= 4, `mail events=${mailEvents}`)

  // supervise 回合信号:lead 的 status.message(派发指令 + supervise 摘要);
  // 健康节奏 ≈ 8-10 条/分钟(每子任务状态迁移触发一轮);指纹节流防的是无变化忙轮转
  // (那会是数百条)。界限 60 = 健康值的 2 倍余量,仍能捕获失控场景。
  const leadSuperviseMsgs = evs.filter(e => e.type === 'agent.status.message' && e.agentId === leadId).length
  const byAgent = evs
    .filter(e => e.type === 'agent.message' || e.type === 'agent.status.message')
    .reduce((acc, e) => {
      const k = e.agentId?.slice(0, 8) ?? 'system'
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {})
  check('supervise 轮数受节流控制(lead 状态摘要)', leadSuperviseMsgs < 60, `lead supervise=${leadSuperviseMsgs}, 消息分布=${JSON.stringify(byAgent)}, 总事件=${evs.length}`)

  // ═══ 4. 前端最终渲染断言 ═══
  await sleep(2500)
  const finalBlocks = await page.$$eval('.event-block', els => els.length).catch(() => 0)
  const artifactCards = await page.$$eval('.event-block', els =>
    els.filter(e => e.querySelector('.kind')?.textContent.trim() === 'artifact').length,
  ).catch(() => 0)
  const errorBlocks = await page.$$eval('.event-block', els =>
    els.filter(e => e.querySelector('.kind')?.textContent.trim() === 'error').length,
  ).catch(() => -1)
  check('终态块渲染(数量稳定)', finalBlocks >= artifactCards && finalBlocks > 0, `blocks=${finalBlocks}, artifacts=${artifactCards}`)
  check('交付块(artifact)渲染', artifactCards >= 2, `=${artifactCards}`)
  check('无 error 块', errorBlocks === 0, `=${errorBlocks}`)
  await page.screenshot({ path: 'data/shots/real-scenario-final.png' })
  await browser.close()

  // ═══ 5. 失败诊断转储(任务状态时间线 + Agent 消息节选) ═══
  if (failures > 0) {
    console.log('\n━━━ 失败诊断(channel 保留待查)━━━')
    console.log(`channelId: ${channelId}`)
    const all = await tasksOf()
    for (const t of all) {
      console.log(`  [task] ${t.id.slice(0, 8)} parent=${t.parentId?.slice(0, 8) ?? '-'} state=${t.state} progress=${t.progress}% title=${t.title}`)
    }
    for (const e of evs.filter(e => e.type === 'task.status').slice(-16)) {
      const p = e.payload ?? {}
      console.log(`  [status] seq=${e.seq} ${e.at.slice(11, 19)} ${p.state} task=${p.taskId ?? e.taskId ?? '-'}`)
    }
    for (const e of evs.filter(e => e.type === 'agent.message').slice(-8)) {
      const p = e.payload ?? {}
      const text = String(p.parts ?? p.text ?? '').slice(0, 150)
      console.log(`  [msg] seq=${e.seq} agent=${e.agentId?.slice(0, 8)} ${text}`)
    }
  }
  else {
    // 清理
    const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
    for (const m of members.data ?? []) {
      await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: m.id }, token }).catch(() => {})
    }
    await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})
  }

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
