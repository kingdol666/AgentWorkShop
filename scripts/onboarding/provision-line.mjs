/**
 * scripts/onboarding/provision-line.mjs —— 产线供给(skill 阶段3):建线+DCW/DAQ 节点+量程+配方。
 * 幂等:以指纹标签(AW-LINE:<hash>)写入线 description,重跑复用既有线并按"线+节点名"匹配节点;
 *      量程/步长与配置不一致时 PATCH 对齐(配置为权威)。
 * 红线:受保护演示线(ln-d7e0a2a2)绝不可命中;配方参数的 node 用名字引用,脚本负责解析。
 * 输入 JSON:
 * {
 *   "line":  {"name":"注塑验收线", "description":"可选补充"},
 *   "nodes": [
 *     {"kind":"dcw","name":"机筒1区SP","driver":"modbus-tcp","driverConfig":{...},
 *      "unit":"℃","min":120,"max":300,"decimals":1,"stepLimit":5,"holdIntervalMs":120000,
 *      "templateRef":"dcw-temp-sp"},
 *     {"kind":"daq","name":"熔体温度PV","driver":"modbus-tcp","driverConfig":{...},
 *      "unit":"℃","min":0,"max":350,"warnLow":150,"warnHigh":290,"intervalMs":2000}
 *   ],
 *   "recipe":  {"name":"注塑基线配方","params":[{"node":"机筒1区SP","value":180}]},
 *   "startLine": false
 * }
 * 结束时向 stdout 打印一行 JSON 摘要({lineId,dcw,daq,recipeId,reused})供后续脚本管道使用。
 * 用法:node scripts/onboarding/provision-line.mjs <config.json|->
 */
import { api, login, ok, summary, readConfig, fingerprint, findByTag, assertNotProtected } from './lib.mjs'

const cfg = await readConfig()
const tok = await login()
const tag = fingerprint('LINE', cfg.line.name)

// ---------- 1. 产线(幂等) ----------
const linesList = await api('GET', '/api/workshop/dcw/lines', undefined, tok)
let line = findByTag(linesList.data?.lines, tag)
let reused = !!line
if (!line) {
  const j = await api('POST', '/api/workshop/dcw/lines', {
    name: cfg.line.name,
    description: `${tag}${cfg.line.description ? ' ' + cfg.line.description : ''}`,
  }, tok)
  ok('建产线', j.code === 0 && !!j.data?.line?.id, j.message ?? '')
  line = j.data?.line
}
else ok('产线已存在(指纹复用)', true, `${line.id} ${line.name}`)
assertNotProtected(line.id, '产线')
const lineId = line.id

// ---------- 2. 节点(DCW 写控 / DAQ 数采;名字匹配幂等) ----------
const agg = await api('GET', '/api/workshop/dcw', undefined, tok)
const dcwAll = agg.data?.nodes ?? []
const daqList = await api('GET', '/api/workshop/daq', undefined, tok)
const daqAll = daqList.data?.nodes ?? []
const dcwMap = {}, daqMap = {}

// ---------- 1b. 跨线写点冲突预检(对产线负责:两个产线的写控节点打到同一物理寄存器
// = 双保写心跳互打,必然猎振 —— 2026-10-10 注塑二线推演实证发现,故设硬闸) ----------
function writeFingerprint(n) {
  const c = n.driverConfig ?? {}
  switch (n.driver) {
    case 'modbus-tcp':
    case 'modbus-rtu':
    case 'serial':
      return `${n.driver}://${c.host}:${c.port}/${c.unitId ?? 1}:${c.register}:${c.registerType ?? 'holding'}`
    case 'opcua':
      return `opcua://${c.endpoint}::${c.nodeId}`
    case 'mqtt':
      return `mqtt://${c.host}:${c.port}::${c.topic}`
    case 'http':
      return `http://${c.url}`
    default:
      return null // mes-rest/mock 等共享面不参与
  }
}
if (cfg.allowSharedSignals !== true) {
  const existing = dcwAll.filter(x => x.lineId !== lineId)
  const fpIndex = new Map()
  for (const x of existing) {
    const fp = writeFingerprint(x)
    if (fp) fpIndex.set(fp, x)
  }
  const collisions = []
  for (const n of cfg.nodes ?? []) {
    if (n.kind !== 'dcw') continue
    const fp = writeFingerprint(n)
    const hit = fp ? fpIndex.get(fp) : null
    if (hit) collisions.push(`${n.name} ↔ ${hit.name}(线 ${hit.lineId})@ ${fp}`)
  }
  if (collisions.length > 0) {
    console.error(`✖ 跨线写点冲突(${collisions.length}):新线写控节点与既有产线命中同一物理点位,双线保写必然互打猎振:`)
    for (const c of collisions) console.error('   ·', c)
    console.error('  处置:改选不冲突信号,或确认两线共用同一物理点后配置 "allowSharedSignals": true 显式豁免。')
    process.exit(1)
  }
  ok('跨线写点冲突预检', true, `既有他线写控 ${existing.length} 节点,冲突 0`)
}

