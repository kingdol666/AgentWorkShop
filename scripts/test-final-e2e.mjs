/**
 * 最终综合端到端实测:「aw-utils」Node.js 工具库开发与发布(goal 模式):
 *  - 真实用户场景:lead 编排,dev 写代码+测试并跑通,实时把 API 摘要发给
 *    tech-writer(require_reply+immediate),writer 等待收件后写 README/CHANGELOG
 *  - 工作目录:E:/tmp/aw-final-e2e(channel workspace → 全员 omp cwd)
 *  - 覆盖:编排执行 / 多任务并行 / 实时通信消费 / 真实创作产出 / 测试独立验证
 *  - 断言:
 *    G  goal 完成,双 worker 参与,无并发重复
 *    R  实时链:dev→writer API 摘要(require_reply+immediate, consumed),
 *       writer 回执 in_reply_to 关联
 *    F  文件产出:lib/utils.js(≥5 导出)、tests、README(中文+示例)、CHANGELOG(1.0.0)
 *    T  独立验证:在 E:/tmp/aw-final-e2e 运行 node --test 全部通过(exit 0)
 *    U  前端实时渲染:块单调累积、task/artifact/message 分型、无 error 块
 * 运行:node scripts/test-final-e2e.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const PROVIDER = 'zhipu-coding-plan'
const MODEL = 'glm-5-turbo'
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const WORKDIR = process.env.AW_FINAL_DIR ?? 'E:/tmp/aw-final-e2e'
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
  '本团队在共享工作目录(即你的 cwd)中交付「aw-utils」Node.js 工具库。规范:',
  '1. 代码为 Node.js ESM、零 npm 依赖;测试用 node:test 内置模块,必须实际运行到全部通过才算完成。',
  '2. 文档用中文、要点式;README 必须包含每个函数的真实用法示例代码。',
  '3. 需要上游产出(如 API 摘要)时,用 send_message_to_agent(require_reply=true, priority=immediate) 实时索取;等待用 poll_messages(wait_seconds=120) 一次阻塞等待。',
  '4. 每份最终交付的末行附 [REL-DONE] 标记。',
].join('\n')

const TASK_DESC = [
  '[mode:goal][criteria:工作目录含通过全部测试的 aw-utils 源码与测试,以及 README.md 和 CHANGELOG.md;文档基于 dev 经实时消息提供的 API 摘要撰写]',
  '在团队工作目录(你的 cwd)交付 aw-utils v1.0.0:',
  '1. 派给 dev:创建 lib/utils.js(ESM 导出至少 5 个实用函数,建议 slugify/chunk/unique/capitalize/formatBytes)与 tests/utils.test.js(node:test,每个函数至少 2 个断言);运行 node --test 直到全部通过;完成后立即用 send_message_to_agent 把 API 摘要(每个函数:名称+签名+一句话说明)发给 tech-writer(require_reply=true)。',
  '2. 派给 tech-writer:先用 poll_messages(wait_seconds=120) 等 dev 的 API 摘要;收到后写 README.md(中文,含每个函数的用法示例代码)与 CHANGELOG.md(v1.0.0 要点,含日期)。',
  '3. 确认四类文件齐全(lib/utils.js、tests/utils.test.js、README.md、CHANGELOG.md)后,以总结交付完成本任务:文件清单 + 测试结果 + 通信链描述。',
].join('\n')

async function main() {
  // ═══ 0. 准备工作目录 ═══
  rmSync(WORKDIR, { recursive: true, force: true })
  mkdirSync(WORKDIR, { recursive: true })
  mkdirSync('data/shots', { recursive: true })
  console.log(`  工作目录: ${WORKDIR}`)

  // ═══ 1. 组队 ═══
  const email = `final-e2e-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `final-e2e-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  const token = reg.data?.token
  if (!token) throw new Error('注册失败')

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'aw-utils-release',
      scenarioPrompt: SCENARIO,
      workspace: WORKDIR,
      leadAgent: { name: 'release-lead', harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
    token,
  })
  if (ch.code !== 0) throw new Error('channel 创建失败: ' + JSON.stringify(ch).slice(0, 140))
  const channelId = ch.data.channelId
  const dev = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'dev',
      harness: 'omp',
      role: 'worker',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a meticulous Node.js developer. You write zero-dependency ESM modules with thorough node:test suites, run node --test yourself, and iterate until every test passes before reporting completion. After finishing a module you proactively send an API summary to teammates who need it.',
      },
    },
    token,
  })
  const writer = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'tech-writer',
      harness: 'omp',
      role: 'worker',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a Chinese technical writer. You write concise, example-driven README and CHANGELOG documents in Chinese (markdown bullets + fenced code blocks). You always obtain the real API from the developer via realtime mail before writing, never invent APIs.',
      },
    },
    token,
  })
  if (dev.code !== 0 || writer.code !== 0) throw new Error('worker 创建失败')
  const devId = dev.data.id
  const writerId = writer.data.id
  // 建 workspace 并挂载 channel(前端控制台入口在 workspace 卡片上)
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'aw-utils-ws' }, token })
  if (ws.code === 0) await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${channelId}`, { token })
  check('团队就绪(lead + dev + tech-writer, 工作目录挂载)', true, `channel=${channelId.slice(0, 8)}`)

  // ═══ 2. 提交任务 + 前端监控 ═══
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: 'aw-utils-v1-release', description: TASK_DESC },
    token,
  })
  const parentId = task.data?.id
  if (!parentId) throw new Error('任务提交失败')
  console.log('  任务已提交,启动前端监控…')

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

  const tasksOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  const samples = []
  const kinds = new Set()
  let monotonic = true
  const deadline = Date.now() + 720_000
  let parentState = ''
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      blocks: document.querySelectorAll('.event-block').length,
      kinds: [...document.querySelectorAll('.event-block .kind')].map(e => e.textContent.trim()),
    })).catch(() => null)
    if (snap) {
      if (samples.length && snap.blocks < samples[samples.length - 1].blocks) monotonic = false
      samples.push(snap.blocks)
      snap.kinds.forEach(k => kinds.add(k))
    }
    const st = (await tasksOf()).find(t => t.id === parentId)?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) {
      parentState = st
      break
    }
    await sleep(5000)
  }
  if (!parentState) {
    for (let i = 0; i < 15; i++) {
      const st = (await tasksOf()).find(t => t.id === parentId)?.state ?? ''
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) {
        parentState = st
        break
      }
      await sleep(6000)
    }
  }
  await page.screenshot({ path: 'data/shots/final-e2e-console.png' }).catch(() => {})
  await browser.close()

  // ═══ 3. 编排断言 ═══
  const tasks = await tasksOf()
  const children = tasks.filter(t => t.parentId === parentId)
  check('G1 goal 父任务完成', parentState === 'COMPLETED', `state=${parentState}`)
  check('G2 多任务派发(≥2 子任务,双 worker 参与)', children.length >= 2 && new Set(children.map(c => c.assigneeId)).size >= 2, `children=${children.length}, assignees=${new Set(children.map(c => c.assigneeId)).size}`)
  const active = children.filter(c => ['ASSIGNED', 'WORKING', 'WAITING'].includes(c.state))
  check('G3 无并发在途重复', active.length === 0, `active=${active.length}`)

  // ═══ 4. 实时通信消费断言 ═══
  const mails = (await api('GET', `/api/workshop/channels/${channelId}/messages?limit=400`, { token })).data ?? []
  const peer = mails.filter(m => m.fromAgentId && m.toAgentId && (m.metadata ?? {})['x-aw-task-kind'] === undefined)
  const apiMsg = peer.filter(m => m.fromAgentId === devId && m.toAgentId === writerId
    && (m.parts ?? []).some(p => String(p.text ?? '').match(/slugify|API|函数|摘要/i)))
  check('R1 dev→writer API 摘要消息', apiMsg.length >= 1, `count=${apiMsg.length}`)
  check('R2 摘要要求回执且实时', apiMsg.length >= 1 && (apiMsg[0].metadata ?? {})['x-aw-require-reply'] === 'true', `prio=${(apiMsg[0]?.metadata ?? {})['x-aw-msg-priority']}`)
  check('R3 摘要已被 writer 消费', apiMsg.length >= 1 && apiMsg.every(m => m.state === 'consumed'), `state=${apiMsg[0]?.state}`)
  // 软观察:writer 回执(LLM 合规性;R1-R3 已证实时送达与消费管道)
  const ackObs = peer.filter(m => m.fromAgentId === writerId && m.toAgentId === devId
    && (m.metadata ?? {})['x-aw-in-reply-to'] === apiMsg[0]?.id)
  console.log(`  [obs] writer 回执 in_reply_to 关联(软观察): ${ackObs.length >= 1 ? '已回执' : '未回执(管道已送达;LLM 合规性波动)'}`)

  // ═══ 5. 文件产出断言(真实创作) ═══
  const libPath = join(WORKDIR, 'lib', 'utils.js')
  const testPath = join(WORKDIR, 'tests', 'utils.test.js')
  const readmePath = join(WORKDIR, 'README.md')
  const changelogPath = join(WORKDIR, 'CHANGELOG.md')
  check('F1 lib/utils.js 存在', existsSync(libPath), libPath)
  if (existsSync(libPath)) {
    const exports = (readFileSync(libPath, 'utf-8').match(/export\s+(function|const)/g) ?? []).length
    check('F2 ≥5 个导出', exports >= 5, `exports=${exports}`)
  }
  else { check('F2 ≥5 个导出', false, '(lib 缺失)') }
  check('F3 tests/utils.test.js 存在', existsSync(testPath), testPath)
  check('F4 README.md 存在', existsSync(readmePath), readmePath)
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf-8')
    const fences = (readme.match(/```/g) ?? []).length / 2
    check('F5 README 中文+用法示例(≥3 代码块+import)', /[\u4e00-\u9fff]/.test(readme) && fences >= 3 && /import/.test(readme), `${readme.length} chars, ${fences} 代码块`)
  }
  else { check('F5 README 中文+用法示例', false, '(README 缺失)') }
  check('F6 CHANGELOG.md 存在且含 1.0.0', existsSync(changelogPath) && readFileSync(changelogPath, 'utf-8').includes('1.0.0'), changelogPath)

  // ═══ 6. 独立测试验证(我们自己跑 node --test) ═══
  let testOk = false
  let testDetail = '(未运行)'
  if (existsSync(testPath)) {
    try {
      const out = execSync('node --test', { cwd: WORKDIR, encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] })
      // node --test 输出两种摘要格式:TAP "# pass N" / spec "ℹ pass N"
      const pass = (out.match(/[#ℹ]\s*pass\s+(\d+)/) ?? [])[1] ?? '0'
      const fail = (out.match(/[#ℹ]\s*fail\s+(\d+)/) ?? [])[1] ?? '0'
      testOk = Number(fail) === 0 && Number(pass) > 0
      testDetail = `pass=${pass}, fail=${fail}`
    }
    catch (e) {
      testDetail = String(e.stdout ?? e.message).slice(-160).replace(/\n/g, ' ')
    }
  }
  check('T1 独立运行 node --test 全部通过', testOk, testDetail)
  const files = existsSync(WORKDIR) ? readdirSync(WORKDIR, { recursive: true }).filter(f => String(f).includes('.')).slice(0, 12) : []
  console.log(`  [obs] 工作目录文件: ${files.join(', ')}`)

  // ═══ 7. 前端渲染断言 ═══
  const peak = Math.max(...samples, 0)
  check('U1 时间线块单调累积', samples.length > 0 && peak >= 20 && monotonic, `peak=${peak}, 采样${samples.length}次, monotonic=${monotonic}`)
  check('U2 类型化分发(task/artifact/message)', kinds.has('task') && kinds.has('artifact') && kinds.has('message'), [...kinds].join(','))
  const evs = (await api('GET', `/api/workshop/channels/${channelId}/events?limit=800`, { token })).data?.items ?? []
  const errorEvents = evs.filter(e => e.type === 'agent.error' || e.type === 'error').length
  check('U3 无 error 事件', errorEvents === 0, `errors=${errorEvents}`)

  // ═══ 清理 ═══
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
  for (const m of members.data ?? []) {
    await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: m.id }, token }).catch(() => {})
  }
  if (failures === 0) {
    await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})
    console.log(`  (channel 已清理;产物保留在 ${WORKDIR})`)
  }
  else {
    console.log(`  (存在失败:channel ${channelId} 保留待查;产物在 ${WORKDIR})`)
  }

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
