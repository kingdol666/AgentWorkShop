/**
 * 并行执行机制验证(omp harness,双 Channel,固定场景最小 token):
 *  - 注册独立用户;建 lead/worker 两个 omp 模板 + 编组
 *  - 建 2 个 channel(不带 lead)-> deployTeam 部署编组(1 lead + 1 worker)
 *  - 各自 workspace 预置 task.txt(内容不同,顺带验证隔离)
 *  - 同一时刻提交两个极简固定任务(读 task.txt 原样交付,禁多余动作)
 *  - 采样任务状态时间线,断言:两 channel 的 WORKING 窗口重叠(真并行)
 *  - 断言:交付物各自含自己 workspace 的 marker(不串目录)
 */
const BASE = 'http://localhost:3000'
const OMP = { provider: 'zhipu-coding-plan', model: 'glm-5.2' }
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
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6)
const log = m => console.log(`[${stamp()}s] ${m}`)
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  // 1. 用户 + 模板 + 编组
  const user = await post('/api/workshop/users/register', { name: `par-${Date.now()}` })
  const T = user.token
  const leadTpl = await post('/api/workshop/agents', { name: 'par-lead', harness: 'omp', config: { ...OMP, superviseTimeoutMs: 45000 } }, T)
  const wTpl = await post('/api/workshop/agents', { name: 'par-worker', harness: 'omp', config: { ...OMP, promptTimeoutMs: 60000 } }, T)
  const team = await post('/api/workshop/teams', { name: '并行验证组' }, T)
  await post(`/api/workshop/teams/${team.id}/members`, { agentId: leadTpl.id, role: 'lead' }, T)
  await post(`/api/workshop/teams/${team.id}/members`, { agentId: wTpl.id, role: 'worker' }, T)
  log(`编组就绪(1 lead + 1 worker)`)

  // 2. 两个 channel(无 lead 创建,由编组部署带来)+ 部署
  const mk = async (label, marker) => {
    const ch = await post('/api/workshop/channels', { name: `par-${label}` }, T)
    await post(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.channelId }, T)
    // 各自 workspace 预置 task.txt(内容不同)
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(ch.workspace, { recursive: true })
    writeFileSync(`${ch.workspace}/task.txt`, `MARKER=${marker}\n`, 'utf8')
    return ch
  }
  const chA = await mk('A', 'PARALLEL-ALPHA-777')
  const chB = await mk('B', 'PARALLEL-BRAVO-313')
  log(`双 channel 部署完成: A=${chA.channelId.slice(0, 8)} B=${chB.channelId.slice(0, 8)}`)

  // 3. 固定场景 prompt(极简,最小 token):读 task.txt -> 原样交付
  const desc = [
    '固定测试场景,严格照做,禁止任何其他动作:',
    '1) 用 read 工具读取当前目录下的 task.txt(就一行文本);',
    '2) 把读到的原文(含 MARKER= 的那一行)原样作为 complete_task 的 deliverable 提交,summary 写"done"。',
    '不要读写其他文件,不要搜索记忆,一次完成。',
  ].join('\n')

  // 4. 同时提交(同一 tick 内先后 <50ms)
  const [taskA, taskB] = await Promise.all([
    post(`/api/workshop/channels/${chA.channelId}/tasks`, { title: '读文件A', description: desc }, T),
    post(`/api/workshop/channels/${chB.channelId}/tasks`, { title: '读文件B', description: desc }, T),
  ])
  log(`两任务同时提交: A=${taskA.id.slice(0, 8)} B=${taskB.id.slice(0, 8)}`)

  // 5. 采样状态时间线(500ms 粒度;终态或超时停止)
  const timeline = { A: [], B: [] }
  const windows = { A: null, B: null }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const [a, b] = await Promise.all([
      get(`/api/workshop/channels/${chA.channelId}/tasks`, T),
      get(`/api/workshop/channels/${chB.channelId}/tasks`, T),
    ])
    const stA = (a.find(t => t.id === taskA.id) ?? {}).state
    const stB = (b.find(t => t.id === taskB.id) ?? {}).state
    if (stA && stA !== timeline.A.at(-1)?.[1]) {
      timeline.A.push([Date.now() - t0, stA])
      if (stA === 'WORKING') windows.A = Date.now() - t0
    }
    if (stB && stB !== timeline.B.at(-1)?.[1]) {
      timeline.B.push([Date.now() - t0, stB])
      if (stB === 'WORKING') windows.B = Date.now() - t0
    }
    const doneA = ['COMPLETED', 'FAILED', 'CANCELED'].includes(stA)
    const doneB = ['COMPLETED', 'FAILED', 'CANCELED'].includes(stB)
    if (doneA && doneB) break
    await sleep(500)
  }

  for (const [k, tl] of Object.entries(timeline)) log(`Channel ${k} 状态时间线: ` + tl.map(([t, s]) => `${t / 1000 | 0}s=${s}`).join(' -> '))

  // 6. 断言:并行 + 隔离
  const [finA, finB] = await Promise.all([
    get(`/api/workshop/tasks/${taskA.id}`, T),
    get(`/api/workshop/tasks/${taskB.id}`, T),
  ])
  const textOf = t => (t.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => p.text ?? '').join(' ')
  check('A 任务 COMPLETED', finA.state === 'COMPLETED', finA.state)
  check('B 任务 COMPLETED', finB.state === 'COMPLETED', finB.state)
  check('A 交付含 ALPHA marker', textOf(finA).includes('PARALLEL-ALPHA-777'), textOf(finA).slice(0, 80))
  check('B 交付含 BRAVO marker', textOf(finB).includes('PARALLEL-BRAVO-313'), textOf(finB).slice(0, 80))
  check('A 交付不含 B marker(目录隔离)', !textOf(finA).includes('BRAVO'))
  check('B 交付不含 A marker(目录隔离)', !textOf(finB).includes('ALPHA'))

  // 并行判定:两者几乎同时进入 WORKING(启动差 < 8s,且都在对方完成前开工)
  const overlap = windows.A != null && windows.B != null && Math.abs(windows.A - windows.B) < 8000
  check('双 channel WORKING 启动窗口重叠(并行执行)', overlap, `A@${(windows.A / 1000 || 0).toFixed(1)}s B@${(windows.B / 1000 || 0).toFixed(1)}s`)

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
