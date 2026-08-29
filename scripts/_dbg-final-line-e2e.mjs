/**
 * 终审 E2E-A:产线管理 —— 物理设备 ↔ Node 数据驱动 ↔ 虚拟孪生 全映射。
 * 真实 Modbus TCP(127.0.0.1:1502 模拟从站):
 *   数采节点读 40003(温度 float32)/ 40001(压力 float32)→ 物理值 → 绑定设备遥测回写
 *   数控节点写 40021(设定值组,写入即保持)→ 同址回读校验
 * 断言:设备-节点绑定/产线归属/配方窗口/孪生 telemetry/场景实例/真实寄存器读写。
 */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
const puppeteer = await import('puppeteer-core').then(m => m.default)

const cleanup = []
async function main() {
  // ===== 1. 物理设备(数字孪生 device-twin)创建 =====
  const twin = (await jpost('/api/workshop/device-twins', { name: '物理挤出机(E2E-A)', modelRef: 'dev-folder-extruder', kind: 'device', posX: 2600, posZ: 900 })).data.twin
  cleanup.push(['twin', twin.id])
  console.log(`[设备] 物理挤出机 twin=${twin.id.slice(0, 10)}`)

  // ===== 2. 产线 + 节点(真实 Modbus 驱动)绑定设备 =====
  const line = (await jpost('/api/workshop/dcw/lines', { name: '终审产线A' })).data.line
  cleanup.push(['dcw-line', line.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: '终审产品A', lineId: line.id })).data.product
  cleanup.push(['dcw-product', prod.id])

  // 数采:读真实寄存器(温度 40003 / 压力 40001),绑定设备 → 遥测回写
  const dqT = (await jpost('/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: 'A-温度采集(Modbus)',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40003, dataType: 'float32', byteOrder: 'big' },
    intervalMs: 500, lineId: line.id, deviceBindingId: twin.id, posX: twin.posX + 70, posZ: twin.posZ + 70,
  })).data.node
  const dqP = (await jpost('/api/workshop/daq', {
    templateRef: 'daq-pressure-tx', name: 'A-压力变送(Modbus)',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, dataType: 'float32', byteOrder: 'big' },
    intervalMs: 500, lineId: line.id, deviceBindingId: twin.id, posX: twin.posX + 130, posZ: twin.posZ + 90,
  })).data.node
  // 数控:写 40021(工程 150~200 → 原始 0~2000,0.1 分辨率),绑定设备
  const dw = (await jpost('/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: 'A-温度设定(Modbus)',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big', engMin: 150, engMax: 200, rawMin: 0, rawMax: 2000 },
    lineId: line.id, deviceBindingId: twin.id, posX: twin.posX - 70, posZ: twin.posZ - 70,
  })).data.node
  cleanup.push(['daq', dqT.id], ['daq', dqP.id], ['dcw', dw.id])
  console.log(`[节点] 2 数采(读 40003/40001)+ 1 数控(写 40021),全部绑定设备+产线`)

  // 绑定核验
  const nodes1 = (await jget('/api/workshop/daq')).data.nodes
  const nT = nodes1.find(n => n.id === dqT.id)
  if (nT?.deviceBindingId === twin.id && nT?.lineId === line.id) console.log('PASS 绑定:数采节点 ↔ 设备 ↔ 产线 三向归属正确')
  else fail(`绑定核验失败: ${JSON.stringify({ bind: nT?.deviceBindingId, line: nT?.lineId })}`)

  // ===== 3. 配方(控制 + 监控窗口)+ 开跑 → 数采流动 =====
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: '终审配方A',
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 182, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dqT.id, min: 100, max: 260 }],
  })).data.recipe
  cleanup.push(['dcw-recipe', rc.id])
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  if (!st.data?.line?.active) { fail('开跑失败'); process.exit(1) }
  await sleep(3500)
  // Modbus 连接池冷启动:首个节点首采可能为 null → 最多再等 6s
  let live = (await jget('/api/workshop/daq')).data.nodes
  for (let i = 0; i < 6; i++) {
    const p = live.find(n => n.id === dqP.id)
    if (p?.value != null) break
    await sleep(1000)
    live = (await jget('/api/workshop/daq')).data.nodes
  }
  const lT = live.find(n => n.id === dqT.id)
  const lP = live.find(n => n.id === dqP.id)
  console.log(`[真实读] 温度寄存器 40003 → ${lT?.value}℃ (${lT?.state}) | 压力 40001 → ${lP?.value}MPa`)
  if (lT?.value != null && lT.value > 150 && lT.value < 190 && lP?.value != null && lP.value > 0.5 && lP.value < 1.2)
    console.log('PASS 真实 Modbus 读:float32 解码物理值在模拟从站波动域内')
  else fail(`真实读数值异常: T=${lT?.value} P=${lP?.value}`)

  // 设备孪生遥测回写(数采 → 设备)
  const twinNow = (await jget('/api/workshop/device-twins')).data.twins.find(t => t.id === twin.id)
  const tel = twinNow?.telemetry ?? {}
  if (Number(tel.temperature) > 100 && Number(tel.pressure) > 0.3)
    console.log(`PASS 遥测回写:设备孪生 temperature=${tel.temperature} pressure=${tel.pressure}(数采驱动)`)
  else fail(`遥测回写缺失: ${JSON.stringify(tel).slice(0, 120)}`)

  // ===== 4. 真实数控写:配方窗口内 182 → 寄存器 40021 写入 + 同址回读 =====
  const w = await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 182 })
  const o = w.data?.outcome
  console.log(`[真实写] 182℃ → raw ${o?.raw},回读 ${o?.readback}`)
  if (o?.ok !== true || o.raw !== 1280) fail(`真实写失败: ${JSON.stringify(o).slice(0, 120)}`)
  else console.log('PASS 真实 Modbus 写:工程量→寄存器线性换算(182→raw1280)+ 同址回读一致')
  // 越窗联锁(真实设备链路上同样拦截)
  const over = await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 195 })
  if (over.code === 'VALIDATION_ERROR') console.log('PASS 真实链路联锁:越配方窗口 195 被拒(未触达设备)')
  else fail('真实链路联锁失效')

  // ===== 5. 数字孪生场景:节点实例化 + 设备 telemetry 驱动渲染 =====
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1200 })
  await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
  await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await sleep(1000)
  }
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 120)))
  let daqMounted = false
  let dcwMounted = false
  let sceneDiag = {}
  for (let i = 0; i < 20; i++) {
    const m = await page.evaluate((ids) => {
      const s = window.__town.scene
      const store = (window).__dcwStream
      return {
        daq: !!([...s.deviceNodes.values()].find(x => x.twinId === ids.dqT)),
        dcw: !!([...s.deviceNodes.values()].find(x => x.twinId === ids.dw)),
        dcwIds: [...s.deviceNodes.values()].filter(d => (d.modelRef ?? '').startsWith('dcw-')).map(d => d.twinId.slice(0, 10)),
        storeDcwCount: (store?.nodes ?? []).length,
        target: (store?.nodes ?? []).filter(n => n.id === ids.dw).map(n => ({ pos: n.posX, line: n.lineId, enabled: n.enabled })),
      }
    }, { dqT: dqT.id, dw: dw.id }).catch(() => ({ daq: false, dcw: false, dcwIds: [] }))
    daqMounted = m.daq
    dcwMounted = m.dcw
    sceneDiag = m
    if (daqMounted && dcwMounted) break
    await sleep(1000)
  }
  const scene = await page.evaluate(async (ids) => {
    const token = document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? ''
    const twins = await fetch('/api/workshop/device-twins', { headers: { authorization: `Bearer ${decodeURIComponent(token)}` } }).then(x => x.json())
    const t = twins.data.twins.find(x => x.id === ids.twin)
    return { devTelemetry: t?.telemetry ?? {}, devState: t?.state ?? '' }
  }, { twin: twin.id })
  console.log('[场景] 数采实例挂载:', daqMounted, '| 数控实例挂载:', dcwMounted)
  if (daqMounted && dcwMounted) console.log('PASS 孪生场景:Node 数据驱动实例全部挂载(设备旁渲染)')
  else {
    console.error('  [diag] scene dcw:', JSON.stringify(sceneDiag.dcwIds), '| store:', sceneDiag.storeDcwCount, JSON.stringify(sceneDiag.target), '| err:', pageErrors.slice(0, 2))
    fail(`场景挂载缺失: daq=${daqMounted} dcw=${dcwMounted}`)
  }
  if (Number(scene.devTelemetry.temperature) > 100) console.log(`PASS 孪生渲染数据源:设备 telemetry 由真实 Modbus 数采驱动(${scene.devTelemetry.temperature}℃)`)
  else fail(`场景 telemetry 异常: ${JSON.stringify(scene.devTelemetry).slice(0, 100)}`)
  await page.screenshot({ path: 'docs/audit/screenshots/final-line-twin.png' })
  await browser.close()
}

main()
  .then(async () => {
    for (const [kind, id] of [...cleanup].reverse()) {
      try {
        if (kind === 'dcw-line') await jpost(`/api/workshop/dcw/lines/${id}/stop`, {})
        else if (kind === 'daq') await jdel(`/api/workshop/daq/${id}`)
        else if (kind === 'dcw') await jdel(`/api/workshop/dcw/${id}`)
        else if (kind === 'dcw-recipe') await jdel(`/api/workshop/dcw/recipes/${id}`)
        else if (kind === 'dcw-product') await jdel(`/api/workshop/dcw/products/${id}`)
        else if (kind === 'twin') await jdel(`/api/workshop/device-twins/${id}`)
      }
      catch { /* 尽力清理 */ }
    }
    console.log(process.exitCode ? 'E2E-A FAILED' : 'E2E-A ALL PASS')
    process.exit(process.exitCode ?? 0)
  })
  .catch((err) => { console.error('FATAL:', err.message); process.exit(1) })
