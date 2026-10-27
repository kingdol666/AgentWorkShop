/**
 * MQTT 协议专项 E2E(2026-10-27 审计)
 *
 * 覆盖(全部真实链路,不 mock 协议栈):
 *  A. 模拟器侧:内置 broker 监听 / 设备周期发布 / retained 状态 / 命令主题回灌
 *  B. 平台被动订阅入库:每条报文一行,时间戳=到达时刻,节奏=设备发布周期(不是 DAQ intervalMs)
 *  C. 停发不伪造:设备停发后 0 新增样本 + 节点 offline + 可读 lastError;恢复发布自愈
 *  D. 多节点同 broker:两条 MQTT 节点并行入库
 *  E. 外部 broker(默认 127.0.0.1:1883,可用 AW_E2E_EXTERNAL_MQTT 覆盖):订阅入库 + 写回
 *  F. DCW 写回:直写落到设备 / 状态主题回读 / 批量下发 readback-verified
 *  G. Agent daq_query:库内最新值(不是最旧段)、agg、新鲜度、越权拒绝
 *  H. 生命周期:网关停止即停收、恢复即续采;测试结束清理进程
 *
 * 运行:
 *   npm run build            # 平台产物(或 AW_E2E_BASE 指向已运行实例)
 *   node scripts/e2e-mqtt-protocol.mjs
 * 环境:
 *   AW_E2E_BASE        复用已运行平台(否则自起 .output/server/index.mjs)
 *   AW_E2E_PORT        平台端口(默认 3021)
 *   AW_E2E_SIM_BASE    模拟器地址(默认 http://127.0.0.1:4021,影子实例)
 *   AW_E2E_KEEP=1      保留临时 home/进程(排障用)
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PLATFORM_PORT = Number(process.env.AW_E2E_PORT ?? 3021)
const PLATFORM_BASE = process.env.AW_E2E_BASE ?? `http://127.0.0.1:${PLATFORM_PORT}`
const SIM_BASE = process.env.AW_E2E_SIM_BASE ?? 'http://127.0.0.1:4021'
const SIM_PORT = Number(new URL(SIM_BASE).port || 4021)
const BROKER_PORT = 18830 + (SIM_PORT - 4010) * 1000
const EXTERNAL_MQTT = process.env.AW_E2E_EXTERNAL_MQTT ?? 'mqtt://127.0.0.1:1883'
const TAG = Date.now().toString(36)
const KEEP = process.env.AW_E2E_KEEP === '1'
const EMAIL = `mqtt-${TAG}@aw.local`
const PASSWORD = `MqttE2E!${randomBytes(8).toString('hex')}`

const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** E2E 用户插件:注册自定义解码器(证明 ctx.daq.registerDecoder 统一接口可由用户扩展) */
const USER_PLUGIN_SRC = `export default {
  name: 'mqtt-e2e-sink',
  version: '1.0.0',
  setup(ctx) {
    ctx.daq.registerDecoder('e2e-sum-xy', (input) => {
      const j = JSON.parse(input.raw)
      const x = Number(j.x), y = Number(j.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y 必须是数字')
      return { kind: 'scalar', value: x + y }
    })
    ctx.daq.registerDecoder('e2e-vec-add', (input) => {
      const j = JSON.parse(input.raw)
      const a = Array.isArray(j.a) ? j.a : []
      const b = Array.isArray(j.b) ? j.b : []
      if (a.length === 0 || a.length !== b.length) throw new Error('a/b 必须是等长非空数组')
      return { kind: 'vector', points: a.map((v, i) => Number(v) + Number(b[i])) }
    })
    ctx.daq.registerProcessor('vector', 'e2e-tag', (frame) => ({
      ...frame,
      metrics: { ...(frame.metrics ?? {}), e2e_tag: 1 },
    }))
  },
}
`

