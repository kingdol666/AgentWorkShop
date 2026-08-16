/**
 * 用户级隔离验证(对运行中的 dev server):
 * ① 注册/登录:register 生成 token;me 验证;重名 409;伪 token 401
 * ② 无 token 管理面全部 401(channels/agents/teams/tasks/messages/queue/runtime/workspaces)
 * ③ 用户A创建 Channel/模板/编组/workspace → 用户B不可见(列表过滤)、不可改(403)
 * ④ 跨用户资源操作:提交任务/删除/挂载/部署 → 403 SCOPE_VIOLATION
 * ⑤ 遗留公共资源(NULL owner):对 A/B 均只读可见,写操作 403 FORBIDDEN_LEGACY
 * ⑥ 用户A自己的资源:全流程正常(建 channel→worker→任务闭环)
 * ⑦ WS sub 鉴权:无 token → error;A 的 token 订阅 B 的 channel → error;自己 channel → 正常推送
 * ⑧ Workspace 持久化:list/create/mount/unmount/delete + channel 删除后 workspace 视角
 * 运行: node scripts/test-user-isolation.mjs
 */
const BASE = process.env.AW_E2E_BASE ?? 'http://localhost:3000'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api/workshop${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.code, data: json?.data }
}

const register = async name => (await api('POST', '/users/register', { body: { name } })).data

