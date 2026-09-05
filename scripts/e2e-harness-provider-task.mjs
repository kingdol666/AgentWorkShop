/**
 * 多 Harness + 自定义 LLM provider 简单任务 E2E(一个 Channel,四种引擎)。
 *   NO_PROXY='127.0.0.1,localhost' node scripts/e2e-harness-provider-task.mjs [--base http://127.0.0.1:3001]
 *
 * P1 provider 目录:四引擎目录均含 glm-5.3-flash(可选)
 * P2 同 Channel 四 harness worker(omp=zhipu-coding-plan / codex=cc-switch /
 *    opencode=zhipuai-coding-plan / dsh=ustc;模型均 glm-5.3-flash)
 * P3 简单任务×4:真实 LLM 回合执行并 complete_task → 全部 COMPLETED(可用)
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3001'
})()
const TAG = Date.now().toString(36)
let failures = 0
let passed = 0
const results = []
const check = (id, name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ id, name, ok, detail })
  ok ? passed++ : failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, { body, token } = {}, attempt = 0) => {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, ...(await res.json().catch(() => ({}))) }
  }
  catch (err) {
    if (attempt < 10) {
      await sleep(3000)
      return api(method, path, { body, token }, attempt + 1)
    }
    throw err
  }
}

const ENGINES = [
  { key: 'omp', harness: 'omp', cfg: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash' } },
  { key: 'codex', harness: 'codex', cfg: { model: 'glm-5.3-flash', approvalPolicy: 'never' } },
  { key: 'dsh', harness: 'dsh', cfg: { provider: 'ustc', model: 'glm-5.3-flash' } },
  { key: 'opencode', harness: 'opencode', cfg: { model: 'zhipuai-coding-plan/glm-5.3-flash' } },
]

async function main() {
  console.log(`\n━━━ 多 Harness + provider 简单任务 E2E @ ${BASE} (tag=${TAG}) ━━━`)
  const reg = await api('POST', '/api/users/register', { body: { email: `hp-${TAG}@test.local`, password: 'Passw0rd!123', name: `hp-${TAG}` } })
  const token = reg.data?.token
  if (!token) throw new Error('注册失败')
  const auth = { token }

  // ── P1 provider 目录(可选性) ──
  for (const e of ENGINES) {
    const r = await api('GET', `/api/workshop/harnesses/${e.harness}/providers`, auth)
    const provs = r.data?.catalog?.providers ?? []
    const has = provs.some(p => p.models.some(m => m.id === 'glm-5.3-flash'))
    check(`P1.${e.key}`, `${e.harness} 目录含 glm-5.3-flash(可选)`, has, provs.map(p => p.id).join(',').slice(0, 60))
  }

  // ── P2 同 Channel 组建(不同 harness worker + 自定义 provider/model) ──
  const ch = (await api('POST', '/api/workshop/channels', {
    body: {
      name: `harness-mix-${TAG}`,
      leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } },
    }, ...auth,
  })).data
  const channelId = ch?.channelId
  check('P2.1', 'Channel 创建(mock lead)', Boolean(channelId))
  const workers = {}
  for (const e of ENGINES) {
    const c = await api('POST', '/api/workshop/agents', {
      body: { name: `${e.key}-${TAG}`, harness: e.harness, config: { ...e.cfg, systemPromptPrefix: '你是测试执行员:严格按任务完成,完成后立即调用 complete_task。' } }, ...auth,
    })
    workers[e.key] = c.data
    check(`P2.${e.key}-tpl`, `${e.harness} 模板(provider=${e.cfg.provider ?? 'default'},model=${e.cfg.model})`, Boolean(c.data?.id))
    const join = await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: c.data.id, role: 'worker' }, ...auth })
    if (join.code !== 0) check(`P2.${e.key}-join`, `${e.key} 入队`, false, join.message ?? '')
  }
  const members = (await api('GET', `/api/workshop/channels/${channelId}/agents`, auth)).data ?? []
  check('P2.join', '四引擎 worker 全部入队(5 成员)', members.length >= 5, `members=${members.length}`)

  // ── P3 简单任务×4(真实 LLM 回合) ──
  const tasks = {}
  for (const e of ENGINES) {
    const t = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
      body: {
        title: `smoke-${e.key}-${TAG}`,
        parts: [{ text: '请直接汇报「 Harness 冒烟测试完成」六个字所在的环境时间,然后立即调用 complete_task。不要执行任何其它操作。' }],
        assigneeId: workers[e.key].id,
      }, ...auth,
    })
    tasks[e.key] = t.data?.task?.id ?? t.data?.id
  }
  check('P3.1', '四路简单任务下发', Object.values(tasks).every(Boolean))

  const states = {}
  const deadline = Date.now() + 16 * 60_000
  while (Date.now() < deadline && Object.keys(states).length < 4) {
    const list = await api('GET', `/api/workshop/channels/${channelId}/tasks`, auth)
    for (const [k, id] of Object.entries(tasks)) {
      if (states[k]) continue
      const me = (list.data ?? []).find(x => x.id === id)
      if (me && ['COMPLETED', 'FAILED', 'CANCELED'].includes(me.state)) states[k] = me.state
    }
    await sleep(6000)
  }
  for (const e of ENGINES) {
    check(`P3.${e.key}`, `${e.harness}(glm-5.3-flash) 简单任务 COMPLETED`, states[e.key] === 'COMPLETED', `state=${states[e.key] ?? 'RUNNING'}`)
  }

  // ── 清理 ──
  await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, auth).catch(() => {})

  console.log(`\n━━━ 多 Harness provider E2E: ${passed} passed / ${failures} failed ━━━`)
  if (failures) for (const r of results.filter(x => !x.ok)) console.log(`  ${r.id} ${r.name} — ${r.detail}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
