/**
 * plc-clean-scenario.mjs —— 全新环境 · PLC 工艺模拟器 · 端到端真实工况演练
 * ------------------------------------------------------------
 * 目标:在**空配置根**上,用真实 Modbus TCP 从站(scripts/dev-plc-simulator.mjs,
 * 涂布产线烘干单元:温度/速度/张力三回路,一阶惯性 + 执行器斜率限制 + 过程噪声)
 * 走完一整条业务链,并留下可供截图核验的数据:
 *
 *   P1 管理员引导             P5 工艺收敛(等 PV 追上 SP)
 *   P2 建线 + 3 数采 + 3 数控   P6 参数调优(3 次设定值调整 + 回读校验)
 *   P3 拖入真实 3D 模型并绑定   P7 Channel / Agent / 节点绑定 / 任务
 *   P4 产品 + 配方 + 开跑       P8 历史与留痕核查(数采/写史/台账/版本/运维日志)
 *
 * 用法:
 *   node scripts/_audit/plc-clean-scenario.mjs --base http://127.0.0.1:3112 \
 *        --plc 127.0.0.1:15041 [--state <输出 state.json>] [--skip-agent]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:3112').replace(/\/$/, '')
const [PLC_HOST, PLC_PORT] = arg('plc', '127.0.0.1:15041').split(':')
const SKIP_AGENT = process.argv.includes('--skip-agent')
/** --only=town —— 只补做「小镇挂载」这一步(可对既有环境补跑,不必重建整套数据) */
const ONLY = arg('only', '')
const HERE = dirname(fileURLToPath(import.meta.url))
const STATE = arg('state', resolve(HERE, '..', '..', '.e2e-shots', 'plc-clean', 'state.json'))

