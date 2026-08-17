/**
 * 并行执行机制验证(mock harness,零 token):
 *  - 一个编组模板(1 lead + 2 worker,mock delayMs=2000 → 单子任务约 6s 可观测窗口)
 *  - 部署到 2 个 channel;每个 channel 同时提交 2 个任务
 *  - 250ms 采样任务状态,断言三层并行:
 *      L1 跨 channel:同一采样轮 A、B 都有子任务 WORKING
 *      L2 同 channel 内:同一采样轮同 channel 有 ≥2 个子任务 WORKING(两个 worker 并发)
 *      L3 墙钟:总耗时 << 串行下界(8 个子任务 × 6s)
 *  - 断言全部任务 COMPLETED,且交付物只出现本 channel 自己成员的 id(不串 channel)
 *
 * 用法: node scripts/e2e-parallel-execution.mjs
 */
const BASE = 'http://localhost:3000'
const DELAY_MS = 2000 // mock worker 每段进度间隔 → 单任务 ≈ 3×DELAY_MS
const TASK_SECONDS = (DELAY_MS * 3) / 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))

const H = token => ({ 'content-type': 'application/json', 'authorization': `Bearer ${token}` })
const post = async (url, body, token) => {
  const res = await fetch(`${BASE}${url}`, { method: 'POST', headers: H(token), body: JSON.stringify(body) })
  const json = await res.json()
  if (json.code !== 0) throw new Error(`${url} -> ${json.code} ${json.message}`)
  return json.data
}
const get = async (url, token) => {
  const res = await fetch(`${BASE}${url}`, { headers: { authorization: `Bearer ${token}` } })
  const json = await res.json()
  if (json.code !== 0) throw new Error(`${url} -> ${json.code} ${json.message}`)
  return json.data
}

