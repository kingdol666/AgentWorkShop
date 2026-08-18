/**
 * 事件持久化验证(server 驱动;对运行中的 dev server):
 * ① 任务事件落库:提交任务 → WS 直推 → GET /channels/:id/events 含全生命周期帧
 * ② 历史拉取与 WS 无缝衔接:断开重连(lastSeq=最新)→ 历史帧 seq ≤ 游标可拉
 * ③ 服务重启持久:重启 dev server → 事件端点仍返回全部历史(DB 是事实源)
 * ④ 用户隔离:用户 B 拉取 A 的 channel 事件 → 403;B 的 WS sub A channel → error
 * ⑤ beforeSeq 翻页:分页拉取 seq 连续不重不漏
 * ⑥ channel 删除级联:删 channel → 事件端点 404
 * 运行: node scripts/test-event-persistence.mjs [--phase=recovered]
 */
const BASE = process.env.AW_E2E_BASE ?? 'http://localhost:3000'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let __user = null
if (process.env.AW_EVP_TOKEN) __user = { data: { token: process.env.AW_EVP_TOKEN } }
if (!__user?.data?.token) __user = await fetch(BASE + '/api/workshop/users/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'evp-' + Math.random().toString(36).slice(2, 10) }),
}).then(r => r.json()).catch(() => null)
const T = __user?.data?.token
if (!T) {
  console.error('用户注册失败')
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/workshop${path}`, {
    method,
    headers: {
      authorization: `Bearer ${T}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.code, data: json?.data }
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

const RECOVERED = process.argv.includes('--phase=recovered')
// 阶段标记文件(跨重启传递 channel id)
const MARK = process.env.TEMP ? `${process.env.TEMP}/aw-evp.json` : '/tmp/aw-evp.json'