const TAG = Date.now().toString(36).slice(-5)
const ADMIN = { email: 'plant@awshop.local', password: 'Plant!2026', name: '产线工程师' }

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  ok ? pass++ : fail++
}
const info = msg => console.log(`  · ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let token = null
async function api(method, path, { body, raw } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return raw ? { status: res.status, json } : { status: res.status, ...(json ?? {}) }
}
const data = r => r?.data ?? {}
const ok = r => r?.code === 0 || (r?.status >= 200 && r?.status < 300)

async function waitFor(name, fn, timeoutMs = 180_000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    }
    catch (err) { last = err?.message ?? err }
    await sleep(intervalMs)
  }
  info(`waitFor 超时: ${name}(最后=${String(last).slice(0, 140)})`)
  return null
}

/** PLC 侧三回路 —— 与 dev-plc-simulator.mjs 的寄存器布局一一对应 */
const CIRCUITS = [
  { key: 'temp', label: '烘箱温度', daqTpl: 'daq-temp-tc', dcwTpl: 'dcw-temp-sp', pvReg: 40001, spReg: 40021, unit: '℃', set: 182, tune: 186, min: 150, max: 200, win: [176, 188] },
  { key: 'speed', label: '产线速度', daqTpl: 'daq-line-encoder', dcwTpl: 'dcw-speed-sp', pvReg: 40003, spReg: 40023, unit: 'm/min', set: 320, tune: 330, min: 280, max: 360, win: [310, 340] },
  { key: 'tension', label: '膜张力', daqTpl: 'daq-tension-cell', dcwTpl: 'dcw-tension-sp', pvReg: 40005, spReg: 40025, unit: 'kN', set: 21.4, tune: 22.6, min: 18, max: 26, win: [19.5, 23.5] },
]

/** 车间落位(数采/数控/孪生三者错开,便于在 3D 场景里分辨) */
const LAYOUT = {
  temp: { daq: [-9, -3], dcw: [-9, 3], model: 'extruder', name: '挤出主机' },
  speed: { daq: [0, -3], dcw: [0, 3], model: 'winder', name: '收卷机组' },
  tension: { daq: [9, -3], dcw: [9, 3], model: 'mdo', name: 'MDO 拉伸单元' },
}
const EXTRA_TWINS = [
  { model: 'power-cabinet', name: '配电柜', pos: [-14, 8] },
  { model: 'device-robot-arm', name: '上下料机械臂', pos: [14, 8] },
  { model: 'thickness-scanner', name: '在线测厚仪', pos: [0, 8] },
]

const state = { base: BASE, plc: `${PLC_HOST}:${PLC_PORT}`, tag: TAG, circuits: {}, createdAt: new Date().toISOString() }

async function main() {
  console.log(`\n━━━ 全新环境 · PLC 工艺模拟 · 端到端演练 @ ${BASE}(PLC ${PLC_HOST}:${PLC_PORT})━━━`)

  // --only=town:对既有环境补做「小镇挂载」,不重建数据(截图前常用)
  if (ONLY === 'town') {
    const login = await api('POST', '/api/users/login', { body: { email: state.admin?.email ?? ADMIN.email, password: state.admin?.password ?? ADMIN.password } })
    token = data(login).token ?? (await api('POST', '/api/users/register', { body: ADMIN })).data?.token
    if (!token) throw new Error('登录失败:--only=town 需要既有环境与 state.json')
    const chans = data(await api('GET', '/api/workshop/channels'))
    const list = Array.isArray(chans) ? chans : (chans.channels ?? [])
    const ch = list[0]
    if (!ch) throw new Error('既有环境里没有 Channel')
    console.log(`  复用 Channel:${ch.name}(${ch.id})`)
    const ws = data(await api('POST', '/api/workshop/workspaces', { body: { name: `数字化车间-${TAG}` } }))
    const wsId = ws.id ?? ws.workspace?.id
    check('P9.1 workspace 创建', Boolean(wsId), wsId)
    const mounted = await api('POST', `/api/workshop/workspaces/${wsId}/channels/${ch.id}`)
    check('P9.2 Channel 挂载进小镇', ok(mounted), `code=${mounted.code}`)
    const layout = data(await api('PUT', `/api/workshop/scene/layouts/${ch.id}`, { body: { x: 0, z: 0, radiusX: 22, radiusZ: 16, shape: 'ellipse' } })).layout
    check('P9.3 频道领地铺开', Boolean(layout), JSON.stringify(layout ?? {}).slice(0, 120))
    state.town = { workspaceId: wsId, channelId: ch.id, mounted: true }
    state.channel = { id: ch.id, name: ch.name }
    mkdirSync(dirname(STATE), { recursive: true })
    writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8')
    console.log(`\n  状态已更新 ${STATE}`)
    return
  }

  // ══════════ P1 管理员引导 ══════════
  console.log('\n── P1 环境引导(空配置根) ──')
  const setup = await api('GET', '/api/users/setup-status')
  check('P1.1 空配置根:needsSetup=true(全新环境)', data(setup).needsSetup === true, JSON.stringify(data(setup)))
  const reg = await api('POST', '/api/users/register', { body: ADMIN })
  token = data(reg).token
  check('P1.2 首个用户注册即管理员', Boolean(token), `status=${reg.status} role=${data(reg).user?.role ?? '?'}`)
  if (!token) throw new Error('注册失败,后续无法继续')

  // ══════════ P2 产线 + 节点 ══════════
  console.log('\n── P2 建产线 · 3 数采 + 3 数控(真实 Modbus TCP)──')
  const line = data(await api('POST', '/api/workshop/dcw/lines', { body: { name: `涂布烘干线-${TAG}`, color: '#35e0a0' } })).line
  check('P2.1 产线创建', Boolean(line?.id), line?.name)

  const driverConfig = reg => ({ host: PLC_HOST, port: Number(PLC_PORT), unitId: 1, register: reg, registerType: 'holding', dataType: 'float32', byteOrder: 'big', scale: 1 })

  // 建节点前先做一次连接测试:协议栈缺失/端口不通会在这里直接暴露,
  // 否则只会在节点上留下 state=offline + produced=0 这种没有原因的现象。
  const probe = await api('POST', '/api/workshop/daq/test-driver', {
    body: { driver: 'modbus-tcp', driverConfig: driverConfig(CIRCUITS[0].pvReg) },
  })
  const probeRes = data(probe).test ?? {}
  check('P2.0 Modbus TCP 连接测试(协议栈 + 端口可读)', probeRes.ok === true,
    `ok=${probeRes.ok} value=${probeRes.sampleValue ?? '?'} latency=${probeRes.latencyMs ?? '?'}ms msg=${probeRes.message ?? ''}`)

  for (const c of CIRCUITS) {
    const lay = LAYOUT[c.key]
    const daq = data(await api('POST', '/api/workshop/daq', {
      body: {
        templateRef: c.daqTpl,
        name: `${c.label}采集-${TAG}`,
        driver: 'modbus-tcp',
        driverConfig: driverConfig(c.pvReg),
        lineId: line.id,
        intervalMs: 1000,
        posX: lay.daq[0],
        posZ: lay.daq[1],
      },
    })).node
    const dcw = data(await api('POST', '/api/workshop/dcw', {
      body: {
        templateRef: c.dcwTpl,
        name: `${c.label}设定-${TAG}`,
        driver: 'modbus-tcp',
        driverConfig: driverConfig(c.spReg),
        lineId: line.id,
        readIntervalMs: 2000,
        posX: lay.dcw[0],
        posZ: lay.dcw[1],
      },
    })).node
    state.circuits[c.key] = { daq: daq?.id, dcw: dcw?.id, pvReg: c.pvReg, spReg: c.spReg }
    check(`P2.2 ${c.label} 数采节点建立(驱动 modbus-tcp,PV 寄存器 ${c.pvReg} @${PLC_HOST}:${PLC_PORT})`, daq?.driver === 'modbus-tcp', `driver=${daq?.driver} state=${daq?.state} value=${daq?.value}`)
    check(`P2.3 ${c.label} 数控节点建立(SP 寄存器 ${c.spReg})`, dcw?.driver === 'modbus-tcp', `driver=${dcw?.driver} state=${dcw?.state}`)
  }

  // ══════════ P3 3D 模型:真实 GLB 落位并绑定节点 ══════════
  console.log('\n── P3 数字孪生:拖入真实 3D 模型并绑定节点 ──')
  const assets = data(await api('GET', '/api/workshop/assets/devices')).devices ?? []
  check('P3.1 模型库扫描到设备 GLB', assets.length >= 6, `${assets.length} 个:${assets.map(a => a.id).slice(0, 6).join(', ')}`)
  const assetOf = needle => assets.find(a => a.id.includes(needle)) ?? assets.find(a => a.name?.includes(needle))

  state.twins = {}
  for (const c of CIRCUITS) {
    const lay = LAYOUT[c.key]
    const asset = assetOf(lay.model)
    const twin = data(await api('POST', '/api/workshop/device-twins', {
      body: { name: `${lay.name}-${TAG}`, modelRef: asset?.id ?? '', kind: 'device', posX: lay.daq[0], posZ: 8, rotationY: 0, scale: 1, controls: [] },
    })).twin
    if (twin?.id) {
      await api('POST', `/api/workshop/daq/${state.circuits[c.key].daq}/bind`, { body: { deviceId: twin.id } })
      await api('POST', `/api/workshop/dcw/${state.circuits[c.key].dcw}/bind`, { body: { deviceId: twin.id } })
    }
    state.twins[c.key] = twin?.id
    check(`P3.2 ${lay.name} ← ${asset?.id ?? '(未找到模型)'} 并绑定数采+数控`, Boolean(twin?.id && asset?.id), `twin=${twin?.id?.slice(0, 8)} model=${asset?.id}`)
  }
  for (const t of EXTRA_TWINS) {
    const asset = assetOf(t.model)
    const twin = data(await api('POST', '/api/workshop/device-twins', {
      body: { name: `${t.name}-${TAG}`, modelRef: asset?.id ?? '', kind: 'device', posX: t.pos[0], posZ: t.pos[1], rotationY: 0, scale: 1, controls: [] },
    })).twin
    state.twins[t.model] = twin?.id
    check(`P3.3 辅助设备落位 ${t.name}`, Boolean(twin?.id), asset?.id)
  }

  // ══════════ P4 产品 + 配方 + 开跑 ══════════
  console.log('\n── P4 产品 / 配方 / 开跑(配方参数逐节点写入并回读校验)──')
  const prod = data(await api('POST', '/api/workshop/dcw/products', { body: { name: `锂电隔膜-${TAG}`, lineId: line.id } })).product
  check('P4.1 产品创建', Boolean(prod?.id), prod?.name)

  const recipe = data(await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id,
      name: `标准配方-${TAG}`,
      params: CIRCUITS.map(c => ({
        templateRef: c.dcwTpl,
        nodeId: state.circuits[c.key].dcw,
        value: c.set,
        min: c.win[0],
        max: c.win[1],
      })),
      daqWindows: CIRCUITS.map(c => ({ nodeId: state.circuits[c.key].daq, min: c.min, max: c.max })),
    },
  })).recipe
  check('P4.2 配方创建(3 写参数 + 3 数采窗口)', Boolean(recipe?.id), `params=${recipe?.params?.length} windows=${recipe?.daqWindows?.length}`)

  const started = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id } })
  check('P4.3 开跑:配方参数逐节点下发(联锁 ∩ 配方窗口)', ok(started), `code=${started.code} msg=${started.message ?? ''}`)

  // ══════════ P5 工艺收敛 ══════════
  console.log('\n── P5 等待工艺收敛(PV 追 SP:一阶惯性 τ≈4–8s + 执行器斜率限制)──')
  const pvNow = async (c) => {
    // 注意:/samples 返回的是**按 bucketMs 聚合的点** { at, avg, min, max, cnt },
    // 不是原始 { value }。读 .avg。
    const r = await api('GET', `/api/workshop/daq/${state.circuits[c.key].daq}/samples?limit=5`)
    const pts = data(r).points ?? []
    return pts.length ? Number(pts[0].avg) : null
  }
  const converged = {}
  for (const c of CIRCUITS) {
    const tol = c.key === 'temp' ? 4 : c.key === 'speed' ? 6 : 0.6
    const v = await waitFor(`${c.label} 收敛到 ${c.set}`, async () => {
      const pv = await pvNow(c)
      return pv !== null && Math.abs(pv - c.set) <= tol ? pv : null
    }, 240_000, 3000)
    converged[c.key] = v
    check(`P5.1 ${c.label} 实测 PV 收敛到设定值 ${c.set}${c.unit}`, v !== null, v === null ? '未收敛' : `PV=${Number(v).toFixed(2)}`)
  }

  // ══════════ P6 参数调优 ══════════
  console.log('\n── P6 产线参数调优(设定值调整 → PLC 写入 → 回读校验 → PV 跟随)──')
  for (const c of CIRCUITS) {
    const r = await api('POST', `/api/workshop/dcw/${state.circuits[c.key].dcw}/write`, { body: { value: c.tune } })
    const outcome = data(r).outcome ?? {}
    check(`P6.1 ${c.label} 调优写入 ${c.set} → ${c.tune}${c.unit}(回读校验)`,
      ok(r) && outcome.ok === true,
      `ok=${outcome.ok} readback=${outcome.readValue ?? outcome.readback ?? '?'} ack=${outcome.state ?? outcome.ack ?? ''}`)
    await sleep(1200)
  }
  for (const c of CIRCUITS) {
    const tol = c.key === 'temp' ? 4 : c.key === 'speed' ? 6 : 0.6
    const v = await waitFor(`${c.label} PV 跟随到 ${c.tune}`, async () => {
      const pv = await pvNow(c)
      return pv !== null && Math.abs(pv - c.tune) <= tol ? pv : null
    }, 240_000, 3000)
    check(`P6.2 ${c.label} 实测 PV 跟随调优值 ${c.tune}${c.unit}`, v !== null, v === null ? '未跟随' : `PV=${Number(v).toFixed(2)}`)
  }

  // 配方版本:调优后把新值落进配方(产生 v2 版本记录)
  const bumped = await api('PATCH', `/api/workshop/dcw/recipes/${recipe.id}`, {
    body: { params: CIRCUITS.map(c => ({ templateRef: c.dcwTpl, nodeId: state.circuits[c.key].dcw, value: c.tune, min: c.win[0], max: c.win[1] })) },
  })
  check('P6.3 调优结果回写配方(产生新版本)', ok(bumped), `code=${bumped.code}`)

  // ══════════ P7 Channel / Agent / 绑定 / 任务 ══════════
  console.log('\n── P7 Channel 团队 · 节点绑定 · 任务 ──')
  const chName = `烘干线工艺组-${TAG}`
  const ch = data(await api('POST', '/api/workshop/channels', {
    body: {
      name: chName,
      description: '涂布烘干线工艺调优(温/速/张力)',
      leadAgent: { name: `调度长-${TAG}`, harness: 'mock', config: { delayMs: 40 } },
    },
  }))
  const channelId = ch.channelId ?? ch.id
  check('P7.1 Channel 创建(lead=mock 调度长)', Boolean(channelId), channelId?.slice(0, 8))

  const harness = SKIP_AGENT ? 'mock' : 'omp'
  const workerTpl = data(await api('POST', '/api/workshop/agents', {
    body: {
      name: `工艺员-${TAG}`,
      harness,
      config: { systemPromptPrefix: '你是涂布烘干线的工艺操作员。只使用工业工具读取与调整参数,步骤化执行,不做额外操作。' },
    },
  }))
  const workerId = workerTpl.id
  if (workerId) await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: workerId, role: 'worker' } })
  check(`P7.2 工艺员 Agent 入队(harness=${harness})`, Boolean(workerId), workerId?.slice(0, 8))

  // 数采 auto / 数控 manual(manual = 下发需人工审批,生产上就应该这么配)
  for (const c of CIRCUITS) {
    for (const [kind, id, mode] of [['daq', state.circuits[c.key].daq, 'auto'], ['dcw', state.circuits[c.key].dcw, 'manual']]) {
      const b = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: workerId, nodeId: id, kind, mode } })
      if (!ok(b)) check(`P7.3 ${c.label} ${kind} 绑定(${mode})`, false, JSON.stringify(b).slice(0, 120))
    }
  }
  const bindings = data(await api('GET', `/api/workshop/agent-tools/bindings?agentId=${workerId}`))
  const bList = Array.isArray(bindings) ? bindings : (bindings.bindings ?? [])
  check('P7.3 六个节点绑定完成(3 数采 auto + 3 数控 manual)', bList.length >= 6, `bindings=${bList.length}`)

  if (!SKIP_AGENT && workerId) {
    const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
      body: {
        title: `烘干线工艺巡检-${TAG}`,
        parts: [{ text: `用 daq_query 读取「烘箱温度采集-${TAG}」「产线速度采集-${TAG}」「膜张力采集-${TAG}」最近 5 分钟数据,汇总三者的均值与波动,判断是否处于稳态,然后把结论写入 complete_task。` }],
        assigneeId: workerId,
      },
    })
    const taskId = data(task).task?.id ?? data(task).id
    check('P7.4 巡检任务下发', Boolean(taskId), taskId?.slice(0, 8))
    info('… 等待 omp 真实 LLM 执行(2–4 分钟)…')
    const finalState = await waitFor('任务终态', async () => {
      const t = await api('GET', `/api/workshop/channels/${channelId}/tasks`)
      const me = (data(t) ?? []).find(x => x.id === taskId)
      return me && ['COMPLETED', 'FAILED', 'CANCELED'].includes(me.state) ? me.state : null
    }, 420_000, 4000)
    check('P7.5 任务终态(Agent 真实读取数采)', finalState === 'COMPLETED', `state=${finalState}`)
    state.taskId = taskId
  }

  // ══════════ P8 历史与留痕 ══════════
  console.log('\n── P8 数据与留痕核查 ──')
  const tempDaq = state.circuits.temp.daq
  // /samples 返回的是**按显示桶聚合**的点(每桶 15s,含 cnt),桶数不代表样本量 ——
  // 真正的样本量要把 cnt 求和,否则短窗口下会误判成"没数据"。
  const samplePts = data(await api('GET', `/api/workshop/daq/${tempDaq}/samples?limit=400`)).points ?? []
  const rawCount = samplePts.reduce((s, p) => s + Number(p.cnt ?? 0), 0)
  const ctrl = data(await api('GET', '/api/workshop/daq')).controller ?? {}
  check('P8.1 数采持续入库', rawCount >= 60 && Number(ctrl.samplesStored ?? 0) >= 60,
    `桶=${samplePts.length} 原始样本=${rawCount} samplesStored=${ctrl.samplesStored} produced=${ctrl.produced} dropped=${ctrl.dropped}`)
  check('P8.1b 采集过程无丢弃', Number(ctrl.dropped ?? 0) === 0, `dropped=${ctrl.dropped}`)
  check('P8.1c 越限触发过告警(启动阶段 PV 远低于量程)', Number(ctrl.alarmsRaised ?? 0) >= 1, `alarmsRaised=${ctrl.alarmsRaised}`)

  // 写历史:响应字段是 data.anchors(不是 entries/records)
  const anchors = data(await api('GET', '/api/workshop/dcw/journal?limit=200')).anchors ?? []
  const manualWrites = anchors.filter(a => a.source === 'manual')
  check('P8.2 数控写历史(签名写记录:谁/何时/前值→新值)', anchors.length >= 4,
    `${anchors.length} 条(manual ${manualWrites.length} · recipe ${anchors.length - manualWrites.length})`)
  check('P8.2b 人工调优写记录带操作者归因', manualWrites.length >= 3 && manualWrites.every(a => Boolean(a.actor)),
    manualWrites.slice(0, 3).map(a => `${a.prevValue}→${a.newValue}@${a.actor?.slice(0, 8)}`).join('  '))

  // 参数台账:data.ledger.journal
  const led = data(await api('GET', `/api/workshop/dcw/${state.circuits.temp.dcw}/param-ledger`)).ledger ?? {}
  const ledRows = led.journal ?? []
  check('P8.3 节点参数台账(当前值/配方目标/改动链)', ledRows.length >= 2 && led.current !== undefined,
    `current=${led.current} recipeTarget=${led.recipeTarget} 改动链=${ledRows.length} 条`)

  const versions = data(await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`)).versions ?? []
  check('P8.4 Recipe 版本历史(调优后落新版本)', versions.length >= 2, `${versions.length} 个版本`)

  const opsLogs = data(await api('GET', '/api/workshop/ops-logs?limit=300')).logs ?? []
  const kinds = [...new Set(opsLogs.map(l => l.kind))]
  check('P8.5 运维日志(全操作留痕,按产线可检索)', opsLogs.length >= 15,
    `${opsLogs.length} 条 / ${kinds.length} 类:${kinds.slice(0, 8).join(',')}`)
  const lineLogs = data(await api('GET', `/api/workshop/ops-logs?lineId=${line.id}&limit=300`)).logs ?? []
  check('P8.5b 运维日志可按产线维度过滤', lineLogs.length >= 10, `本产线 ${lineLogs.length} 条`)

  const runs = data(await api('GET', `/api/workshop/dcw/runs?lineId=${line.id}`)).runs ?? []
  check('P8.6 批次运行记录(Run + 配方 + 产品)', runs.length >= 1, `${runs.length} 个 run · tag=${runs[0]?.id?.slice(0, 8)}`)

  const twins = data(await api('GET', '/api/workshop/device-twins')).twins ?? []
  const withModel = twins.filter(t => t.modelRef)
  check('P8.7 数字孪生实体已落位且都带模型', twins.length >= 6 && withModel.length === twins.length,
    `${twins.length} 个实体,${withModel.length} 个带 modelRef`)

  // ══════════ P9 孪生小镇:建 workspace → 挂载 Channel → 铺领地 ══════════
  // 缺了这一步,/town 会显示"还没有挂载任何 Channel" —— 3D 场景只渲染**已挂载**的频道。
  console.log('\n── P9 数字孪生小镇:频道挂载与领地落位 ──')
  const ws = data(await api('POST', '/api/workshop/workspaces', { body: { name: `烘干线数字化车间-${TAG}` } }))
  const wsId = ws.id ?? ws.workspace?.id
  check('P9.1 workspace 创建', Boolean(wsId), wsId)
  const mounted = await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`)
  check('P9.2 Channel 挂载进小镇(3D 场景的前提)', ok(mounted), `code=${mounted.code}`)
  const layout = data(await api('PUT', `/api/workshop/scene/layouts/${channelId}`, {
    body: { x: 0, z: 0, radiusX: 22, radiusZ: 16, shape: 'ellipse' },
  })).layout
  check('P9.3 频道领地铺开(设备与 Agent 落在领地内)', Boolean(layout?.channelId ?? layout?.x !== undefined), JSON.stringify(layout ?? {}).slice(0, 120))
  const town = data(await api('GET', '/api/workshop/workspaces'))
  const wsList = Array.isArray(town) ? town : (town.workspaces ?? [])
  const mountedIds = wsList.flatMap(w => w.channelIds ?? [])
  check('P9.4 小镇已挂载该频道(页面据此决定渲染)', mountedIds.includes(channelId), `workspaces=${wsList.length} 挂载频道=${mountedIds.length}`)
  state.town = { workspaceId: wsId, channelId, mounted: mountedIds.includes(channelId) }

  Object.assign(state, {
    admin: ADMIN,
    line: { id: line.id, name: line.name },
    product: { id: prod.id, name: prod.name },
    recipe: { id: recipe.id, name: recipe.name },
    channel: { id: channelId, name: chName },
    workerId,
    counts: { rawSamples: rawCount, buckets: samplePts.length, anchors: anchors.length, manualWrites: manualWrites.length, ledgerRows: ledRows.length, versions: versions.length, opsLogs: opsLogs.length, lineLogs: lineLogs.length, runs: runs.length, twins: twins.length },
    ledger: { current: led.current, recipeTarget: led.recipeTarget },
  })
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8')
  console.log(`\n  状态已写入 ${STATE}`)
}

main()
  .then(() => {
    console.log(`\n${fail ? '✖' : '✅'} PLC 全新环境演练:${pass} 通过 / ${fail} 失败`)
    process.exitCode = fail ? 1 : 0
  })
  .catch((err) => {
    console.error('\n✖ 演练中断:', err?.stack ?? err)
    process.exit(1)
  })
