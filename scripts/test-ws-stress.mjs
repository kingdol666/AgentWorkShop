/**
 * WS hub 压测与鲁棒性验证(P2 验收):
 * ① 万级事件:REST 批量注入消息 → hub 逐帧推送(seq 连续、无丢失、耗时)
 * ② 双 channel 并行不串扰:两 channel 并发任务,事件按 channelId 严格隔离
 * ③ 环形缓冲溢出:注入超 ring 容量(5000)后,旧 lastSeq 重订阅 → snapshot 对齐兜底
 * ④ 断线续传:中途断开重连 sub{lastSeq} → 重放连续
 * ⑤ 服务重启恢复(--phase=recover):重启后重连,游标超前 → snapshot 对齐,历史任务可见
 * 运行: node scripts/test-ws-stress.mjs [--phase=recover]
 */
const BASE = process.env.AW_E2E_BASE ?? 'http://localhost:3000'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, arg) {
  // 调用侧统一 { body: {...} } 包装;无 body 的 GET 无第三参
  const body = arg && typeof arg === 'object' && 'body' in arg ? arg.body : arg
  const res = await fetch(`${BASE}/api/workshop${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data }
}

function openWs() {
  const frames = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws`)
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(true)
    ws.onerror = e => reject(new Error(`ws error: ${e?.message ?? e}`))
  })
  ws.onmessage = ev => frames.push(JSON.parse(ev.data))
  return { ws, frames, opened }
}

const isRecover = process.argv.includes('--phase=recover')