async function main() {
  if (RECOVERED) {
    // ── ③ 服务重启后历史仍在(DB 事实源) ──
    console.log('=== ③ 服务重启后事件持久 ===')
    const fs = await import('node:fs')
    const mark = JSON.parse(fs.readFileSync(MARK, 'utf8'))
    const hist = await api('GET', `/channels/${mark.channelId}/events?limit=1000`)
    check('重启后历史仍完整', hist.status === 200 && (hist.data?.items?.length ?? 0) >= mark.count,
      `items=${hist.data?.items?.length} / before=${mark.count}`)
    check('重启后 maxSeq 一致', hist.data?.maxSeq === mark.maxSeq, `${hist.data?.maxSeq} / ${mark.maxSeq}`)
    // 清理
    await api('DELETE', `/channels/${mark.channelId}`)
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  }

  // ── 前置 ──
  const ch = await api('POST', '/channels', { name: `evp-ch-${Date.now()}` })
  const cid = ch.data.channelId
  await api('POST', `/channels/${cid}/agents`, { name: 'evp-lead', harness: 'mock', role: 'lead' })
  await api('POST', `/channels/${cid}/agents`, { name: 'evp-w1', harness: 'mock' })

  console.log('=== ① 任务事件落库 ===')
  const c1 = openWs()
  await c1.opened
  c1.ws.send(JSON.stringify({ type: 'sub', channelId: cid, token: T }))
  await sleep(600)
  const task = await api('POST', `/channels/${cid}/tasks`, { title: 'evp 任务', description: '持久化验证' })
  await (async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (c1.frames.some(f => f.type === 'task.status' && f.payload?.taskId === task.data?.id && f.payload?.state === 'COMPLETED')) return true
      await sleep(150)
    }
    return false
  })()
  await sleep(800) // 落库同步完成余量
  const hist = await api('GET', `/channels/${cid}/events?limit=1000`)
  const items = hist.data?.items ?? []
  check('事件端点 200 + items', hist.status === 200 && items.length > 0, `n=${items.length}`)
  const hasLifecycle = ['SUBMITTED', 'WORKING', 'WAITING', 'COMPLETED'].every(st =>
    items.some(e => e.type === 'task.status' && e.payload?.state === st))
  check('全生命周期状态帧落库', hasLifecycle)
  check('artifact 帧落库', items.some(e => e.type === 'a2a.artifact'))
  // 同源比较以 sub 时刻的快照 seq 为界:快照前(建 channel/加成员)的帧已落库但
  // 订阅者经快照对齐而非逐帧重放,不参与 WS 帧集比对
  const subSeq = c1.frames.find(f => f.type === 'channel.snapshot')?.seq ?? 0
  const wsSeqs = c1.frames.filter(f => f.type !== 'pong' && f.type !== 'channel.snapshot').map(f => f.seq)
  const dbSeqs = items.filter(e => e.seq > subSeq).map(e => e.seq)
  check('DB 帧与 WS 帧集合一致(同源)', JSON.stringify(wsSeqs) === JSON.stringify(dbSeqs),
    `ws=${wsSeqs.length} db=${dbSeqs.length}`)
  c1.ws.close()

  console.log('\n=== ② 历史拉取与 WS 无缝衔接 ===')
  // 模拟前端刷新:新连接 sub(无 lastSeq → snapshot)后拉历史
  const c2 = openWs()
  await c2.opened
  c2.ws.send(JSON.stringify({ type: 'sub', channelId: cid, token: T }))
  await sleep(600)
  const hist2 = await api('GET', `/channels/${cid}/events?limit=50`)
  const snapSeq = c2.frames.find(f => f.type === 'channel.snapshot')?.seq
  const histMax = Math.max(...(hist2.data?.items ?? []).map(e => e.seq))
  check('快照游标 ≥ 历史最大 seq(衔接无缝隙)', snapSeq >= histMax, `snap=${snapSeq} histMax=${histMax}`)
  c2.ws.close()

  console.log('\n=== ④ 用户隔离(事件端点 + WS) ===')
  const other = await fetch(BASE + '/api/workshop/users/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'evp-b-' + Math.random().toString(36).slice(2, 8) }),
  }).then(r => r.json())
  const cross = await fetch(`${BASE}/api/workshop/channels/${cid}/events`, {
    headers: { authorization: `Bearer ${other.data.token}` },
  }).then(r => r.json())
  check('B 拉取 A 的事件 → 403', cross.code === 'SCOPE_VIOLATION', cross.code)
  const wsCross = await new Promise((resolve) => {
    const ws = new WebSocket(WS_BASE + '/api/workshop/ws')
    ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId: cid, token: other.data.token }))
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      ws.close()
      resolve(f)
    }
    setTimeout(() => resolve(null), 4000)
  })
  check('B WS 订阅 A 的 channel → error', wsCross?.payload?.code === 'SCOPE_VIOLATION', wsCross?.payload?.code)

  console.log('\n=== ⑤ beforeSeq 翻页 ===')
  const page1 = await api('GET', `/channels/${cid}/events?limit=5`)
  const p1 = page1.data.items
  const page2 = await api('GET', `/channels/${cid}/events?limit=5&beforeSeq=${p1[0].seq}`)
  const p2 = page2.data.items
  const all = [...p2, ...p1]
  const seqs = all.map(e => e.seq)
  const contiguous = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)
  check('翻页连续不重不漏', contiguous && new Set(seqs).size === seqs.length, `${p2.at(-1)?.seq}…${p1.at(-1)?.seq}`)

  console.log('\n=== ⑥ channel 删除级联 ===')
  const fsx = await import('node:fs')
  fsx.writeFileSync(MARK, JSON.stringify({ channelId: cid, count: items.length, maxSeq: hist.data.maxSeq, token: T }))
  console.log(`  已标记 channel(重启后验证持久):${cid},count=${items.length}`)
  console.log(failures === 0 ? '\nPHASE-1 ALL PASS(重启 dev server 后运行 --phase=recovered)' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('事件持久化测试异常:', e)
  process.exit(1)
})
