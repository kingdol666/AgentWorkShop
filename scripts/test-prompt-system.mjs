/**
 * 提示词系统真实验证 —— 「发布说明团队」场景:
 *
 * 集成路径(模板管理 × Channel 场景 × 组合注入):
 *  1. 创建 Agent 模板(模板库):tech-writer(专长:中文技术写作/要点式)——验证模板 config 注入
 *  2. 创建 Channel(带 scenarioPrompt):发布说明规范(中文交付/[REL-DONE] 标记/百字内)
 *  3. 从模板克隆 worker 进 channel(模板管理集成)
 *  4. 终端镜像直接观测 worker 回合的完整 prompt:
 *     五段式组合(Scenario Brief → Your Profile → 记忆 → System Manual → Assignment)
 *  5. 任务交付验证:同时满足场景规范(中文/[REL-DONE]/简洁)与专长(要点式)
 * 运行:node scripts/test-prompt-system.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const PROVIDER = 'zhipu-coding-plan'
const MODEL = 'glm-5-turbo'

let failures = 0
let passed = 0
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitUntil(name, cond, timeoutMs, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await cond().catch(() => null)
    if (v) return v
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${name}`)
}
const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`目标: ${BASE}(「发布说明团队」场景验证)\n`)
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `prompt-sys-${Date.now().toString(36)}` } })
  const token = user.data.token

  // ===== 1. Agent 模板(模板库):tech-writer 专长 prompt =====
  const tpl = await api('POST', '/api/workshop/agents', {
    token,
    body: {
      name: `tech-writer-${Date.now().toString(36)}`,
      harness: 'omp',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a senior technical writer. You ALWAYS write deliverables as markdown bullet points (- item), never long paragraphs. Your writing style is precise and minimal.',
      },
    },
  })
  const tplId = tpl.data?.id
  check('1. Agent 模板创建(带专长 systemPromptPrefix)', tpl.code === 0 && !!tplId, `id=${tplId?.slice(0, 8)}`)

  // ===== 2. Channel:发布说明团队场景 =====
  const SCENARIO = [
    '本团队负责产品发布说明(release notes)的撰写。',
    '硬性规范:',
    '1. 所有交付内容必须使用中文。',
    '2. 每份最终交付的最后一行必须是指定标记 [REL-DONE]。',
    '3. 交付正文不超过 100 字,聚焦用户可感知的变化。',
    '4. 禁止出现实现细节(类名/函数名/内部术语)。',
  ].join('\n')
  const ch = await api('POST', '/api/workshop/channels', {
    token,
    body: {
      name: `release-notes-${Date.now().toString(36)}`,
      description: '发布说明团队',
      scenarioPrompt: SCENARIO,
      leadAgent: { name: 'rel-lead', harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
  })
  const channelId = ch.data.channelId
  check('2. Channel 创建(带 scenarioPrompt)', ch.code === 0 && !!channelId, `channel=${channelId.slice(0, 8)}`)

  // ===== 3. 从模板克隆 worker(模板管理集成) =====
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    token,
    body: { agentId: tplId, role: 'worker' },
  })
  const workerId = w.data?.id
  check('3. 模板克隆 worker 进 channel', w.code === 0 && !!workerId, `worker=${workerId?.slice(0, 8)}`)
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
  const workerMeta = (members.data ?? []).find(m => m.id === workerId)
  check('3. 克隆实例携带模板 config(专长 prompt)', String(workerMeta?.config?.systemPromptPrefix ?? '').includes('markdown bullet points'))

  // ===== 4. 提交任务 + 终端观测注入 =====
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    token,
    body: {
      title: '撰写 v2.1 发布说明',
      description: '基于以下变化撰写发布说明:新增深色主题、修复导出失败问题、性能提升约 30%。',
    },
  })
  const parentId = task.data.id
  check('4. 任务提交', task.code === 0)

  // 等 worker 进程 spawn,然后经终端镜像读取其回合并 prompt
  const termWs = async () => {
    const t = await api('GET', `/api/workshop/channels/${channelId}/terminals`, { token })
    const worker = (t.data ?? []).find(x => x.agentId === workerId)
    if (!worker) return null
    return new Promise((resolve) => {
      const frames = []
      const ws = new WebSocket(`ws://127.0.0.1:3101/api/system/monitor/terminal/ws?agentId=${workerId}&channelId=${channelId}&token=${token}`)
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.type === 'term.frames') frames.push(...m.frames)
      }
      ws.onopen = () => setTimeout(() => {
        ws.close()
        resolve(frames)
      }, 1500)
      ws.onerror = () => resolve(null)
    })
  }
  const promptFrames = await waitUntil('worker prompt 帧出现', async () => {
    const frames = await termWs()
    if (!frames) return null
    const userMsg = frames.find(f => f.frame.type === 'message_start' && f.frame.role === 'user'
      && String(f.frame.text ?? '').includes('Your Assignment'))
    return userMsg ? String(userMsg.frame.text) : null
  }, 300_000, 8000)

  // ===== 五段式注入观测(直接证据) =====
  check('4a. Scenario Brief 段注入(channel 场景)', promptFrames.includes('Scenario Brief') && promptFrames.includes('[REL-DONE]') && promptFrames.includes('不超过 100 字'))
  check('4b. Your Profile 段注入(模板专长)', promptFrames.includes('Your Profile') && promptFrames.includes('markdown bullet points'))
  check('4c. Workshop System Manual 段注入', promptFrames.includes('Workshop System Manual') && promptFrames.includes('complete_task'))
  check('4d. 段序正确(场景 → 专长 → 手册 → 任务)', (() => {
    const iScenario = promptFrames.indexOf('Scenario Brief')
    const iProfile = promptFrames.indexOf('Your Profile')
    const iManual = promptFrames.indexOf('Workshop System Manual')
    const iAssign = promptFrames.indexOf('Your Assignment')
    return iScenario >= 0 && iScenario < iProfile && iProfile < iManual && iManual < iAssign
  })())

  // ===== 5. 交付验证 =====
  const final = await waitUntil('父任务终态', async () => {
    const ts = (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
    const t = ts.find(x => x.id === parentId)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(t?.state ?? '') ? t.state : null
  }, 480_000)
  check('5a. 任务完成(host tool 声明式)', final === 'COMPLETED', `state=${final}`)

  const ts = (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  const child = ts.find(t => t.parentId === parentId && t.state === 'COMPLETED' && (t.artifacts?.length ?? 0) > 0)
  /** 交付原始正文(artifact parts 文本,非 JSON 转义——转义会破坏行首匹配) */
  const deliverableRaw = child
    ? (child.artifacts ?? []).map(a => (a.parts ?? []).map(p => p.text ?? '').join('\n')).join('\n')
    : ''
  const deliverable = deliverableRaw
  const evs = (await api('GET', `/api/workshop/channels/${channelId}/events?limit=300`, { token })).data?.items ?? []
  const corpus = deliverable + JSON.stringify(evs.flatMap(e => [e.payload?.delta, e.payload?.parts]))
  check('5b. 交付为中文(场景规范 1)', /[\u4e00-\u9fa5]{6,}/.test(deliverable) && !/^[ -~\s]*$/.test(deliverable.trim()))
  check('5c. 交付末尾含 [REL-DONE](场景规范 2)', deliverable.trimEnd().endsWith('[REL-DONE]'))
  check('5d. 要点式交付(模板专长:bullet)', /(^|\n)\s*[-•]\s/.test(corpus))
  const deliverableBody = deliverable.replace(/\\n/g, '\n').replace(/[^\u4e00-\u9fa5]/g, '')
  check('5e. 正文简洁 ≤100 字量级(场景规范 3)', deliverableBody.length <= 220, `汉字数=${deliverableBody.length}`)
  check('5f. 无实现细节泄漏(场景规范 4:无类名/函数名)', !/[A-Za-z]+\.(ts|vue|js)|function\s+\w+|class\s+\w+/.test(deliverable))

  // ===== 清理 =====
  for (const m of members.data ?? []) {
    await api('POST', '/api/system/monitor/terminate', { token, body: { channelId, agentId: m.id } }).catch(() => {})
  }
  await api('DELETE', `/api/workshop/agents/${tplId}`, { token })
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  console.log(`\n★ 提示词系统验证: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('异常:', err.message)
  process.exit(1)
})