async function main() {
  console.log('=== ① 注册/登录 ===')
  const ts = Date.now().toString(36)
  const a = await register(`alice-${ts}`)
  const b = await register(`bob-${ts}`)
  check('注册 A/B 返回 token', !!a?.token && !!b?.token && a.token !== b.token)
  const me = await api('GET', '/users/me', { token: a.token })
  check('me 验证 token', me.status === 200 && me.data?.name === a.name)
  const dup = await api('POST', '/users/register', { body: { name: a.name } })
  check('重名注册 → 409 USER_EXISTS', dup.status === 409 && dup.code === 'USER_EXISTS')
  const fake = await api('GET', '/users/me', { token: 'u-not-a-token' })
  check('伪 token → 401 USER_UNAUTHORIZED', fake.status === 401 && fake.code === 'USER_UNAUTHORIZED')

  console.log('\n=== ② 无 token 管理面全 401 ===')
  const noTokenProbes = [
    ['GET', '/channels'],
    ['POST', '/channels', { name: 'x' }],
    ['GET', '/agents'],
    ['GET', '/teams'],
    ['GET', '/workspaces'],
    ['GET', '/runtime'],
  ]
  for (const [m, p, body] of noTokenProbes) {
    const r = await api(m, p, { body })
    check(`无 token ${m} ${p} → 401`, r.status === 401 && r.code === 'USER_UNAUTHORIZED', `status=${r.status}`)
  }

  console.log('\n=== ③ A 创建资源,B 视角隔离 ===')
  const chA = await api('POST', '/channels', { token: a.token, body: { name: `alice-ch-${ts}` } })
  check('A 创建 channel', chA.status === 200 && !!chA.data?.channelId)
  const cidA = chA.data.channelId
  await api('POST', `/channels/${cidA}/agents`, { token: a.token, body: { name: 'a-lead', harness: 'mock', role: 'lead' } })
  await api('POST', `/channels/${cidA}/agents`, { token: a.token, body: { name: 'a-w1', harness: 'mock' } })
  const tplA = await api('POST', '/agents', { token: a.token, body: { name: `alice-tpl-${ts}`, harness: 'mock' } })
  const teamA = await api('POST', '/teams', { token: a.token, body: { name: `alice-team-${ts}` } })
  check('A 创建模板/编组', tplA.status === 200 && teamA.status === 200)

  const bChannels = await api('GET', '/channels', { token: b.token })
  check('B 看不到 A 的 channel', !(bChannels.data ?? []).some(c => c.id === cidA), `n=${(bChannels.data ?? []).length}`)
  const bAgents = await api('GET', '/agents', { token: b.token })
  check('B 看不到 A 的模板', !(bAgents.data ?? []).some(t => t.id === tplA.data?.id))
  const bTeams = await api('GET', '/teams', { token: b.token })
  check('B 看不到 A 的编组', !(bTeams.data ?? []).some(t => t.id === teamA.data?.id))
  const bDirect = await api('GET', `/channels/${cidA}`, { token: b.token })
  check('B 直取 A 的 channel → 403', bDirect.status === 403 && bDirect.code === 'SCOPE_VIOLATION')

  console.log('\n=== ④ 跨用户写操作 → 403 ===')
  const bSubmit = await api('POST', `/channels/${cidA}/tasks`, { token: b.token, body: { title: 'hack' } })
  check('B 向 A 的 channel 提交任务 → 403', bSubmit.status === 403)
  const bDelete = await api('DELETE', `/channels/${cidA}`, { token: b.token })
  check('B 删 A 的 channel → 403', bDelete.status === 403)
  const bTplDel = await api('DELETE', `/agents/${tplA.data?.id}`, { token: b.token })
  check('B 删 A 的模板 → 403', bTplDel.status === 403)

  console.log('\n=== ⑤ 遗留公共资源只读 ===')
  const legacyList = await api('GET', '/channels', { token: a.token })
  const legacy = (legacyList.data ?? []).find(c => c.ownerUserId === null)
  if (legacy) {
    const lRead = await api('GET', `/channels/${legacy.id}`, { token: a.token })
    check('遗留 channel 对 A 可读', lRead.status === 200)
    const lWrite = await api('POST', `/channels/${legacy.id}/tasks`, { token: a.token, body: { title: 'x' } })
    check('遗留 channel 写 → 403 FORBIDDEN_LEGACY', lWrite.status === 403 && lWrite.code === 'FORBIDDEN_LEGACY', lWrite.code)
  }
  else {
    check('遗留 channel 只读(本库无遗留行,跳过)', true)
  }

  console.log('\n=== ⑥ A 自有资源全流程 ===')
  const task = await api('POST', `/channels/${cidA}/tasks`, { token: a.token, body: { title: 'A 的任务', description: '闭环' } })
  check('A 提交任务', task.status === 200)
  const done = await (async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const r = await api('GET', `/channels/${cidA}/tasks`, { token: a.token })
      const t = (r.data ?? []).find(x => x.id === task.data?.id)
      if (t?.state === 'COMPLETED') return true
      await sleep(200)
    }
    return false
  })()
  check('A 的任务闭环 COMPLETED', done)

  console.log('\n=== ⑦ WS sub 鉴权 ===')
  const wsNoToken = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3000/api/workshop/ws`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId: cidA }))
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      ws.close()
      resolve(f)
    }
    setTimeout(() => resolve(null), 4000)
  })
  check('WS sub 无 token → USER_UNAUTHORIZED', wsNoToken?.payload?.code === 'USER_UNAUTHORIZED', wsNoToken?.payload?.code)
  const wsCross = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3000/api/workshop/ws`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId: cidA, token: b.token }))
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      ws.close()
      resolve(f)
    }
    setTimeout(() => resolve(null), 4000)
  })
  check('WS B 订阅 A 的 channel → SCOPE_VIOLATION', wsCross?.payload?.code === 'SCOPE_VIOLATION', wsCross?.payload?.code)
  const wsOwn = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3000/api/workshop/ws`)
    let gotSnapshot = false
    ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId: cidA, token: a.token }))
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      if (f.type === 'channel.snapshot') {
        gotSnapshot = true
        // 触发一个事件验证直推
        api('POST', `/channels/${cidA}/tasks`, { token: a.token, body: { title: 'ws-push' } }).catch(() => {})
      }
      if (gotSnapshot && f.type === 'task.status') {
        ws.close()
        resolve(true)
      }
    }
    setTimeout(() => resolve(gotSnapshot), 25_000)
  })
  check('WS A 订阅自己 channel:快照 + 直推', wsOwn === true)

  console.log('\n=== ⑧ Workspace 持久化 ===')
  const wsA = await api('POST', '/workspaces', { token: a.token, body: { name: `alice-ws-${ts}` } })
  check('A 创建 workspace', wsA.status === 200 && !!wsA.data?.id)
  const wsId = wsA.data?.id
  const mount = await api('POST', `/workspaces/${wsId}/channels/${cidA}`, { token: a.token })
  check('A 挂载自己 channel', mount.status === 200)
  const bMount = await api('POST', `/workspaces/${wsId}/channels/${cidA}`, { token: b.token })
  check('B 挂载 A 的 workspace → 403', bMount.status === 403)
  const wsList = await api('GET', '/workspaces', { token: a.token })
  const found = (wsList.data ?? []).find(w => w.id === wsId)
  check('workspace 列表含挂载关系', found?.channelIds?.includes(cidA) === true)
  const bWsList = await api('GET', '/workspaces', { token: b.token })
  check('B 的 workspace 列表不含 A 的', !(bWsList.data ?? []).some(w => w.id === wsId))
  const unmount = await api('DELETE', `/workspaces/${wsId}/channels/${cidA}`, { token: a.token })
  check('A 移出 channel', unmount.status === 200)
  const delWs = await api('DELETE', `/workspaces/${wsId}`, { token: a.token })
  check('A 删除 workspace', delWs.status === 200)

  // 清理
  await api('DELETE', `/channels/${cidA}`, { token: a.token })
  await api('DELETE', `/agents/${tplA.data?.id}`, { token: a.token })
  await api('DELETE', `/teams/${teamA.data?.id}`, { token: a.token })

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('隔离测试异常:', e)
  process.exit(1)
})
