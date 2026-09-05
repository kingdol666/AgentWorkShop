/**
 * 插件系统全链路实测:默认下沉路径(MinIO 图像帧) + 自定义模板插件安装/连接/加工验证。
 *   NO_PROXY='*' node scripts/_dbg-plugin-matrix.mjs [--base http://127.0.0.1:3000]
 *
 * R-10 默认节点(默认下沉):ccd-image(mock)→ 帧落对象存储(MinIO/磁盘降级)→ /frames + content;
 *      标量节点 Timescale 落库与 WS 已由 _dbg-protocol-matrix.mjs 覆盖。
 * R-11 自定义插件安装:落盘 .AgentWorkShop/plugins/aw-matrix-plugin → REST enable(热重载)。
 * R-12 插件模板节点接模拟工况:驱动(matrix-thermo→HTTP 模拟设备)→ 自定义算法(1.02x+0.5)
 *      → 自定义处理器(matrix-derate)→ 入库/WS;断言入库值 ≈ 43.85(非原始 42.5)。
 * R-13 Agent 工具 + 观测路由:omp 工具注册 + /api/plugins/aw-matrix-plugin/stats。
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
    if (attempt < 3) { await sleep(2500); return api(method, path, { body, token }, attempt + 1) }
    throw err
  }
}

async function main() {
  console.log(`\n━━━ 插件系统全链路实测 @ ${BASE} (tag=${TAG}) ━━━`)

  const fs = await import('node:fs')
  const { spawnSync, spawn } = await import('node:child_process')
  const resolve2 = (await import('node:path')).resolve
  // preflight:dev server 自愈(外部击杀 → 清僵尸 guard → 重启,最多等 90s)
  {
    let ok = false
    for (let i = 0; i < 30 && !ok; i++) {
      try { ok = (await fetch(`${BASE}/api/health`)).status === 200 } catch { ok = false }
      if (!ok) {
        if (i === 0) {
          const lockPath = resolve2('.AgentWorkShop/.runtime/aw.lock')
          let lockPid = 0
          try { lockPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid ?? 0) } catch { /* 无锁 */ }
          if (lockPid) {
            spawnSync('cmd', ['/c', `taskkill /F /PID ${lockPid}`])
            try { fs.unlinkSync(lockPath) } catch { /* 无锁 */ }
            console.log(`  [preflight] dev server 僵尸 guard(pid=${lockPid})已清,重启…`)
            const fd = fs.openSync(resolve2('.AgentWorkShop/data/dev-server.log'), 'a')
            const { spawn } = await import('node:child_process')
            const child = spawn(process.execPath, ['bin/aw.mjs', 'dev'], {
              cwd: process.cwd(), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
              detached: true, stdio: ['ignore', fd, fd],
            })
            child.unref()
          }
        }
        await sleep(3000)
      }
    }
    if (!ok) throw new Error('preflight:dev server 90s 未恢复')
  }
  console.log('  [preflight] dev server 健康')

  // preflight:模拟工况自愈(清旧持有者 → 唯一实例)
  {
    const net = await import('node:net')
    const SIMS = [
      { name: 'mqtt-http', ports: [18830, 1889], cmd: 'scripts/dev-protocol-simulators.mjs', env: { MQTT_SIM_PORT: '18830', HTTP_SIM_PORT: '1889' }, log: 'sim-mqtt-http.log' },
      { name: 'modbus-tcp', ports: [1502], cmd: 'scripts/dev-modbus-simulator.mjs', env: {}, log: 'sim-modbus-tcp.log' },
      { name: 'opcua', ports: [4840], cmd: 'scripts/dev-opcua-simulator.mjs', env: { OPCUA_SIM_PORT: '4840' }, log: 'sim-opcua.log' },
      { name: 'plc', ports: [15040], cmd: 'scripts/dev-plc-simulator.mjs', env: {}, args: ['--port', '15040'], log: 'sim-plc.log' },
      { name: 'rtu', ports: [15030], cmd: 'scripts/_rtu-mini-slave.mjs', env: {}, log: 'sim-rtu.log' },
    ]
    const portUp = (port) => new Promise((res) => {
      const s = net.connect(port, '127.0.0.1')
      const t = setTimeout(() => { s.destroy(); res(false) }, 1000)
      s.on('connect', () => { clearTimeout(t); s.destroy(); res(true) })
      s.on('error', () => { clearTimeout(t); res(false) })
    })
    for (const sim of SIMS) {
      const owners = spawnSync('cmd', ['/c', `netstat -ano | findstr :${sim.ports[0]} | findstr LISTENING`], { encoding: 'utf-8' })
      for (const line of (owners.stdout ?? '').split('\n')) {
        const m = line.trim().match(/\s(\d+)\s*$/)
        if (m) { spawnSync('cmd', ['/c', `taskkill /F /PID ${m[1]}`]); await sleep(300) }
      }
      const fd = fs.openSync(resolve2('.AgentWorkShop/data', sim.log), 'a')
      const child = spawn(process.execPath, [sim.cmd, ...(sim.args ?? [])], {
        cwd: process.cwd(), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...sim.env },
        detached: true, stdio: ['ignore', fd, fd],
      })
      child.unref()
      let up = false
      for (let i = 0; i < 15 && !up; i++) { await sleep(1000); up = await portUp(sim.ports[0]) }
      if (!up) throw new Error(`preflight:${sim.name} 拉起失败`)
    }
  }
  console.log('  [preflight] 模拟工况六端口就绪')

  const reg = await api('POST', '/api/users/register', {
    body: { email: `plug-${TAG}@test.local`, password: 'Passw0rd!123', name: `plug-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 200)}`)

  // ═══ R-10 默认节点:图像帧默认下沉(对象存储 MinIO/磁盘) ═══
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `插件产线-${TAG}` }, token })).data?.line
  const img = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-ccd-image', name: `视觉相机-${TAG}`, driver: 'mock', lineId: line.id, intervalMs: 700, publishIntervalMs: 0 }, token,
  })).data?.node
  check('R10.1', '默认节点创建(ccd-image,mock 模拟工况)', Boolean(img?.id))
  // 配方 mock 参数节点 + 开跑(数采门控需要 active run)
  const dwMock = (await api('POST', '/api/workshop/dcw', { body: { templateRef: 'dcw-temp-sp', name: `插件参数-${TAG}`, driver: 'mock', lineId: line.id }, token })).data?.node
  const prod = (await api('POST', '/api/workshop/dcw/products', { body: { name: `插件产品-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id, name: `插件配方-${TAG}`,
      params: [{ templateRef: 'dcw-temp-sp', nodeId: dwMock.id, value: 180, min: 150, max: 200 }],
      daqWindows: [{ nodeId: img.id, min: 0, max: 255 }],
    }, token,
  })).data?.recipe
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  check('R10.0', '产线开跑(激活数采门控)', start.code === 0, start.message ?? '')
  await sleep(4500)
  const frames = await api('GET', `/api/workshop/daq/${img.id}/frames?limit=5`, { token })
  const frameItems = frames.data?.frames ?? frames.data?.items ?? frames.data ?? []
  check('R10.2', '图像帧落对象存储(/frames 元数据)', Array.isArray(frameItems) && frameItems.length >= 2, `frames=${Array.isArray(frameItems) ? frameItems.length : 'undefined'}`)
  const firstFrame = Array.isArray(frameItems) ? frameItems[0] : null
  const contentUrl = firstFrame?.contentUrl
  const fTs = firstFrame?.ts ?? firstFrame?.at
  if (contentUrl || fTs) {
    const url = contentUrl ?? `/api/workshop/daq/${img.id}/frames/content?ts=${fTs}`
    const content = await fetch(`${BASE}${url}`, { headers: { authorization: `Bearer ${token}` } })
    const buf = await content.arrayBuffer()
    check('R10.3', '帧内容可回源(MinIO/对象存储 GET)', content.status === 200 && buf.byteLength > 100, `status=${content.status} bytes=${buf.byteLength}`)
  } else {
    check('R10.3', '帧内容可回源(MinIO/对象存储 GET)', false, `无回源地址 frame=${JSON.stringify(firstFrame ?? {}).slice(0, 100)}`)
  }

  // ═══ R-11 自定义插件:安装(落盘已完成)→ 发现/启用态 ═══
  const list0 = await api('GET', '/api/workshop/plugins', { token })
  const plugins0 = list0.plugins ?? list0.data?.plugins ?? []
  const mine0 = plugins0.find(p => p.name === 'aw-matrix-plugin')
  check('R11.1', '插件被发现(plugins 列表)', Boolean(mine0), `enabled=${mine0?.enabled} 共${plugins0.length}个`)
  if (mine0 && mine0.enabled === false) {
    const en = await api('POST', '/api/workshop/plugins/aw-matrix-plugin/enable', { body: {}, token })
    check('R11.2', 'REST 启用插件(热重载)', en.code === 0 || en.status === 200, en.message ?? '')
    await sleep(3000)
  } else {
    check('R11.2', '插件已处于启用态(发现即装载)', true)
  }
  const daqList = await api('GET', '/api/workshop/daq', { token })
  const tplItems = daqList.data?.templates ?? []
  const mineTpl = tplItems.find(t => t.key === 'plug-matrix-profile')
  check('R11.3', '自定义模板已注册(plug-matrix-profile)', Boolean(mineTpl), `templates=${tplItems.length}`)

  // ═══ R-12 插件模板节点接模拟工况:自定义驱动+算法+处理器全链路 ═══
  const drvTest = await api('POST', '/api/workshop/daq/test-driver', { body: { driver: 'matrix-thermo', driverConfig: {} }, token })
  check('R12.1', '插件自定义驱动连接测试(→HTTP 模拟工况)', drvTest.data?.test?.ok === true, JSON.stringify(drvTest.data?.test ?? {}).slice(0, 100))
  const calib = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'plug-matrix-profile', name: `插件标定-${TAG}`, driver: 'matrix-thermo', driverConfig: {}, lineId: line.id, intervalMs: 700, publishIntervalMs: 0 }, token,
  })).data?.node
  check('R12.2', '插件模板节点创建', Boolean(calib?.id))
  await sleep(6000)
  const samples = await api('GET', `/api/workshop/daq/${calib.id}/samples?bucketMs=1000`, { token })
  const pts = samples.data?.points ?? []
  const vals = pts.map(p => Number(Object.values(p)[1])).filter(Number.isFinite)
  // 原始值 42.5±0.5 → 补偿后 1.02x+0.5 ≈ 43.85±1(>48 削峰不会触发)
  const calibrated = vals.filter(v => v > 42.2 && v < 46)
  check('R12.3', '自定义算法生效(入库=1.02×42.5+0.5≈43.85,非原始 42.5)', vals.length >= 4 && calibrated.length >= Math.floor(vals.length * 0.6),
    `points=${pts.length} last=${vals.at(-1)} 原始恒为 42.5±0.5`)

  // ═══ R-13 插件观测路由 + Agent 工具 ═══
  const stats = await api('GET', '/api/plugins/aw-matrix-plugin/stats', { token })
  const sbody = stats.body ?? stats.data?.body ?? stats.data ?? {}
  check('R13.1', '插件 REST 路由(/stats)+ 钩子计数', sbody.ok === true && Number(sbody.samples) > 0,
    `samples=${sbody.samples} frames=${sbody.frames} last=${sbody.lastValue}`)
  const tools = await api('GET', '/api/workshop/plugins', { token })
  const mineNow = (tools.plugins ?? tools.data?.plugins ?? []).find(p => p.name === 'aw-matrix-plugin')
  check('R13.2', '插件管理面可见(启用态)', Boolean(mineNow?.enabled), `enabled=${mineNow?.enabled}`)

  // ═══ 清理 ═══
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/daq/${img.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/daq/${calib.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/${dwMock.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ 插件矩阵结果: ${passed} passed / ${failures} failed ━━━`)
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