for (const n of cfg.nodes ?? []) {
  const pool = n.kind === 'daq' ? daqAll : dcwAll
  const found = pool.find(x => x.lineId === lineId && x.name === n.name)
  if (found) {
    ;(n.kind === 'daq' ? daqMap : dcwMap)[n.name] = found.id
    ok(`节点复用[${n.name}]`, true, found.id)
    // 量程漂移对齐(配置为权威):dcw 用 PATCH,daq 也走 PATCH
    const drift = n.kind === 'daq'
      ? (found.min !== n.min || found.max !== n.max)
      : (found.min !== n.min || found.max !== n.max || (n.stepLimit && found.stepLimit !== n.stepLimit))
    if (drift) {
      const p = await api('PATCH', `/api/workshop/${n.kind === 'daq' ? 'daq' : 'dcw'}/${found.id}`,
        Object.fromEntries(Object.entries({ min: n.min, max: n.max, stepLimit: n.stepLimit }).filter(([, v]) => v !== undefined)), tok)
      ok(`量程对齐[${n.name}]`, p.code === 0 || !!p.data, p.message ?? '')
    }
    continue
  }
  // mes-rest 映射面自动字符串化(2026-10-10 投用轮坑:readMap/writeMap/historyMap/headers
  // 必须是 JSON 字符串存 driverConfig —— 输入面允许写对象,这里统一转换,消灭编码坑)
  const driverConfig = { ...(n.driverConfig ?? {}) }
  if (n.driver === 'mes-rest') {
    for (const key of ['readMap', 'writeMap', 'historyMap', 'headers']) {
      if (driverConfig[key] != null && typeof driverConfig[key] === 'object') {
        driverConfig[key] = JSON.stringify(driverConfig[key])
      }
    }
  }
  const body = n.kind === 'daq'
    ? {
        name: n.name, lineId, driver: n.driver, driverConfig,
        templateRef: n.templateRef,
        unit: n.unit ?? '', decimals: n.decimals ?? 1, min: n.min, max: n.max,
        warnLow: n.warnLow, warnHigh: n.warnHigh, intervalMs: n.intervalMs,
      }
    : {
        name: n.name, lineId, driver: n.driver, driverConfig,
        unit: n.unit ?? '', decimals: n.decimals ?? 1, min: n.min, max: n.max,
        stepLimit: n.stepLimit, holdIntervalMs: n.holdIntervalMs ?? 120000,
        templateRef: n.templateRef, transform: n.transform,
      }
  const j = await api('POST', n.kind === 'daq' ? '/api/workshop/daq' : '/api/workshop/dcw', body, tok)
  const id = j.data?.node?.id ?? j.data?.id ?? j.data?.daqNode?.id
  ok(`建${n.kind === 'daq' ? '数采' : '写控'}节点[${n.name}]`, !!id, id ?? j.message ?? '')
  if (id) (n.kind === 'daq' ? daqMap : dcwMap)[n.name] = id
}

// ---------- 3. 配方(参数 node 名字解析;同名单线复用) ----------
let recipeId
if (cfg.recipe) {
  const recipes = agg.data?.recipes ?? []
  const found = recipes.find(r => r.name === cfg.recipe.name && (r.lineId ?? lineId) === lineId)
  const params = (cfg.recipe.params ?? []).map((p) => {
    const nodeId = dcwMap[p.node] ?? p.node // 允许直接传 id
    if (!nodeId || !String(nodeId).startsWith('dw-')) throw new Error(`配方参数引用的节点不存在:${p.node}(先在 nodes 里定义 dcw 节点)`)
    return { nodeId, value: p.value, min: p.min, max: p.max, stepLimit: p.stepLimit }
  })
  if (found) {
    recipeId = found.id
    ok('配方复用', true, `${recipeId} v${found.version}`)
  }
  else {
    // 产品:配方必须归属产品;缺省自动建一个"线名+默认产品"
    let productId = cfg.productId
    if (!productId) {
      const pj = await api('POST', '/api/workshop/dcw/products', {
        name: cfg.product?.name ?? `${cfg.line.name}·默认产品`, lineId,
      }, tok)
      productId = pj.data?.product?.id ?? pj.data?.id
      ok('建产品', !!productId, productId ?? pj.message ?? '')
      if (!productId) process.exit(1)
    }
    const j = await api('POST', '/api/workshop/dcw/recipes', {
      name: cfg.recipe.name, productId, params, lineId,
    }, tok)
    recipeId = j.data?.recipe?.id ?? j.data?.id
    ok('建配方', !!recipeId, recipeId ?? j.message ?? '')
  }
}

// ---------- 4. 可选开跑(运行门语义;已在跑会 CONFLICT,视为通过) ----------
if (cfg.startLine && recipeId) {
  const j = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, tok)
  ok('开跑批次', j.code === 0 || j.code === 'CONFLICT', j.data?.run?.id ?? j.message ?? '')
}

console.log('\n' + JSON.stringify({ lineId, dcw: dcwMap, daq: daqMap, recipeId, reused }))
summary('产线供给')