const t0 = Date.now()
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
const log = m => console.log(`[${el()}s] ${m}`)
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  // 1. 用户 + 模板 + 编组(1 lead + 2 worker,全 mock)
  const user = await post('/api/workshop/users/register', { name: `par-mock-${Date.now()}` })
  const T = user.token
  const mk = (name, extra = {}) => post('/api/workshop/agents', { name, harness: 'mock', config: { delayMs: DELAY_MS, ...extra } }, T)
  const leadTpl = await mk('par-lead')
  const w1Tpl = await mk('par-w1')
  const w2Tpl = await mk('par-w2')
  const team = await post('/api/workshop/teams', { name: '并行验证组(mock)' }, T)
  await post(`/api/workshop/teams/${team.id}/members`, { agentId: leadTpl.id, role: 'lead' }, T)
  await post(`/api/workshop/teams/${team.id}/members`, { agentId: w1Tpl.id, role: 'worker' }, T)
  await post(`/api/workshop/teams/${team.id}/members`, { agentId: w2Tpl.id, role: 'worker' }, T)
  log('编组模板就绪(1 lead + 2 worker,mock)')

  // 2. 两个 channel + 部署同一编组
  const mkCh = async (label) => {
    const ch = await post('/api/workshop/channels', { name: `par-${label}` }, T)
    await post(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.channelId }, T)
    const members = await get(`/api/workshop/channels/${ch.channelId}/agents`, T)
    return { ...ch, label, members }
  }
  const chA = await mkCh('A')
  const chB = await mkCh('B')
  log(`双 channel 部署完成: A=${chA.channelId.slice(0, 8)}(${chA.members.length} 成员) B=${chB.channelId.slice(0, 8)}(${chB.members.length} 成员)`)

  // 3. 每 channel 同时提交 2 个任务(共 4 个父任务 → 4 个子任务;每 channel 两个 worker 可并发)
  const submits = []
  for (const ch of [chA, chB]) {
    for (const n of [1, 2]) {
      submits.push(post(`/api/workshop/channels/${ch.channelId}/tasks`, {
        title: `${ch.label}-任务${n}`,
        description: `固定场景:mock 剧本执行(${ch.label}-${n})`,
      }, T).then(t => ({ ch, id: t.id })))
    }
  }
  const submitted = await Promise.all(submits)
  log(`同时提交 ${submitted.length} 个任务: ` + submitted.map(s => `${s.ch.label}/${s.id.slice(0, 6)}`).join(' '))

  // 4. 采样(250ms):统计每轮各 channel 处于 WORKING 的子任务数
  const rounds = []
  const deadline = Date.now() + 120_000
  let allDone = false
  while (Date.now() < deadline && !allDone) {
    const [a, b] = await Promise.all([
      get(`/api/workshop/channels/${chA.channelId}/tasks`, T),
      get(`/api/workshop/channels/${chB.channelId}/tasks`, T),
    ])
    const workingKids = list => list.filter(t => t.parentId && t.state === 'WORKING').length
    rounds.push({ at: Date.now() - t0, a: workingKids(a), b: workingKids(b) })
    const terminal = list => list.length > 0 && list.every(t => ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state))
    allDone = terminal(a) && terminal(b) && a.some(t => t.parentId) && b.some(t => t.parentId)
    if (!allDone) await sleep(250)
  }
  const wall = (Date.now() - t0) / 1000
  log(`两 channel 全部任务终态,墙钟 ${wall.toFixed(1)}s`)

  // 5. 结果
  const [tasksA, tasksB] = await Promise.all([
    get(`/api/workshop/channels/${chA.channelId}/tasks`, T),
    get(`/api/workshop/channels/${chB.channelId}/tasks`, T),
  ])
  const full = async list => Promise.all(list.map(t => get('/api/workshop/tasks/' + t.id, T)))
  const fullA = await full(tasksA)
  const fullB = await full(tasksB)

  console.log('\n—— 任务树 ——')
  for (const [k, list] of [['A', fullA], ['B', fullB]]) {
    for (const t of list) console.log(`  ${k} ${t.id.slice(0, 6)} parent=${(t.parentId ?? '----').slice(0, 6)} ${t.state.padEnd(9)} assignee=${t.assigneeId.slice(0, 6)} "${t.title}"`)
  }

  // 采样轮压缩打印(只打印有活动的轮次)
  console.log('\n—— 并发采样(A/B 同时 WORKING 的子任务数) ——')
  const active = rounds.filter(r => r.a || r.b)
  console.log('  ' + active.map(r => `${(r.at / 1000).toFixed(1)}s:${r.a}/${r.b}`).join('  '))

  console.log('\n—— 断言 ——')
  const states = list => list.map(t => t.state)
  check('A 全部任务 COMPLETED', states(fullA).every(s => s === 'COMPLETED'), states(fullA).join(','))
  check('B 全部任务 COMPLETED', states(fullB).every(s => s === 'COMPLETED'), states(fullB).join(','))
  check('A 产生 2 父 + 2 子任务', fullA.length === 4 && fullA.filter(t => t.parentId).length === 2, `${fullA.length} 个`)
  check('B 产生 2 父 + 2 子任务', fullB.length === 4 && fullB.filter(t => t.parentId).length === 2, `${fullB.length} 个`)

  // L1 跨 channel 并行
  const crossRounds = rounds.filter(r => r.a > 0 && r.b > 0)
  check('L1 跨 channel 并行(同一采样轮 A、B 均在执行)', crossRounds.length > 0, `${crossRounds.length} 轮`)
  // L2 同 channel 内多 worker 并行
  const intraA = rounds.filter(r => r.a >= 2).length
  const intraB = rounds.filter(r => r.b >= 2).length
  check('L2 同 channel 内两 worker 并行', intraA > 0 && intraB > 0, `A ${intraA} 轮 / B ${intraB} 轮`)
  // L3 墙钟远小于串行下界
  const serialLower = 4 * TASK_SECONDS
  check(`L3 墙钟 << 串行下界(${serialLower}s)`, wall < serialLower * 0.75, `实测 ${wall.toFixed(1)}s`)
  // 峰值并发
  const peak = Math.max(...rounds.map(r => r.a + r.b))
  check('峰值并发子任务数 ≥ 3', peak >= 3, `峰值 ${peak}`)

  // 隔离:各 channel 交付物只含自己成员 id
  const idsOf = ch => new Set(ch.members.map(m => m.agentId))
  const textOf = list => list.flatMap(t => (t.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => p.text ?? '')).join(' ')
  const foreign = (list, ownIds, otherCh) => [...idsOf(otherCh)].filter(id => textOf(list).includes(id))
  check('A 交付物不含 B 成员 id(channel 隔离)', foreign(fullA, idsOf(chA), chB).length === 0, foreign(fullA, idsOf(chA), chB).join(','))
  check('B 交付物不含 A 成员 id(channel 隔离)', foreign(fullB, idsOf(chB), chA).length === 0, foreign(fullB, idsOf(chB), chA).join(','))

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