let pass = 0
let fail = 0
let skip = 0
const failures = []
/** 登录后统一注入:GET 辅助函数(如 samples/nodeOf)不必逐处显式传 token */
let AUTH_TOKEN = ''
function ok(id, name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(`${id} ${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return Boolean(cond)
}
function skipped(id, name, detail = '') {
  skip++
  console.log(`  SKIP  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function http(base, method, path, { body, token, agentToken, timeout = 30_000 } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(agentToken ? { 'x-aw-agent-token': agentToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json, data: json?.data ?? json }
}
const api = (method, path, opts = {}) => http(PLATFORM_BASE, method, path, { token: AUTH_TOKEN, ...opts })
const sim = (method, path, body) => http(SIM_BASE, method, path, { body })

async function waitFor(name, fn, timeoutMs = 15_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    }
    catch (err) {
      last = err
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout:${name} last=${String(last?.message ?? last).slice(0, 200)}`)
}

// ───────────────────────── 进程生命周期 ─────────────────────────
const spawned = []
function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  }
  catch { /* 已退出 */ }
}

async function startupPlatform() {
  const up = await http(PLATFORM_BASE, 'GET', '/api/users/setup-status').catch(() => null)
  if (up?.status === 200) return { pid: null, home: null, reused: true }
  const entry = join(REPO, '.output', 'server', 'index.mjs')
  if (!existsSync(entry)) throw new Error(`平台产物不存在: ${entry} —— 先执行 npm run build,或用 AW_E2E_BASE 指向已运行实例`)
  const home = mkdtempSync(join(tmpdir(), `aw-mqtt-e2e-${TAG}-`))
  // 用户插件(自定义解码器)必须在 spawn 前落盘 → 插件宿主启动时装载
  const pluginDir = join(home, 'plugins', 'mqtt-e2e-sink')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'index.mjs'), USER_PLUGIN_SRC, 'utf8')
  const child = spawn(process.execPath, [entry], {
    cwd: REPO,
    env: { ...process.env, ...NO_PROXY, AW_MODE: 'home', AW_HOME: home, PORT: String(PLATFORM_PORT), NUXT_SESSION_PASSWORD: randomBytes(24).toString('hex') },
    stdio: 'ignore',
    windowsHide: true,
  })
  spawned.push({ pid: child.pid, home })
  await waitFor('platform ready', async () => (await http(PLATFORM_BASE, 'GET', '/api/users/setup-status')).status === 200, 120_000, 1500)
  return { pid: child.pid, home, reused: false }
}

async function loginOrRegister() {
  const st = await api('GET', '/api/users/setup-status')
  if (st.data?.needsSetup) {
    const reg = await api('POST', '/api/users/register', { body: { email: EMAIL, password: PASSWORD, name: `MQTT E2E ${TAG}` } })
    return reg.data?.token ?? ''
  }
  const login = await api('POST', '/api/users/login', { body: { email: process.env.AW_E2E_EMAIL ?? 'admin@aw.local', password: process.env.AW_E2E_PASSWORD ?? '' } })
  return login.data?.token ?? ''
}

async function ensureSimulator() {
  process.env.SIM_BASE = SIM_BASE
  process.env.SIM_PORT = String(SIM_PORT)
  // worktree 里 plc-node-simulator 是 junction:cpSync 会把 junction 本身当 symlink 复制而 EEXIST。
  // 解析到真实目录(主检出)后再做影子拷贝。
  process.env.SIM_DIR = realpathSync(join(REPO, 'plc-node-simulator'))
  process.env.SIM_SHADOW_DIR = join(tmpdir(), `aw-mqtt-e2e-sim-${TAG}`)
  const mod = await import('../bench/lib/sim.mjs')
  const r = await mod.ensureSimulator({ timeoutMs: 120_000, log: m => console.log(`  · ${m}`) })
  if (!r.started && r.reason !== 'already-up') throw new Error(`模拟器未就绪: ${r.reason}`)
  if (r.started) spawned.push({ pid: r.pid, simShadow: process.env.SIM_SHADOW_DIR })
  return mod
}

async function mqttLib() {
  const { default: mqtt } = await import('mqtt')
  return mqtt
}

async function connectClient(mqtt, url) {
  return mqtt.connectAsync(url, { connectTimeout: 5000, reconnectPeriod: 0 })
}

// ───────────────────────── 夹具 ─────────────────────────
async function createLineFixture(token) {
  const line = await api('POST', '/api/workshop/dcw/lines', { token, body: { name: `MQTT-E2E-${TAG}` } })
  const lineId = line.data?.line?.id
  const product = await api('POST', '/api/workshop/dcw/products', { token, body: { lineId, name: `MQTT-E2E-P-${TAG}` } })
  const productId = product.data?.product?.id
  if (!lineId || !productId) throw new Error(`建线失败: ${JSON.stringify(line).slice(0, 200)}`)
  return { lineId, productId }
}

async function createDaq(token, { lineId, name, driverConfig, intervalMs = 1000, staleMs = 3000 }) {
  const r = await api('POST', '/api/workshop/daq', {
    token,
    body: {
      name, templateRef: 'daq-temp-tc', driver: 'mqtt',
      driverConfig: { ...driverConfig, staleMs },
      unit: '℃', min: 0, max: 100, lineId, intervalMs, publishIntervalMs: 0,
      semantics: 'MQTT E2E 数采节点(被动订阅)',
    },
  })
  const id = r.data?.node?.id
  if (!id) throw new Error(`建 DAQ 失败: ${JSON.stringify(r).slice(0, 200)}`)
  return id
}

async function createDcw(token, { lineId, name, driverConfig }) {
  const r = await api('POST', '/api/workshop/dcw', {
    token,
    body: {
      name, templateRef: 'dcw-temp-sp', driver: 'mqtt', driverConfig,
      unit: '℃', min: 0, max: 100, decimals: 1, lineId, holdIntervalMs: 0,
      semantics: 'MQTT E2E 写控节点',
    },
  })
  const id = r.data?.node?.id
  if (!id) throw new Error(`建 DCW 失败: ${JSON.stringify(r).slice(0, 200)}`)
  return id
}

async function samples(nodeId, fromMs, toMs, bucketMs = 1000) {
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=${bucketMs}&from=${fromMs}&to=${toMs}&limit=5000`)
  return r.data?.points ?? []
}

async function nodeOf(nodeId) {
  const r = await api('GET', '/api/workshop/daq')
  return (r.data?.nodes ?? []).find(n => n.id === nodeId)
}

/** 独立订阅抓取设备真值(与平台无关的旁路证据) */
async function captureTopic(mqtt, url, topic, jsonPath, ms) {
  const client = await connectClient(mqtt, url)
  const got = []
  await client.subscribeAsync(topic, { qos: 1 })
  client.on('message', (t, payload) => {
    if (t !== topic) return
    try {
      const obj = JSON.parse(payload.toString())
      const v = String(jsonPath).split('.').reduce((a, k) => a?.[k], obj)
      if (Number.isFinite(Number(v))) got.push({ at: Date.now(), value: Number(v) })
    }
    catch { /* 忽略非 JSON */ }
  })
  await sleep(ms)
  await client.endAsync(true).catch(() => {})
  return got
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  console.log(`━━━ MQTT 协议专项 E2E (tag=${TAG}) ━━━`)
  const plat = await startupPlatform()
  const token = await loginOrRegister()
  if (!token) throw new Error('登录/注册失败(设置 AW_E2E_EMAIL / AW_E2E_PASSWORD,或使用全新实例)')
  AUTH_TOKEN = token
  ok('A0', '平台在线 + 管理员会话', true, PLATFORM_BASE)

  const simLib = await ensureSimulator()
  const devices = await simLib.applyPreset('film-line')
  const dev = devices.find(d => d.protocol === 'mqtt')
  if (!dev) throw new Error('film-line 预设无 MQTT 设备')
  const exp = await simLib.simExport(dev.id)
  const daqItem = exp.items.find(i => i.signal === 'temp')
  const dcwItem = exp.items.find(i => i.signal === 'tempSP')
  const brokerUrl = `mqtt://127.0.0.1:${BROKER_PORT}`
  ok('A1', '模拟器内置 broker 监听', Boolean(daqItem?.driverConfig?.port === BROKER_PORT), `期望 ${BROKER_PORT}, export=${JSON.stringify(daqItem?.driverConfig ?? {})}`)
  ok('A2', 'MQTT 写信号导出含状态回读主题', Boolean(dcwItem?.driverConfig?.readTopic), `readTopic=${dcwItem?.driverConfig?.readTopic ?? '缺失'}`)

  const mqtt = await mqttLib()
  const telemetry = daqItem.driverConfig.topic
  const stateTopic = dcwItem.driverConfig.readTopic
  const jp = daqItem.driverConfig.jsonPath
  // A3:独立订阅端收到设备周期发布
  const probe = await captureTopic(mqtt, brokerUrl, telemetry, jp, 6000)
  ok('A3', '设备周期发布遥测(独立订阅端)', probe.length >= 2, `${probe.length} 条 / 6s,样例 ${probe.slice(-3).map(x => x.value).join(',')}`)
  // A4:retained 状态主题(晚订阅立即拿到)
  {
    const c = await connectClient(mqtt, brokerUrl)
    let retained = null
    const t0 = Date.now()
    c.on('message', (t, p) => {
      if (t === stateTopic) retained = { p: p.toString(), at: Date.now() }
    })
    await c.subscribeAsync(stateTopic, { qos: 1 })
    await sleep(1200)
    await c.endAsync(true).catch(() => {})
    ok('A4', '状态主题 retained(晚订阅即时可取)', Boolean(retained) && Date.now() - t0 < 1500, retained?.p?.slice(0, 80) ?? '无消息')
  }

  // ── 平台夹具 ──
  const gw = await api('POST', '/api/workshop/daq/controller', { token, body: { action: 'start' } })
  ok('B0', 'DAQ 网关启动', gw.status === 200 && gw.data?.controller?.running !== false)
  const { lineId, productId } = await createLineFixture(token)
  const daqId = await createDaq(token, { lineId, name: `MQTT-DAQ1-${TAG}`, driverConfig: daqItem.driverConfig })
  const dcwId = await createDcw(token, { lineId, name: `MQTT-DCW1-${TAG}`, driverConfig: dcwItem.driverConfig })
  const dcw2Id = await createDcw(token, { lineId, name: `MQTT-DCW2-${TAG}`, driverConfig: dcwItem.driverConfig })
  const recipe = await api('POST', '/api/workshop/dcw/recipes', {
    token,
    body: {
      productId, name: `MQTT-E2E-R-${TAG}`, description: 'mqtt e2e',
      params: [{ nodeId: dcw2Id, value: 60, min: 55, max: 65 }],
      daqWindows: [{ nodeId: daqId, min: 0, max: 100 }],
    },
  })
  const recipeId = recipe.data?.recipe?.id
  const started = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { token, body: { recipeId } })
  ok('B1', '产线开跑(配方 + 监控窗口)', started.status === 200 && Boolean(started.data?.run?.id), started.data?.run?.id ?? started.json?.message)

  // ── B2/B3/B4:被动入库对账 ──
  const capStart = Date.now()
  const truth = await captureTopic(mqtt, brokerUrl, telemetry, jp, 14_000)
  const capEnd = Date.now()
  const rows = await samples(daqId, capStart - 1500, capEnd + 1500)
  ok('B2', 'MQTT 报文逐条入库(独立真值对账)', Math.abs(rows.length - truth.length) <= 2, `DB ${rows.length} 行 / 真值 ${truth.length} 条`)
  {
    // 按「时间邻近 + 值容差」对齐(节点 decimals=1 会量化真值 2 位小数)
    const used = new Set()
    let hit = 0
    for (const t of truth) {
      const idx = rows.findIndex((r, i) => !used.has(i) && Math.abs(r.at - t.at) <= 2500 && Math.abs(r.avg - t.value) <= 0.06)
      if (idx >= 0) {
        used.add(idx)
        hit++
      }
    }
    ok('B3', '入库值与设备发布值一致(逐条对齐)', truth.length > 0 && hit >= truth.length - 2, `对齐 ${hit}/${truth.length}`)
  }
  {
    const gaps = rows.slice(1).map((r, i) => r.at - rows[i].at).filter(g => g > 0)
    const median = gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? 0
    // 设备 tickMs=2000;节点 intervalMs=1000。节奏≈2s 证明不是按 intervalMs 轮询缓存。
    ok('B4', '入库节奏=设备发布周期(非 intervalMs 轮询)', median >= 1500 && median <= 2600, `中位间隔 ${median}ms(设备 tick=2000,节点 interval=1000)`)
    const mono = rows.every((r, i) => i === 0 || r.at > rows[i - 1].at)
    ok('B5', '库内时间戳严格递增(到达时刻)', mono, `${rows[0]?.at} → ${rows[rows.length - 1]?.at}`)
  }

  // ── B6:端到端入库时延(手工值 → 库内可查) ──
  {
    const t0 = Date.now()
    await simLib.simManual(dev.id, 'mqtt-temp', 77.7)
    await waitFor('manual value in db', async () => {
      const pts = await samples(daqId, t0 - 1000, Date.now())
      return pts.find(p => Math.abs(p.avg - 77.7) < 0.05) ?? null
    }, 6000, 400)
    ok('B6', '报文到达 → 库内可查 ≤ 4s', Date.now() - t0 <= 4000, `${Date.now() - t0}ms`)
  }

  // ── B7:采集管线无丢弃(镜像完整性) ──
  {
    await sleep(1500)
    const cs = (await api('GET', '/api/workshop/daq')).data?.controller
    ok('B7', '采集管线无丢弃(produced=consumed, dropped=0)', Boolean(cs) && cs.dropped === 0 && Number(cs.consumed) === Number(cs.produced), JSON.stringify({ produced: cs?.produced, consumed: cs?.consumed, dropped: cs?.dropped, stored: cs?.samplesStored }))
  }

  // ── B8:UI 趋势路径(from 缺省)limit=1 必须取最新桶 ──
  {
    // 恢复随机游走,使旧段/新段可区分(否则常值下 tail 与最旧段无法证伪)
    await sim('POST', `/api/nodes/${dev.id}/signals/mqtt-temp/strategy`, { strategy: { kind: 'random-walk', start: 50, step: 3, min: 30, max: 75 } })
    await sleep(7000)
    const now = Date.now()
    const unbounded = (await api('GET', `/api/workshop/daq/${daqId}/samples?bucketMs=1000&to=${now}&limit=1`)).data?.points ?? []
    const bounded = (await samples(daqId, now - 120_000, now)).slice(-1)
    ok('B8', '/samples 无 from 时 limit=1 = 最新桶(UI 路径)', unbounded.length === 1 && bounded.length === 1 && Math.abs(unbounded[0].at - bounded[0].at) <= 1000, `unbounded=${unbounded[0]?.avg}@${unbounded[0]?.at} bounded=${bounded[0]?.avg}@${bounded[0]?.at}`)
  }

  // ── C:停发不伪造 + 恢复自愈 ──
  {
    const stop = await sim('POST', '/api/nodes/' + dev.id + '/stop', {})
    const t0 = Date.now()
    await sleep(9000)
    const rows2 = await samples(daqId, t0, Date.now())
    ok('C1', '设备停发 → 0 新增样本(不伪造冻值)', stop.status === 200 && rows2.length === 0, `${rows2.length} 行`)
    const n = await nodeOf(daqId)
    ok('C2', '停发 → 节点 offline + 可读 lastError', n?.state === 'offline' && /未收到报文|未收到首条/.test(String(n?.lastError ?? '')), `${n?.state} / ${String(n?.lastError ?? '').slice(0, 60)}`)
    await sim('POST', '/api/nodes/' + dev.id + '/start', {})
    const t1 = Date.now()
    const resumed = await waitFor('resume rows', async () => {
      const pts = await samples(daqId, t1, Date.now())
      return pts.length >= 2 ? pts : null
    }, 10_000, 800)
    // 报文恢复后状态由运行时重新派生;给一个短窗口等 watchdog/状态收敛
    const n2 = await waitFor('node ok after resume', async () => {
      const n = await nodeOf(daqId)
      return n?.state === 'ok' && !n?.lastError ? n : null
    }, 6_000, 500).catch(() => nodeOf(daqId))
    ok('C3', '恢复发布 → 自动续采 + 状态自愈', resumed.length >= 2 && n2?.state === 'ok' && !n2?.lastError, `${resumed.length} 行 / state=${n2?.state} / err=${String(n2?.lastError ?? '')}`)
  }

  // ── D:多节点同 broker ──
  {
    const dev2 = {
      id: `mqtt-e2e-dev2-${TAG}`,
      name: `MQTT E2E Sensor 2 ${TAG}`,
      protocol: 'mqtt',
      tickMs: 1000,
      signals: [{ id: 'temp2', name: 'temp2', unit: '℃', min: 0, max: 100, decimals: 2, strategy: { kind: 'manual', value: 42 } }],
      config: {
        brokerUrl,
        topics: [{ topic: `aw/e2e/${TAG}/temp2`, signalId: 'temp2', payloadTemplate: '{"data":{"temp":${value}}}', qos: 0 }],
      },
    }
    const cr = await sim('POST', '/api/nodes', dev2)
    ok('D0', '第二台 MQTT 设备创建', cr.status === 200, cr.data?.id ?? cr.json?.message)
    const exp2 = await simLib.simExport(dev2.id)
    const item2 = exp2.items.find(i => i.signal === 'temp2')
    const daq2 = await createDaq(token, { lineId, name: `MQTT-DAQ2-${TAG}`, driverConfig: item2.driverConfig })
    const t0 = Date.now()
    await sleep(8000)
    const r1 = await samples(daqId, t0, Date.now())
    const r2 = await samples(daq2, t0, Date.now())
    ok('D1', '同 broker 两节点并行入库', r1.length >= 2 && r2.length >= 4, `node1 ${r1.length} 行 / node2 ${r2.length} 行`)
  }

  // ── E:外部 broker(1883)──
  {
    let ext = null
    try {
      ext = await connectClient(mqtt, EXTERNAL_MQTT)
    }
    catch { ext = null }
    if (!ext) {
      skipped('E1', `外部 broker ${EXTERNAL_MQTT} 不可达`, '启动 docker mosquitto 或设置 AW_E2E_EXTERNAL_MQTT')
    }
    else {
      const topic = `aw/e2e/${TAG}/ext`
      const cmd = `aw/e2e/${TAG}/ext/set`
      const state = `aw/e2e/${TAG}/ext/state`
      // 设备模拟:收到命令 → 回显 retained 状态
      let lastCmd = null
      ext.on('message', (t, p) => {
        if (t !== cmd) return
        try {
          lastCmd = JSON.parse(p.toString()).setpoint
        }
        catch { lastCmd = Number(p.toString()) }
        if (Number.isFinite(lastCmd)) ext.publish(state, JSON.stringify({ setpoint: lastCmd }), { qos: 0, retain: true })
      })
      await ext.subscribeAsync(cmd, { qos: 1 })
      const pub = setInterval(() => ext.publish(topic, JSON.stringify({ data: { temp: 123.4 } }), { qos: 0 }), 1000)
      const daqExt = await createDaq(token, { lineId, name: `MQTT-DAQ-EXT-${TAG}`, driverConfig: { host: '127.0.0.1', port: 1883, topic, jsonPath: 'data.temp' } })
      const dcwExt = await createDcw(token, { lineId, name: `MQTT-DCW-EXT-${TAG}`, driverConfig: { host: '127.0.0.1', port: 1883, topic: cmd, jsonKey: 'setpoint', readTopic: state, readJsonPath: 'setpoint' } })
      const t0 = Date.now()
      await sleep(7000)
      const extRows = await samples(daqExt, t0, Date.now())
      clearInterval(pub)
      ok('E1', '外部 broker 订阅入库(标准 mosquitto)', extRows.length >= 3 && extRows.every(r => Math.abs(r.avg - 123.4) < 1e-6), `${extRows.length} 行`)
      const w = await api('POST', `/api/workshop/dcw/${dcwExt}/write`, { token, body: { value: 44.4 } })
      await sleep(800)
      const rd = await api('POST', `/api/workshop/dcw/${dcwExt}/read`, { token, body: {} })
      ok('E2', '外部 broker 写回 → 设备回显 → 平台回读', w.status === 200 && Number(lastCmd) === 44.4 && Number(rd.data?.read?.value) === 44.4, `lastCmd=${lastCmd} read=${rd.data?.read?.value} msg=${String(rd.data?.read?.message ?? '').slice(0, 100)}`)
      await ext.endAsync(true).catch(() => {})
    }
  }

  // ── F:DCW 写回 + 回读验证 ──
  {
    const current = (await simLib.simNodes()).find(n => n.id === dev.id)?.signals?.find(s => s.id === 'mqtt-sp')?.value ?? 60
    const target = Math.max(10, Math.min(90, Number(current) + 1.5))
    const w = await api('POST', `/api/workshop/dcw/${dcwId}/write`, { token, body: { value: target } })
    await sleep(1000)
    const simVal = (await simLib.simNodes()).find(n => n.id === dev.id)?.signals?.find(s => s.id === 'mqtt-sp')?.value
    // 周期读与手动读共用同一在飞闸门:写入后的那一刻周期读可能正在等回显,409 属预期,重试即可
    let rdRead = null
    for (let i = 0; i < 6; i++) {
      const r = await api('POST', `/api/workshop/dcw/${dcwId}/read`, { token, body: {} })
      if (r.data?.read?.ok) {
        rdRead = r.data.read
        break
      }
      await sleep(700)
    }
    ok('F1', 'MQTT 直写 → 设备信号变化', w.status === 200 && Math.abs(Number(simVal) - target) < 1e-6, `target=${target} sim=${simVal}`)
    ok('F2', 'MQTT 写后回读(readTopic)= 写入值', Number(rdRead?.value) === Number(simVal), `read=${rdRead?.value} msg=${String(rdRead?.message ?? '').slice(0, 80)}`)
    // 批量下发(配方 apply)应把 transport-ack 补验成 readback-verified
    const nowVal = Number(simVal)
    const newVal = Math.max(10, Math.min(90, nowVal + 1.5))
    await api('PATCH', `/api/workshop/dcw/recipes/${recipeId}`, { token, body: { params: [{ nodeId: dcw2Id, value: newVal, min: 55, max: 65 }] } })
    // 写间隔闸门(60s):直接 apply 可能 429;等待窗口内重试一次
    let apply = await api('POST', `/api/workshop/dcw/recipes/${recipeId}/apply`, { token, body: {} })
    if (apply.status === 429) {
      await sleep(62_000)
      apply = await api('POST', `/api/workshop/dcw/recipes/${recipeId}/apply`, { token, body: {} })
    }
    const res = apply.data?.run?.results?.[0]
    ok('F3', '配方批量下发 → 回读证实(readback-verified)', apply.status === 200 && res?.verify?.verdict === 'verified' && res?.ack === 'readback-verified', JSON.stringify(res?.verify ?? res).slice(0, 160))
    const sum = apply.data?.run?.ackSummary
    ok('F4', 'ACK 汇总无未证实/失败', sum?.verified >= 1 && sum?.unverified === 0 && sum?.failed === 0, JSON.stringify(sum))
  }

  // ── G:Agent daq_query(库内最新值 + agg + 新鲜度)──
  {
    const ch = await api('POST', '/api/workshop/channels', { token, body: { name: `mqtt-e2e-${TAG}`, leadAgent: { name: `mqtt-lead-${TAG}`, harness: 'mock', config: { delayMs: 50 } } } })
    const channelId = ch.data?.channelId
    const agent = await api('POST', '/api/workshop/agents', { token, body: { name: `mqtt-qa-${TAG}`, harness: 'mock', config: {} } })
    const join = await api('POST', `/api/workshop/channels/${channelId}/agents`, { token, body: { agentId: agent.data?.id, role: 'worker' } })
    const instId = join.data?.id
    const bind = await api('POST', '/api/workshop/agent-tools/bindings', { token, body: { agentId: instId, nodeId: daqId, kind: 'daq', mode: 'auto' } })
    ok('G0', 'Agent 建号 + DAQ 绑定', Boolean(instId) && (bind.status === 200 || bind.json?.code === 0), `${instId} / ${JSON.stringify(bind.data ?? bind.json).slice(0, 120)}`)
    const invoke = (tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { token, body: { agentId: instId, tool, args } })
    // 先确保信号是变化的随机游走(B6 改成常值 77.7;常值下"最新"与"最旧段"不可区分)
    await sim('POST', `/api/nodes/${dev.id}/signals/mqtt-temp/strategy`, { strategy: { kind: 'random-walk', start: 50, step: 3, min: 30, max: 75 } })
    await sleep(6000)
    const q = await invoke('daq_query', { node_id: daqId, last_minutes: 2, bucket_ms: 1000, limit: 1 })
    const text = q.data?.result?.text ?? JSON.stringify(q.data?.result ?? {}).slice(0, 400)
    const dbWindow = await samples(daqId, Date.now() - 120_000, Date.now())
    const dbLast = dbWindow.slice(-1)[0]
    const dbFirst = dbWindow[0]
    const m = /最新\s+([\d.]+)/.exec(text)
    const latestInText = m ? Number(m[1]) : NaN
    const latestInDb = dbLast?.avg ?? NaN
    // 关键:窗口首样本与末样本必须不同(排除常值下的伪通过);文本最新 = 窗口末桶(节点 decimals=1)
    const distinguishable = dbFirst && dbLast && Math.abs(dbLast.avg - dbFirst.avg) > 0.2
    ok('G1', 'daq_query 最新值 = 窗口末尾桶(不是最旧段)', Number.isFinite(latestInText) && Math.abs(latestInText - latestInDb) < 0.06 && distinguishable, `text=${latestInText} dbLast=${latestInDb} dbFirst=${dbFirst?.avg}`)
    ok('G2', '输出含数据源与库内滞后声明', /数据源=时序库/.test(text) && /滞后\s+\d+s/.test(text), text.split('\n').find(l => l.includes('数据源'))?.slice(0, 120) ?? '缺失')
    const qmin = await invoke('daq_query', { node_id: daqId, last_minutes: 2, bucket_ms: 1000, limit: 50, agg: 'min' })
    const minText = qmin.data?.result?.text ?? ''
    const mMin = /最小\s+([-\d.]+)/.exec(minText)
    const minInText = mMin ? Number(mMin[1]) : NaN
    // 与 daq_query 同窗口同 limit:窗口末尾 50 个桶(不是整 2 分钟,避免窗口错配)
    const dbMin = Math.min(...dbWindow.slice(-50).map(p => Number(p.min)))
    ok('G3', 'agg=min 生效(输出最小值 = 库内窗口最小)', Number.isFinite(minInText) && Math.abs(minInText - dbMin) < 1e-6 && /聚合 min/.test(minText), `textMin=${minInText} dbMin=${dbMin}`)
    const qbad = await invoke('daq_query', { node_id: daqId, agg: 'bogus' })
    ok('G4', '非法 agg 明确报错(不静默回退)', /agg 只能是/.test(qbad.data?.result?.text ?? ''), (qbad.data?.result?.text ?? '').slice(0, 80))
    const qdeny = await invoke('daq_query', { node_id: 'dn-not-bound' })
    ok('G5', '未绑定节点被拒绝(授权面)', qdeny.data?.result?.isError === true || /无权查询/.test(qdeny.data?.result?.text ?? ''), (qdeny.data?.result?.text ?? '').slice(0, 80))
  }

  // ── H:网关停止即停收 / 恢复续采 ──
  {
    const stopCtrl = await api('POST', '/api/workshop/daq/controller', { token, body: { action: 'stop' } })
    const t0 = Date.now()
    await sleep(7000)
    const rows = await samples(daqId, t0, Date.now())
    ok('H1', '网关停止 → 被动订阅停收(0 新增)', stopCtrl.status === 200 && rows.length === 0, `${rows.length} 行`)
    await api('POST', '/api/workshop/daq/controller', { token, body: { action: 'start' } })
    const resumed = await waitFor('ctrl resume', async () => {
      const pts = await samples(daqId, t0 + 7000, Date.now())
      return pts.length >= 2 ? pts : null
    }, 10_000, 800)
    ok('H2', '网关恢复 → 订阅重建并继续入库', resumed.length >= 2, `${resumed.length} 行`)
  }

  // ── I:retained-only 主题:首订阅种子一次,重放不再入库 ──
  {
    const retainedTopic = `aw/e2e/${TAG}/retained`
    const pub = await connectClient(mqtt, brokerUrl)
    await pub.publishAsync(retainedTopic, JSON.stringify({ v: 12.3 }), { qos: 0, retain: true })
    // 优雅关闭前留出 broker 落盘时间(QoS0 后立刻 force-end 可能丢 retained)
    await sleep(400)
    await pub.endAsync(false).catch(() => {})
    await sleep(300)
    const daqRet = await createDaq(token, { lineId, name: `MQTT-DAQ-RETAIN-${TAG}`, driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: retainedTopic, jsonPath: 'v' } })
    const t0 = Date.now()
    const first = await waitFor('retained seed row', async () => {
      const pts = await samples(daqRet, t0 - 1500, Date.now())
      return pts.length >= 1 ? pts : null
    }, 10_000, 500)
    ok('I1', 'retained 首订阅种子一次(当前状态可查)', first.length >= 1 && Math.abs(first[0].avg - 12.3) < 0.06, `${first.length} 行 / ${first[0]?.avg}`)
    // 再发布一条 retained(模拟重连/重订阅时 broker 重放):seeded=true 后不再入库
    const again = await connectClient(mqtt, brokerUrl)
    await again.publishAsync(retainedTopic, JSON.stringify({ v: 12.3 }), { qos: 0, retain: true })
    await sleep(400)
    await again.endAsync(false).catch(() => {})
    await sleep(6000)
    const after = await samples(daqRet, t0 - 1500, Date.now())
    ok('I2', 'retained 重放不重复入库(静默期行数不增长)', after.length === first.length, `${first.length} → ${after.length}`)
  }

  // ── J:生命周期(节点停用/启用、topic 变更、EDA 尾段、停线门控)──
  {
    // J1 节点停用 → 停收;启用 → 续采
    await api('PATCH', `/api/workshop/daq/${daqId}`, { token, body: { enabled: false } })
    const t0 = Date.now()
    await sleep(4500)
    const offRows = await samples(daqId, t0, Date.now())
    await api('PATCH', `/api/workshop/daq/${daqId}`, { token, body: { enabled: true } })
    const resumed = await waitFor('reenable rows', async () => {
      const pts = await samples(daqId, t0 + 4500, Date.now())
      return pts.length >= 2 ? pts : null
    }, 10_000, 800)
    ok('J1', '节点停用即停收 / 启用即续采', offRows.length === 0 && resumed.length >= 2, `停用期 ${offRows.length} 行 / 恢复 ${resumed.length} 行`)

    // J2 topic 变更 → 指纹重建订阅,新主题数据入库
    const newTopic = `aw/e2e/${TAG}/temp2`
    await api('PATCH', `/api/workshop/daq/${daqId}`, { token, body: { driverConfig: { topic: newTopic, jsonPath: 'data.temp', staleMs: 3000 } } })
    const t1 = Date.now()
    const changed = await waitFor('topic change rows', async () => {
      const pts = await samples(daqId, t1, Date.now())
      return pts.length >= 3 && pts.every(p => Math.abs(p.avg - 42) < 0.06) ? pts : null
    }, 10_000, 800)
    ok('J2', 'topic 变更 → 订阅重建并采新主题', changed.length >= 3, `${changed.length} 行 / 值=${changed[0]?.avg}`)

    // J3 EDA 产线查询(窗口桶数 > limit)也必须取最新段
    {
      const to = Date.now()
      const q = await api('GET', `/api/workshop/daq/query?node_ids=${daqId}&last_minutes=60&bucket_ms=1000&limit=5`)
      const pts = q.data?.series?.[0]?.points ?? []
      const last = pts[pts.length - 1]
      ok('J3', 'EDA 查询窗口超 limit 时取最新段', pts.length > 0 && last && (to - last.at) < 5000, `${pts.length} 点 / 末点滞后 ${last ? Math.round((to - last.at) / 1000) : '?'}s`)
    }

    // J4 停线 → 停收;重新开跑 → 续采(订阅保持在线,门控在入库侧)
    await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, { token, body: {} })
    const t2 = Date.now()
    await sleep(5000)
    const stoppedRows = await samples(daqId, t2, Date.now())
    const restart = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { token, body: { recipeId } })
    const restarted = await waitFor('line restart rows', async () => {
      const pts = await samples(daqId, t2 + 5000, Date.now())
      return pts.length >= 2 ? pts : null
    }, 10_000, 800)
    ok('J4', '停线停收 / 重新开跑续采', restart.status === 200 && stoppedRows.length === 0 && restarted.length >= 2, `停线期 ${stoppedRows.length} 行 / 重启 ${restarted.length} 行`)
  }

  // ── K:停线期间的 retained 状态在开跑后补种;网关停止时外部入库如实 503 ──
  {
    const idleTopic = `aw/e2e/${TAG}/idle-retained`
    await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, { token, body: {} })
    const seedPub = await connectClient(mqtt, brokerUrl)
    await seedPub.publishAsync(idleTopic, JSON.stringify({ v: 23.4 }), { qos: 0, retain: true })
    await sleep(400)
    await seedPub.endAsync(false).catch(() => {})
    const daqIdle = await createDaq(token, { lineId, name: `MQTT-DAQ-IDLE-${TAG}`, driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: idleTopic, jsonPath: 'v' } })
    const t0 = Date.now()
    await sleep(4000)
    const idleRows = await samples(daqIdle, t0 - 1500, Date.now())
    // 快速停用/启用(5s 退订窗口内重用 entry):新绑定必须能从缓存 retained 补种
    await api('PATCH', `/api/workshop/daq/${daqIdle}`, { token, body: { enabled: false } })
    await sleep(300)
    await api('PATCH', `/api/workshop/daq/${daqIdle}`, { token, body: { enabled: true } })
    await sleep(2500)
    const afterToggle = await samples(daqIdle, t0 - 1500, Date.now())
    await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { token, body: { recipeId } })
    const seeded = await waitFor('idle retained seed on run start', async () => {
      const pts = await samples(daqIdle, t0 - 1500, Date.now())
      return pts.length >= 1 ? pts : null
    }, 10_000, 600)
    ok('K1', '停线期间 retained 状态在开跑后补种一次(含快速停用/启用)', idleRows.length === 0 && afterToggle.length === 0 && seeded.length >= 1 && Math.abs(seeded[0].avg - 23.4) < 0.06, `停线 ${idleRows.length} / 启停后 ${afterToggle.length} / 开跑 ${seeded.length} 行=${seeded[0]?.avg}`)
    // K2:网关停止时外部 /ingest 必须 503(不能 200 却无行)
    await api('POST', '/api/workshop/daq/controller', { token, body: { action: 'stop' } })
    const ing = await api('POST', `/api/workshop/daq/${daqId}/ingest`, { token, body: { value: 1 } })
    await api('POST', '/api/workshop/daq/controller', { token, body: { action: 'start' } })
    ok('K2', '网关停止时外部入库如实 503(不静默丢帧)', ing.status === 503, `status=${ing.status} msg=${String(ing.json?.message ?? '').slice(0, 80)}`)
  }

  // ── L:结构化 JSON → scalar/vector/image(节点创建时配置解析 + 用户 sink)──
  {
    // L0 节点创建表单暴露结构化解析字段(驱动目录 = 前端动态表单数据源)
    const meta = await api('GET', '/api/workshop/daq')
    const mqttMeta = (meta.data?.drivers ?? []).find(d => d.kind === 'mqtt')
    const mKeys = (mqttMeta?.configFields ?? []).map(f => f.key)
    ok('L0', '节点创建表单暴露结构化解析字段', ['pointsPath', 'metricsPath', 'imageFormat', 'imagePath', 'decoder'].every(k => mKeys.includes(k)), mKeys.join(','))
    // 帧管线对账基线(控制器 produced/consumed 是全局计数;只看本组增量,避免历史 retained 重放 late 计入)
    const lStatsBefore = (await api('GET', '/api/workshop/daq')).data?.controller ?? {}

    // L1 自定义 vector 模板:5 点 + 内置 sink(avg/zones)+ 插件处理器 e2e-tag
    const vecTplR = await api('POST', '/api/workshop/daq/templates', {
      token,
      body: {
        name: `结构化轮廓 ${TAG}`, ch: '结构化轮廓', unit: 'μm', min: 0, max: 100, decimals: 2,
        signalKind: 'vector', vector: { points: 5, min: 0, max: 100, pointUnit: 'μm' },
        sink: { processors: [{ name: 'derive-metric', args: { name: 'avg', op: 'avg' } }, { name: 'zones', args: { n: 2 } }, { name: 'e2e-tag' }] },
        metrics: [{ key: 'avg', label: '平均厚度', unit: 'μm' }],
      },
    })
    const vecTplKey = vecTplR.data?.template?.key
    const vecTopic = `aw/e2e/${TAG}/vec`
    const vecNodeR = await api('POST', '/api/workshop/daq', {
      token,
      body: {
        name: `MQTT-VEC-${TAG}`, templateRef: vecTplKey, driver: 'mqtt',
        driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: vecTopic, pointsPath: 'data.points', metricsPath: 'data.metrics', staleMs: 4000 },
        unit: 'μm', min: 0, max: 100, decimals: 2, lineId, intervalMs: 1000, publishIntervalMs: 0,
      },
    })
    const vecNode = vecNodeR.data?.node?.id
    ok('L1', '自定义 vector 模板 + 节点创建(数组路径配置)', Boolean(vecTplKey && vecNode), `${vecTplKey} / ${vecNode}`)
    const vecPub = await connectClient(mqtt, brokerUrl)
    const vecTimer = setInterval(() => vecPub.publish(vecTopic, JSON.stringify({ data: { points: [10, 20, 30, 40, 50], metrics: { avg: 30 } } }), { qos: 0 }), 1000)
    const vt0 = Date.now()
    await sleep(6000)
    clearInterval(vecTimer)
    const vecFramesR = await api('GET', `/api/workshop/daq/${vecNode}/frames?kind=vector&from=${vt0 - 1500}&to=${Date.now()}&limit=20`)
    const vecFrames = vecFramesR.data?.frames ?? []
    await vecPub.endAsync(true).catch(() => {})
    ok('L2', '结构化 JSON 数组 → vector 帧入库(5 点)', vecFrames.length >= 2 && vecFrames.every(f => f.points?.length === 5), `${vecFrames.length} 帧 / 点数 ${vecFrames[0]?.points?.length}`)
    // L0b 节点测试按模板形态解码(保存后的节点 test 传 signalKind)
    {
      const vt = await api('POST', `/api/workshop/daq/${vecNode}/test`, { token, body: {} })
      const msg = String(vt.data?.test?.message ?? JSON.stringify(vt.data ?? {}).slice(0, 120))
      ok('L0b', '节点测试按模板形态解码(vector 点数)', vt.status === 200 && /vector\s+\d+\s*点/.test(msg), msg.slice(0, 110))
    }
    ok('L3', '模板 sink 生效(avg/zones)且帧带批次元信息', vecFrames.length > 0 && Math.abs(vecFrames[0].metrics?.avg - 30) < 1e-6 && vecFrames[0].metrics?.zone1_avg === 15 && vecFrames[0].metrics?.zone2_avg === 40 && vecFrames[0].lineId === lineId && Boolean(vecFrames[0].runId), JSON.stringify({ m: vecFrames[0]?.metrics, line: vecFrames[0]?.lineId, run: vecFrames[0]?.runId }).slice(0, 180))
    // L2b 帧管线生产=消费(全局 late 计数可能含控制器重启时 retained 种子重放的乱序丢弃,非帧丢失)
    {
      await sleep(1500)
      const cs = (await api('GET', '/api/workshop/daq')).data?.controller ?? {}
      const d = k => Number(cs[k] ?? 0) - Number(lStatsBefore[k] ?? 0)
      ok('L2b', '帧管线生产=消费(本组)', d('produced') > 0 && d('consumed') === d('produced'), JSON.stringify({ dProduced: d('produced'), dConsumed: d('consumed'), dLate: d('dropped'), totalDropped: cs.dropped }))
    }
    if (!plat.reused) {
      ok('L4', '用户注册的 sink 处理器生效(e2e-tag)', vecFrames.some(f => f.metrics?.e2e_tag === 1), `e2e_tag=${vecFrames[0]?.metrics?.e2e_tag}`)
    }
    else {
      skipped('L4', '用户 sink 处理器需全新实例装载测试插件', 'AW_E2E_BASE 复用了已运行实例')
    }

    // L5 自定义 image 模板:JSON base64 → image 帧 + 对象存储 + 派生指标 + content 端点
    const png4 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAAAAACMmsGiAAAAHElEQVR4nGNQ0LFwYQiIyShhaOiZsYRhw54TVwA4pAehXZEW8wAAAABJRU5ErkJggg=='
    const imgTplR = await api('POST', '/api/workshop/daq/templates', {
      token,
      body: {
        name: `结构化图像 ${TAG}`, ch: '结构化图像', unit: 'px', min: 0, max: 255, decimals: 0,
        signalKind: 'image', sink: { processors: [{ name: 'quality-gate' }] },
        metrics: [{ key: 'brightness', label: '亮度', warnLow: 5, alarmLow: 1 }],
      },
    })
    const imgTplKey = imgTplR.data?.template?.key
    const imgTopic = `aw/e2e/${TAG}/img`
    const imgNodeR = await api('POST', '/api/workshop/daq', {
      token,
      body: {
        name: `MQTT-IMG-${TAG}`, templateRef: imgTplKey, driver: 'mqtt',
        driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: imgTopic, imageFormat: 'json', imagePath: 'data.png', imageWidthPath: 'data.w', imageHeightPath: 'data.h', staleMs: 5000 },
        unit: 'px', min: 0, max: 255, decimals: 0, lineId, intervalMs: 1000, publishIntervalMs: 0,
      },
    })
    const imgNode = imgNodeR.data?.node?.id
    ok('L5', '自定义 image 模板 + 节点创建(base64 图像字段)', Boolean(imgTplKey && imgNode), `${imgTplKey} / ${imgNode}`)
    const imgPub = await connectClient(mqtt, brokerUrl)
    const imgTimer = setInterval(() => imgPub.publish(imgTopic, JSON.stringify({ data: { png: png4, w: 4, h: 4 } }), { qos: 0 }), 2000)
    const it0 = Date.now()
    await sleep(6500)
    clearInterval(imgTimer)
    const imgFramesR = await api('GET', `/api/workshop/daq/${imgNode}/frames?kind=image&from=${it0 - 1500}&to=${Date.now()}&limit=10`)
    const imgFrames = imgFramesR.data?.frames ?? []
    const imgFrame = imgFrames[0]
    await imgPub.endAsync(true).catch(() => {})
    ok('L6', '结构化 JSON base64 → image 帧入库(尺寸/指纹/MIME)', imgFrames.length >= 1 && imgFrame?.meta?.width === 4 && imgFrame?.meta?.height === 4 && imgFrame?.meta?.mime === 'image/png' && String(imgFrame?.meta?.sha256 ?? '').length === 64 && Number(imgFrame?.meta?.size) > 0, JSON.stringify(imgFrame?.meta ?? {}).slice(0, 180))
    ok('L7', '图像 sink 派生指标(quality-gate brightness)', Number.isFinite(Number(imgFrame?.metrics?.brightness)), `brightness=${imgFrame?.metrics?.brightness}`)
    {
      const cres = await fetch(PLATFORM_BASE + String(imgFrame?.contentUrl ?? ''), { headers: { authorization: `Bearer ${token}` } })
      const cbuf = Buffer.from(await cres.arrayBuffer())
      ok('L8', '图像内容端点可回取(对象存储 → PNG)', cres.status === 200 && String(cres.headers.get('content-type') ?? '').includes('image/png') && cbuf.length === Number(imgFrame?.meta?.size), `status=${cres.status} bytes=${cbuf.length} size=${imgFrame?.meta?.size}`)
    }

    // L8b 帧内容未授权访问必须被拒
    {
      const noauth = await fetch(PLATFORM_BASE + String(imgFrame?.contentUrl ?? ''))
      ok('L8b', '帧内容未授权访问被拒', noauth.status === 401 || noauth.status === 403, `status=${noauth.status}`)
    }

    // L6b IHDR 自动尺寸(节点不配 width/height 路径)
    {
      const ihdrNodeR = await api('POST', '/api/workshop/daq', {
        token,
        body: {
          name: `MQTT-IMG-IHDR-${TAG}`, templateRef: imgTplKey, driver: 'mqtt',
          driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: `aw/e2e/${TAG}/img-ihdr`, imageFormat: 'json', imagePath: 'data.png', staleMs: 5000 },
          unit: 'px', min: 0, max: 255, decimals: 0, lineId, intervalMs: 1000, publishIntervalMs: 0,
        },
      })
      const ihdrNode = ihdrNodeR.data?.node?.id
      const ihdrPub = await connectClient(mqtt, brokerUrl)
      const ihdrTimer = setInterval(() => ihdrPub.publish(`aw/e2e/${TAG}/img-ihdr`, JSON.stringify({ data: { png: png4 } }), { qos: 0 }), 2000)
      const ht0 = Date.now()
      await sleep(6000)
      clearInterval(ihdrTimer)
      const ihdrFrames = (await api('GET', `/api/workshop/daq/${ihdrNode}/frames?kind=image&from=${ht0 - 1500}&to=${Date.now()}&limit=5`)).data?.frames ?? []
      await ihdrPub.endAsync(true).catch(() => {})
      ok('L6b', 'PNG IHDR 自动尺寸(未配置宽高路径)', ihdrFrames.length >= 1 && ihdrFrames[0]?.meta?.width === 4 && ihdrFrames[0]?.meta?.height === 4, `${ihdrFrames.length} 帧 / ${ihdrFrames[0]?.meta?.width}x${ihdrFrames[0]?.meta?.height}`)
    }

    // L6c 二进制图像(报文字节)
    {
      const binNodeR = await api('POST', '/api/workshop/daq', {
        token,
        body: {
          name: `MQTT-IMG-BIN-${TAG}`, templateRef: imgTplKey, driver: 'mqtt',
          driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: `aw/e2e/${TAG}/img-bin`, imageFormat: 'binary', imageMime: 'image/png', staleMs: 5000 },
          unit: 'px', min: 0, max: 255, decimals: 0, lineId, intervalMs: 1000, publishIntervalMs: 0,
        },
      })
      const binNode = binNodeR.data?.node?.id
      const binPub = await connectClient(mqtt, brokerUrl)
      const pngBuf = Buffer.from(png4, 'base64')
      const binTimer = setInterval(() => binPub.publish(`aw/e2e/${TAG}/img-bin`, pngBuf, { qos: 0 }), 2000)
      const bt0 = Date.now()
      await sleep(6000)
      clearInterval(binTimer)
      const binFrames = (await api('GET', `/api/workshop/daq/${binNode}/frames?kind=image&from=${bt0 - 1500}&to=${Date.now()}&limit=5`)).data?.frames ?? []
      await binPub.endAsync(true).catch(() => {})
      ok('L6c', '二进制图像报文 → image 帧(4×4/PNG)', binFrames.length >= 1 && binFrames[0]?.meta?.width === 4 && binFrames[0]?.meta?.height === 4 && binFrames[0]?.meta?.mime === 'image/png', `${binFrames.length} 帧 / ${binFrames[0]?.meta?.mime}`)
    }

    // L9 解析失败可见(节点 lastError)+ 恢复
    {
      const badPub = await connectClient(mqtt, brokerUrl)
      const badStart = Date.now()
      badPub.publish(vecTopic, JSON.stringify({ data: {} }), { qos: 0 })
      await sleep(1800)
      const badFrames = (await api('GET', `/api/workshop/daq/${vecNode}/frames?kind=vector&from=${badStart}&to=${Date.now()}&limit=10`)).data?.frames ?? []
      const badNode = await nodeOf(vecNode)
      const badOk = badFrames.length === 0 && /点列|pointsPath/.test(String(badNode?.lastError ?? ''))
      const goodStart = Date.now()
      badPub.publish(vecTopic, JSON.stringify({ data: { points: [10, 20, 30, 40, 50] } }), { qos: 0 })
      await sleep(3500)
      const goodFrames = (await api('GET', `/api/workshop/daq/${vecNode}/frames?kind=vector&from=${goodStart}&to=${Date.now()}&limit=10`)).data?.frames ?? []
      const goodNode = await nodeOf(vecNode)
      await badPub.endAsync(true).catch(() => {})
      ok('L9', '坏结构 → 0 帧 + 可读 lastError;恢复发布自愈', badOk && goodFrames.length >= 1 && !goodNode?.lastError, `badFrames=${badFrames.length} err=${String(badNode?.lastError ?? '').slice(0, 60)} / recovered=${goodFrames.length}`)
    }

    // L10/L11 用户自定义解码器(插件注册;scalar sum / vector add)
    if (!plat.reused) {
      const sumTopic = `aw/e2e/${TAG}/sum`
      const sumNodeR = await api('POST', '/api/workshop/daq', {
        token,
        body: {
          name: `MQTT-SUM-${TAG}`, templateRef: 'daq-temp-tc', driver: 'mqtt',
          driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: sumTopic, decoder: 'e2e-sum-xy', staleMs: 4000 },
          unit: '℃', min: 0, max: 100, decimals: 1, lineId, intervalMs: 1000, publishIntervalMs: 0,
        },
      })
      const sumNode = sumNodeR.data?.node?.id
      const sumPub = await connectClient(mqtt, brokerUrl)
      const sumTimer = setInterval(() => sumPub.publish(sumTopic, JSON.stringify({ x: 40, y: 2.5 }), { qos: 0 }), 1000)
      const st0 = Date.now()
      await sleep(4500)
      clearInterval(sumTimer)
      const sumPts = await samples(sumNode, st0 - 1000, Date.now())
      ok('L10', '用户自定义解码器 → scalar 入库(40+2.5=42.5)', sumPts.length >= 1 && Math.abs(sumPts[sumPts.length - 1].avg - 42.5) < 0.06, `${sumPts.length} 行 / ${sumPts[sumPts.length - 1]?.avg}`)
      // L10b 自定义解码器抛错 → 0 行 + 可读错误;恢复
      {
        const tBad = Date.now()
        sumPub.publish(sumTopic, JSON.stringify({ x: 'a', y: 2 }), { qos: 0 })
        await sleep(2200)
        const badPts = await samples(sumNode, tBad, Date.now())
        const badNode = await nodeOf(sumNode)
        sumPub.publish(sumTopic, JSON.stringify({ x: 40, y: 2.5 }), { qos: 0 })
        await sleep(3200)
        const goodPts = await samples(sumNode, tBad + 2200, Date.now())
        const goodNode = await nodeOf(sumNode)
        ok('L10b', '自定义解码器异常 → 0 行 + 可读 lastError;恢复自愈', badPts.length === 0 && /x\/y/.test(String(badNode?.lastError ?? '')) && goodPts.length >= 1 && !goodNode?.lastError, `bad=${badPts.length} err=${String(badNode?.lastError ?? '').slice(0, 50)} / recovered=${goodPts.length}`)
      }
      await sumPub.endAsync(true).catch(() => {})

      const addNodeR = await api('POST', '/api/workshop/daq', {
        token,
        body: {
          name: `MQTT-VADD-${TAG}`, templateRef: vecTplKey, driver: 'mqtt',
          driverConfig: { host: '127.0.0.1', port: BROKER_PORT, topic: `aw/e2e/${TAG}/vadd`, decoder: 'e2e-vec-add', staleMs: 4000 },
          unit: 'μm', min: 0, max: 100, decimals: 2, lineId, intervalMs: 1000, publishIntervalMs: 0,
        },
      })
      const addNode = addNodeR.data?.node?.id
      const addPub = await connectClient(mqtt, brokerUrl)
      const addTimer = setInterval(() => addPub.publish(`aw/e2e/${TAG}/vadd`, JSON.stringify({ a: [1, 2, 3, 4, 5], b: [10, 20, 30, 40, 50] }), { qos: 0 }), 1000)
      const at0 = Date.now()
      await sleep(4500)
      clearInterval(addTimer)
      const addFrames = (await api('GET', `/api/workshop/daq/${addNode}/frames?kind=vector&from=${at0 - 1000}&to=${Date.now()}&limit=10`)).data?.frames ?? []
      await addPub.endAsync(true).catch(() => {})
      ok('L11', '用户自定义解码器 → vector 入库(逐点相加)', addFrames.length >= 1 && JSON.stringify(addFrames[0]?.points) === JSON.stringify([11, 22, 33, 44, 55]), `points=${JSON.stringify(addFrames[0]?.points)}`)
    }
    else {
      skipped('L10', '用户自定义解码器(scalar)', 'AW_E2E_BASE 复用了已运行实例')
      skipped('L11', '用户自定义解码器(vector)', 'AW_E2E_BASE 复用了已运行实例')
      skipped('L10b', '自定义解码器异常', 'AW_E2E_BASE 复用了已运行实例')
    }

    // L12 解码配置变更(PATCH pointsPath)→ 订阅重建,旧解析配置不得继续生效
    {
      const cfgPub = await connectClient(mqtt, brokerUrl)
      await api('PATCH', `/api/workshop/daq/${vecNode}`, { token, body: { driverConfig: { pointsPath: 'data.nope' } } })
      await sleep(1500)
      const t0 = Date.now()
      cfgPub.publish(vecTopic, JSON.stringify({ data: { points: [10, 20, 30, 40, 50] } }), { qos: 0 })
      await sleep(2500)
      const badFrames = (await api('GET', `/api/workshop/daq/${vecNode}/frames?kind=vector&from=${t0}&to=${Date.now()}&limit=10`)).data?.frames ?? []
      const badNode = await nodeOf(vecNode)
      await api('PATCH', `/api/workshop/daq/${vecNode}`, { token, body: { driverConfig: { pointsPath: 'data.points' } } })
      await sleep(1500)
      const t1 = Date.now()
      cfgPub.publish(vecTopic, JSON.stringify({ data: { points: [10, 20, 30, 40, 50] } }), { qos: 0 })
      await sleep(3000)
      const goodFrames = (await api('GET', `/api/workshop/daq/${vecNode}/frames?kind=vector&from=${t1}&to=${Date.now()}&limit=10`)).data?.frames ?? []
      await cfgPub.endAsync(true).catch(() => {})
      ok('L12', '解码配置变更 → 订阅重建生效(PATCH pointsPath)', badFrames.length === 0 && /pointsPath/.test(String(badNode?.lastError ?? '')) && goodFrames.length >= 1, `bad=${badFrames.length} err=${String(badNode?.lastError ?? '').slice(0, 50)} / restored=${goodFrames.length}`)
    }
  }

  // ── 清理 ──
  await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, { token, body: {} }).catch(() => {})
  console.log(`\n━━━ MQTT E2E: ${pass} passed / ${fail} failed / ${skip} skipped ━━━`)
  if (failures.length > 0) {
    console.log('FAILURES:')
    failures.forEach(f => console.log(`  ✘ ${f}`))
  }
  if (!plat.reused && plat.home) console.log(`  (临时 home: ${plat.home})`)
  return fail
}

let exitCode
try {
  exitCode = (await main()) > 0 ? 1 : 0
}
catch (err) {
  console.error('FATAL', err instanceof Error ? err.stack ?? err.message : err)
  exitCode = 1
}
finally {
  if (!KEEP) {
    for (const p of spawned.reverse()) {
      killTree(p.pid)
      if (p.home) {
        try {
          rmSync(p.home, { recursive: true, force: true })
        }
        catch { /* 占用中 */ }
      }
      if (p.simShadow) {
        try {
          rmSync(p.simShadow, { recursive: true, force: true })
        }
        catch { /* 占用中 */ }
      }
    }
  }
  else {
    console.log(`  KEEP=1:保留 ${spawned.length} 个进程/目录`)
  }
}
process.exit(exitCode)