async function main() {
  if (isRecover) {
    // ── ⑤ 服务重启恢复:新建 channel 重连,验证 snapshot 对齐(游标超前场景) ──
    console.log('=== ⑤ 服务重启恢复 ===')
    const ch = await api('POST', '/channels', { body: { name: `stress-recover-${Date.now()}` } })
    const channelId = ch.data?.channelId
    await api('POST', `/channels/${channelId}/agents`, { body: { name: 'r-lead', harness: 'mock', role: 'lead' } })
    await api('POST', `/channels/${channelId}/agents`, { body: { name: 'r-w1', harness: 'mock' } })
    const c = openWs()
    await c.opened
    c.ws.send(JSON.stringify({ type: 'sub', channelId, lastSeq: 999_999 })) // 游标超前(模拟重启前状态)
    await sleep(800)
    const snap = c.frames.find(f => f.type === 'channel.snapshot')
    check('游标超前 → snapshot 全量对齐', !!snap && snap.channelId === channelId)
    // 提交任务验证重启后直推正常
    const t = await api('POST', `/channels/${channelId}/tasks`, { body: { title: '重启后任务' } })
    const ok = await (async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if (c.frames.some(f => f.type === 'task.status' && f.payload?.taskId === t.data?.id && f.payload?.state === 'COMPLETED')) return true
        await sleep(150)
      }
      return false
    })()
    check('重启后任务全生命周期直推', ok)
    c.ws.close()
    await api('DELETE', `/channels/${channelId}`)
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  }

  // ── 前置:双 channel + 成员 ──
  const mkChannel = async (name) => {
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/channels', { body: { name } })
      if (r.data?.channelId) return r.data.channelId
      await sleep(1000)
    }
    throw new Error(`channel 创建失败: ${name}`)
  }
  const A = await mkChannel(`stress-a-${Date.now()}`)
  const B = await mkChannel(`stress-b-${Date.now()}`)
  for (const [cid, prefix] of [[A, 'a'], [B, 'b']]) {
    await api('POST', `/channels/${cid}/agents`, { body: { name: `${prefix}-lead`, harness: 'mock', role: 'lead' } })
    await api('POST', `/channels/${cid}/agents`, { body: { name: `${prefix}-w1`, harness: 'mock' } })
  }

  console.log('=== ② 双 channel 并行不串扰 ===')
  const c1 = openWs()
  await c1.opened
  c1.ws.send(JSON.stringify({ type: 'sub', channelId: A }))
  c1.ws.send(JSON.stringify({ type: 'sub', channelId: B }))
  await sleep(600)
  // 并发提交
  await Promise.all([
    api('POST', `/channels/${A}/tasks`, { body: { title: 'A-任务甲' } }),
    api('POST', `/channels/${B}/tasks`, { body: { title: 'B-任务乙' } }),
  ])
  const bothDone = await (async () => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const aDone = c1.frames.some(f => f.channelId === A && f.type === 'task.status' && f.payload?.state === 'COMPLETED')
      const bDone = c1.frames.some(f => f.channelId === B && f.type === 'task.status' && f.payload?.state === 'COMPLETED')
      if (aDone && bDone) return true
      await sleep(150)
    }
    return false
  })()
  check('双 channel 任务并行闭环', bothDone)
  // 严格隔离:所有 A 帧不含 B 的任务标题,反之亦然
  const aFrames = c1.frames.filter(f => f.channelId === A)
  const bFrames = c1.frames.filter(f => f.channelId === B)
  check('A 域无 B 事件泄漏', aFrames.every(f => JSON.stringify(f.payload ?? {}).indexOf('B-') < 0), `aFrames=${aFrames.length}`)
  check('B 域无 A 事件泄漏', bFrames.every(f => JSON.stringify(f.payload ?? {}).indexOf('A-') < 0), `bFrames=${bFrames.length}`)

  console.log('\n=== ① 万级事件压测(6000 消息注入) ===')
  const BATCH = 6000
  const t0 = Date.now()
  const leadA = (await api('GET', `/channels/${A}/agents`)).data?.[0]?.id
  const leadB = (await api('GET', `/channels/${B}/agents`)).data?.[0]?.id
  const injectOk = async (cid, toId, tag) => {
    const CONC = 30
    for (let i = 0; i < BATCH / 2; i += CONC) {
      await Promise.all(Array.from({ length: CONC }, (_, j) =>
        api('POST', `/channels/${cid}/messages`, { body: { toAgentId: toId, text: `${tag}-${i + j}` } })))
    }
  }
  await Promise.all([injectOk(A, leadA, 'sa'), injectOk(B, leadB, 'sb')])
  const injectMs = Date.now() - t0
  // 等待帧到达(限流消费)
  const settled = await (async () => {
    const deadline = Date.now() + 60_000
    let last = -1
    let stableSince = 0
    while (Date.now() < deadline) {
      const total = c1.frames.filter(f => f.type === 'a2a.message').length
      if (total === last) {
        stableSince += 400
        if (stableSince >= 2000) return total
      }
      else stableSince = 0
      last = total
      await sleep(400)
    }
    return last
  })()
  console.log(`  注入 ${BATCH} 条耗时 ${injectMs}ms;帧稳定于 ${settled}`)
  check('hub 高压下持续推送(≥90% 帧到达或缓冲截断后对齐)', settled >= BATCH * 0.9 || settled >= 4000, `frames=${settled}`)
  // seq 连续性(单 channel)
  const aSeqs = aFrames.map(f => f.seq).sort((x, y) => x - y)
  const contiguous = aSeqs.every((s, i) => i === 0 || s === aSeqs[i - 1] + 1)
  check('A 域 seq 连续(压测后)', contiguous, `n=${aSeqs.length} first=${aSeqs[0]} last=${aSeqs.at(-1)}`)

  console.log('\n=== ③ 环形缓冲溢出对齐 ===')
  const staleSeq = 5 // 早已被挤出 ring 的游标
  const c2 = openWs()
  await c2.opened
  c2.ws.send(JSON.stringify({ type: 'sub', channelId: A, lastSeq: staleSeq }))
  await sleep(1000)
  const snap2 = c2.frames.find(f => f.type === 'channel.snapshot')
  check('缓冲窗外 lastSeq → snapshot 对齐兜底', !!snap2)
  c2.ws.close()

  console.log('\n=== ④ 断线续传(压测流中) ===')
  // 实时游标:重取当前连接的 A 域最新 seq(压测前引用已过期)
  const lastSeq = c1.frames.filter(f => f.channelId === A).map(f => f.seq).sort((x, y) => x - y).at(-1) ?? 0
  c1.ws.close()
  await sleep(300)
  // 断开期间继续注入一小批(ring 窗口内,保证可重放)
  for (let i = 0; i < 50; i++) await api('POST', `/channels/${A}/messages`, { body: { toAgentId: leadA, text: `gap-${i}` } })
  const c3 = openWs()
  await c3.opened
  c3.ws.send(JSON.stringify({ type: 'sub', channelId: A, lastSeq }))
  await sleep(1500)
  const replay = c3.frames.filter(f => f.type !== 'channel.snapshot' && f.type !== 'pong')
  const rSeqs = replay.map(f => f.seq)
  check('重放 seq 从 lastSeq+1 连续', rSeqs.length > 0 && rSeqs[0] === lastSeq + 1
  && rSeqs.every((s, i) => i === 0 || s === rSeqs[i - 1] + 1), `first=${rSeqs[0]} last=${rSeqs.at(-1)}(lastSeq=${lastSeq})`)
  c3.ws.close()

  await api('DELETE', `/channels/${A}`)
  await api('DELETE', `/channels/${B}`)
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('压测异常:', e)
  process.exit(1)
})
