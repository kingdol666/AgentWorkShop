/**
 * 多 Harness 团队协同端到端实测 —— "引擎无关"验收。
 *   schtask/手动: NO_PROXY='127.0.0.1,localhost' node scripts/e2e-multiharness-team.mjs
 *
 * LLM provider 矩阵(用户指定:ustc glm-5.3-flash 优先,无则 zhipu coding plan glm-5.3-flash):
 *   omp      → zhipu-coding-plan / glm-5.3-flash   (omp 目录无 ustc-glm;目录已验证)
 *   codex    → default(cc-switch) / glm-5.3-flash  (catalog 已验证)
 *   opencode → zhipuai-coding-plan / glm-5.3-flash (auth.json 已验证)
 *   dsh      → ustc / glm-5.3-flash                (settings.yaml 已加模型项;ustc 优先)
 *
 * 场景:mock lead 调度 + 4 个不同引擎 worker 同 Channel;
 *   节点:mqtt-daq(18830)/http-daq(1889)/opcua-dcw(4840)/plc-dcw(15040) 全真实协议模拟工况;
 *   绑定:每个 worker 绑定自己的节点(daq=auto,dcw=manual→HITL);
 *   任务:omp/codex 读数汇报;dsh/opencode 数控下发(经 HITL 批准);
 *   验证:任务终态 + 写入落达(opcua 回读/plc SP+PV)+ HITL 帧面。
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
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
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    return { status: res.status, ...(await res.json().catch(() => ({}))) }
  }
  catch (err) {
    if (attempt < 20) {
      await sleep(3000)
      return api(method, path, { body, token }, attempt + 1)
    }
    throw err
  }
}

/** ── preflight:dev server + 全部模拟工况自愈(清僵尸/唯一实例) ── */
async function preflight() {
  const fs = await import('node:fs')
  const net = await import('node:net')
  const resolve2 = (await import('node:path')).resolve
  const { spawnSync, spawn } = await import('node:child_process')
  const portUp = port => new Promise((res) => {
    const s = net.connect(port, '127.0.0.1')
    const t = setTimeout(() => {
      s.destroy()
      res(false)
    }, 1000)
    s.on('connect', () => {
      clearTimeout(t)
      s.destroy()
      res(true)
    })
    s.on('error', () => {
      clearTimeout(t)
      res(false)
    })
  })
  // dev server(锁被在跑实例持有时不抢:等它就绪;仅僵尸锁才清)
  let devOk = false
  for (let i = 0; i < 40 && !devOk; i++) {
    try {
      devOk = (await fetch(`${BASE}/api/health`)).status === 200
    }
    catch { devOk = false }
    if (!devOk) {
      if (i === 0) {
        const lockPath = resolve2('.AgentWorkShop/.runtime/aw.lock')
        let lockPid = 0
        let lockAlive = false
        try {
          lockPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid ?? 0)
          if (lockPid) {
            const t = spawnSync('tasklist', ['/FI', `PID eq ${lockPid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8' })
            lockAlive = (t.stdout ?? '').trim().length > 0 && !/no tasks/i.test(t.stdout ?? '')
          }
        }
        catch { /* 无锁 */ }
        if (lockPid && !lockAlive) {
          spawnSync('cmd', ['/c', `taskkill /F /PID ${lockPid}`])
          try {
            fs.unlinkSync(lockPath)
          }
          catch { /* 无锁 */ }
          const fd = fs.openSync(resolve2('.AgentWorkShop/data/dev-server.log'), 'a')
          const child = spawn(process.execPath, ['bin/aw.mjs', 'dev'], {
            cwd: process.cwd(), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
            detached: true, stdio: ['ignore', fd, fd],
          })
          child.unref()
          console.log('  [preflight] dev server 重启中…')
        }
        else if (lockAlive) {
          console.log('  [preflight] 锁被在跑实例持有,等待其就绪…')
        }
      }
      await sleep(3000)
    }
  }
  if (!devOk) throw new Error('preflight:dev server 未恢复')
  console.log('  [preflight] dev server ✓')
  // 模拟器(清旧持有者 → 唯一实例)
  const SIMS = [
    { name: 'mqtt-http', ports: [18830, 1889], cmd: 'scripts/dev-protocol-simulators.mjs', env: { MQTT_SIM_PORT: '18830', HTTP_SIM_PORT: '1889' }, log: 'sim-mqtt-http.log' },
    { name: 'modbus-tcp', ports: [1502], cmd: 'scripts/dev-modbus-simulator.mjs', env: {}, log: 'sim-modbus-tcp.log' },
    { name: 'opcua', ports: [4840], cmd: 'scripts/dev-opcua-simulator.mjs', env: { OPCUA_SIM_PORT: '4840' }, log: 'sim-opcua.log' },
    { name: 'plc', ports: [15040], cmd: 'scripts/dev-plc-simulator.mjs', env: {}, args: ['--port', '15040'], log: 'sim-plc.log' },
    { name: 'rtu', ports: [15030], cmd: 'scripts/_rtu-mini-slave.mjs', env: {}, log: 'sim-rtu.log' },
  ]
  for (const sim of SIMS) {
    const owners = spawnSync('cmd', ['/c', `netstat -ano | findstr :${sim.ports[0]} | findstr LISTENING`], { encoding: 'utf-8' })
    for (const line of (owners.stdout ?? '').split('\n')) {
      const m = line.trim().match(/\s(\d+)\s*$/)
      if (m) {
        spawnSync('cmd', ['/c', `taskkill /F /PID ${m[1]}`])
        await sleep(300)
      }
    }
    const fd = fs.openSync(resolve2('.AgentWorkShop/data', sim.log), 'a')
    const child = spawn(process.execPath, [sim.cmd, ...(sim.args ?? [])], {
      cwd: process.cwd(), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...sim.env },
      detached: true, stdio: ['ignore', fd, fd],
    })
    child.unref()
    let up = false
    for (let i = 0; i < 15 && !up; i++) {
      await sleep(1000)
      up = await portUp(sim.ports[0])
    }
    if (!up) throw new Error(`preflight:${sim.name} 拉起失败`)
  }
  console.log('  [preflight] 模拟工况六端口 ✓')
}

async function main() {
  console.log(`\n━━━ 多 Harness 团队协同 E2E @ ${BASE} (tag=${TAG}) ━━━`)
  await preflight()

  const reg = await api('POST', '/api/users/register', {
    body: { email: `team-${TAG}@test.local`, password: 'Passw0rd!123', name: `team-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 200)}`)
  const auth = { token }

  // ═══ Phase 1:产线 + 全协议节点 ═══
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `多引擎产线-${TAG}` }, ...auth })).data?.line
  const nMqtt = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: `MQTT温度-${TAG}`, driver: 'mqtt', driverConfig: { host: '127.0.0.1', port: 18830, topic: 'aw/sim/temp', jsonPath: 'data.temp' }, lineId: line.id, intervalMs: 1000, publishIntervalMs: 0 }, ...auth,
  })).data?.node
  const nHttp = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: `HTTP流量-${TAG}`, driver: 'http', driverConfig: { url: 'http://127.0.0.1:1889/api/value', jsonPath: 'data.value' }, lineId: line.id, intervalMs: 1000, publishIntervalMs: 0 }, ...auth,
  })).data?.node
  const nOcua = (await api('POST', '/api/workshop/dcw', {
    body: { templateRef: 'dcw-temp-sp', name: `OPCUA设定-${TAG}`, driver: 'opcua', driverConfig: { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=AW.SetTemp' }, lineId: line.id }, ...auth,
  })).data?.node
  const nPlc = (await api('POST', '/api/workshop/dcw', {
    body: { templateRef: 'dcw-temp-sp', name: `PLC设定-${TAG}`, driver: 'modbus-tcp', driverConfig: { host: '127.0.0.1', port: 15040, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' }, lineId: line.id }, ...auth,
  })).data?.node
  check('1.1', '四协议节点创建(mqtt/http 数采 + opcua/modbus 数控)', Boolean(line?.id && nMqtt?.id && nHttp?.id && nOcua?.id && nPlc?.id))

  const prod = (await api('POST', '/api/workshop/dcw/products', { body: { name: `多引擎产品-${TAG}`, lineId: line.id }, ...auth })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id, name: `多引擎配方-${TAG}`,
      params: [{ templateRef: 'dcw-temp-sp', nodeId: nPlc.id, value: 180, min: 150, max: 200 }],
      daqWindows: [{ nodeId: nMqtt.id, min: 0, max: 120 }, { nodeId: nHttp.id, min: 0, max: 120 }],
    }, ...auth,
  })).data?.recipe
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, ...auth })
  check('1.2', '产线开跑(数采门控 + 工艺窗激活)', start.code === 0, start.message ?? '')

  // ═══ Phase 2:四引擎 Agent + Channel + 节点绑定 ═══
  const engines = [
    { key: 'omp', harness: 'omp', cfg: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash' } },
    { key: 'codex', harness: 'codex', cfg: { model: 'glm-5.3-flash' } },
    { key: 'dsh', harness: 'dsh', cfg: { provider: 'ustc', model: 'glm-5.3-flash' } },
    { key: 'opencode', harness: 'opencode', cfg: { model: 'zhipuai-coding-plan/glm-5.3-flash' } },
  ]
  const workers = {}
  for (const e of engines) {
    const created = await api('POST', '/api/workshop/agents', {
      body: { name: `${e.key}-${TAG}`, harness: e.harness, config: { ...e.cfg, systemPromptPrefix: '你是产线操作员,严格按任务使用工业工具完成,完成后调用 complete_task。' } }, ...auth,
    })
    workers[e.key] = created.data
    check(`2.${e.key}-tpl`, `${e.harness} 模板创建(provider=${e.cfg.provider ?? 'default'},model=${e.cfg.model})`, Boolean(workers[e.key]?.id))
  }

  const ch = (await api('POST', '/api/workshop/channels', {
    body: { name: `多引擎协同-${TAG}`, description: '跨 Harness 团队作业控制验证', leadAgent: { name: `调度长-${TAG}`, harness: 'mock', config: { delayMs: 60 } } }, ...auth,
  })).data
  const channelId = ch.channelId
  check('2.ch', 'Channel 创建(mock lead 调度)', Boolean(channelId))
  for (const e of engines) {
    const r = await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: workers[e.key].id, role: 'worker' }, ...auth })
    if (r.code !== 0) check(`2.${e.key}-join`, `${e.key} 入队`, false, r.message ?? '')
  }
  const members = (await api('GET', `/api/workshop/channels/${channelId}/agents`, auth)).data ?? []
  check('2.join', '四引擎 worker 全部入队(lead=mock + 4 引擎)', members.length >= 5, `members=${members.length}`)

  const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: workers.omp.id, nodeId: nMqtt.id, kind: 'daq', mode: 'auto' }, ...auth })
  const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: workers.codex.id, nodeId: nHttp.id, kind: 'daq', mode: 'auto' }, ...auth })
  const b3 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: workers.dsh.id, nodeId: nOcua.id, kind: 'dcw', mode: 'manual' }, ...auth })
  const b4 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: workers.opencode.id, nodeId: nPlc.id, kind: 'dcw', mode: 'manual' }, ...auth })
  check('2.bind', '节点绑定(omp→mqtt / codex→http / dsh→opcua / opencode→plc)', b1.code === 0 && b2.code === 0 && b3.code === 0 && b4.code === 0)

  // ═══ Phase 3:四路任务并行下发 ═══
  const tasks = {}
  const mkTask = async (key, assigneeId, text) => {
    const t = await api('POST', `/api/workshop/channels/${channelId}/tasks`, { body: { title: `${key}-${TAG}`, parts: [{ text }], assigneeId }, ...auth })
    tasks[key] = t.data?.task?.id ?? t.data?.id
    return t
  }
  await mkTask('T1-omp-read', workers.omp.id, `用 daq_query 读取「MQTT温度-${TAG}」最近 3 分钟数据,汇报均值即可,然后 complete_task。`)
  await mkTask('T2-codex-read', workers.codex.id, `用 daq_query 读取「HTTP流量-${TAG}」最近 3 分钟数据,汇报均值即可,然后 complete_task。`)
  await mkTask('T3-dsh-write', workers.dsh.id, `用 dcw_read 读取「OPCUA设定-${TAG}」当前值;再用 dcw_control 将其调到 171.5(若需审批,等待即可);完成后 dcw_read 复核并 complete_task。`)
  await mkTask('T4-oc-write', workers.opencode.id, `用 dcw_read 读取「PLC设定-${TAG}」当前值;再用 dcw_control 将其调到 183(若需审批,等待即可);完成后 dcw_read 复核并 complete_task。`)
  check('3.1', '四路任务下发(omp/codex 读数;dsh/opencode 数控)', Object.values(tasks).every(Boolean), JSON.stringify(tasks).slice(0, 120))

  // ═══ Phase 4:HITL 自动批准(dcw-approval;兼容各引擎权限帧) ═══
  const approved = new Set()
  const hitlDeadline = Date.now() + 8 * 60_000
  while (Date.now() < hitlDeadline && approved.size < 2) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, auth)
    const items = p.data?.items ?? []
    for (const it of items) {
      if (it.kind === 'dcw-approval' && !approved.has(it.id)) {
        const r = await api('POST', '/api/workshop/hitl/respond', { body: { kind: 'dcw-approval', id: it.id, confirmed: true, response: 'y' }, ...auth })
        approved.add(it.id)
        console.log(`  [hitl] 批准 dcw-approval ${it.id.slice(0, 8)} → ${r.code === 0 ? 'ok' : String(r.message).slice(0, 60)}`)
      }
    }
    await sleep(5000)
  }
  check('4.1', '两路 DCW HITL 审批到达并批准(manual 绑定)', approved.size >= 2, `approved=${approved.size}`)

  // ═══ Phase 5:任务终态 + 写入落达验证 ═══
  const states = {}
  const tDeadline = Date.now() + 14 * 60_000
  while (Date.now() < tDeadline) {
    const list = await api('GET', `/api/workshop/channels/${channelId}/tasks`, auth)
    const all = list.data ?? []
    for (const [key, id] of Object.entries(tasks)) {
      if (states[key]) continue
      const me = all.find(x => x.id === id)
      if (me && ['COMPLETED', 'FAILED', 'CANCELED'].includes(me.state)) states[key] = me.state
    }
    if (Object.keys(states).length === 4) break
    await sleep(6000)
  }
  check('5.T1', 'omp(zhipu glm-5.3-flash) 读数任务 COMPLETED', states['T1-omp-read'] === 'COMPLETED', `state=${states['T1-omp-read'] ?? 'RUNNING'}`)
  check('5.T2', 'codex(cc-switch glm-5.3-flash) 读数任务 COMPLETED', states['T2-codex-read'] === 'COMPLETED', `state=${states['T2-codex-read'] ?? 'RUNNING'}`)
  check('5.T3', 'dsh(ustc glm-5.3-flash) 数控任务 COMPLETED', states['T3-dsh-write'] === 'COMPLETED', `state=${states['T3-dsh-write'] ?? 'RUNNING'}`)
  check('5.T4', 'opencode(zhipuai glm-5.3-flash) 数控任务 COMPLETED', states['T4-oc-write'] === 'COMPLETED', `state=${states['T4-oc-write'] ?? 'RUNNING'}`)

  // 写入落达:opcua 回读 171.5 / plc SP 183
  const dcwList = await api('GET', '/api/workshop/dcw', auth)
  const dcwNodes = Array.isArray(dcwList.data) ? dcwList.data : (dcwList.data?.nodes ?? [])
  const ocNow = Number(dcwNodes.find(n => n.id === nOcua.id)?.readValue ?? NaN)
  const plcNow = Number(dcwNodes.find(n => n.id === nPlc.id)?.readValue ?? NaN)
  check('5.1', 'OPC UA 设定落达(dsh 引擎;171.5±1.5)', Number.isFinite(ocNow) && Math.abs(ocNow - 171.5) <= 1.5, `readValue=${ocNow}`)
  check('5.2', 'PLC 设定落达(opencode 引擎;183±2)', Number.isFinite(plcNow) && Math.abs(plcNow - 183) <= 2, `readValue=${plcNow}`)
  // PLC PV 物理收敛(闭环保底:raw 寄存器读)
  try {
    const net = await import('node:net')
    const raw = await new Promise((resolveRaw) => {
      const sock = net.connect(15040, '127.0.0.1')
      let buf // 累积缓冲:首帧 data 到达前无读取点(初始空 buffer 语义由 concat 首写承担)
      let byteLen = 0
      sock.on('connect', () => sock.write(Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 2])))
      sock.on('data', (d) => {
        buf = buf ? Buffer.concat([buf, d]) : d
        byteLen = buf.length
        if (byteLen >= 13) {
          resolveRaw(Number(buf.subarray(9, 13).readFloatBE(0).toFixed(1)))
          sock.destroy()
        }
      })
      sock.on('error', () => resolveRaw(null))
      setTimeout(() => {
        sock.destroy()
        resolveRaw(null)
      }, 4000)
    })
    check('5.3', 'PLC PV 物理收敛(寄存器直读 ≥150)', raw !== null && raw >= 150, `rawPV=${raw}`)
  }
  catch { check('5.3', 'PLC PV 物理收敛(寄存器直读 ≥150)', false, 'probe error') }

  // ═══ 清理 ═══
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, auth).catch(() => {})
  for (const id of [nMqtt.id, nHttp.id]) await api('DELETE', `/api/workshop/daq/${id}`, auth).catch(() => {})
  for (const id of [nOcua.id, nPlc.id]) await api('DELETE', `/api/workshop/dcw/${id}`, auth).catch(() => {})
  await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, auth).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, auth).catch(() => {})

  console.log(`\n━━━ 多 Harness 团队 E2E 结果: ${passed} passed / ${failures} failed ━━━`)
  if (failures) {
    console.log('失败项:')
    for (const r of results.filter(x => !x.ok)) console.log(`  ${r.id} ${r.name} — ${r.detail}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
