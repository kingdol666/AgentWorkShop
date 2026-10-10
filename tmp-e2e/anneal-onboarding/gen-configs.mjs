// 生成 anneal-line 接入配置(skill 阶段1-3 输入面;来源=设备 export,逐字段核对)
// 用法:node tmp-e2e/anneal-onboarding/gen-configs.mjs  → 产出 conn.json / provision.json
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'

const exp = JSON.parse(readFileSync('tmp-e2e/anneal-exports.json', 'utf8'))
const exportOf = (dev, signal) => (exp[dev]?.items ?? []).find(i => i.signal === signal)

const nodes = []
const connTests = []
const push = (n, testLabel) => {
  nodes.push(n)
  if (testLabel) connTests.push({ label: testLabel, driver: n.driver, driverConfig: n.driverConfig })
}

// —— 3.1 加热段炉 modbus-tcp ——
const mbt = exportOf('anneal-heating-mbtcp', '均热区1炉温SP')
const mbBase = { host: mbt.driverConfig.host, port: mbt.driverConfig.port, unitId: mbt.driverConfig.unitId }
for (const [sig, reg, kind, min, max] of [
  ['均热区1炉温SP', 40021, 'dcw', 600, 850],
  ['均热区2炉温SP', 40023, 'dcw', 600, 850],
  ['均热区3炉温SP', 40025, 'dcw', 600, 850],
  ['炉温PV', 40001, 'daq', 20, 900],
  ['带温PV', 40003, 'daq', 20, 900],
]) {
  const e = exportOf('anneal-heating-mbtcp', sig === '炉温PV' ? 'FurnaceTemp' : sig === '带温PV' ? 'StripTemp' : sig)
  push({
    kind, name: sig, driver: 'modbus-tcp',
    driverConfig: { ...mbBase, register: reg, registerType: 'holding', dataType: 'float32', byteOrder: e.driverConfig.byteOrder ?? 'big' },
    unit: '℃', decimals: 1, min, max,
    ...(kind === 'dcw' ? { stepLimit: 12, holdIntervalMs: 120000, templateRef: 'temp-sp' } : { intervalMs: 2000, templateRef: 'daq-temp-tc', warnLow: min + (max - min) * 0.75, warnHigh: max - (max - min) * 0.06 }),
  }, sig === '均热区1炉温SP' ? '均热SP(modbus-tcp)' : undefined)
}

// —— 3.2 传动 opcua ——
const spE = exportOf('anneal-line-opcua', 'LineSpeedSP')
const pvE = exportOf('anneal-line-opcua', 'ActSpeed')
push({
  kind: 'dcw', name: '线速SP', driver: 'opcua', driverConfig: { endpoint: spE.driverConfig.endpoint, nodeId: spE.driverConfig.nodeId },
  unit: 'm/min', decimals: 1, min: 60, max: 220, stepLimit: 8, holdIntervalMs: 120000, templateRef: 'temp-sp',
}, '线速SP(opcua)')
push({
  kind: 'daq', name: '实际线速PV', driver: 'opcua', driverConfig: { endpoint: pvE.driverConfig.endpoint, nodeId: pvE.driverConfig.nodeId },
  unit: 'm/min', decimals: 1, min: 0, max: 240, intervalMs: 2000, templateRef: 'daq-temp-tc',
}, '线速PV(opcua)')

// —— 3.3 冷却/过时效 modbus-rtu(RTU-over-TCP 网关) ——
const oaE = exportOf('anneal-cool-rtu', '过时效温度SP')
const rtBase = { host: oaE.driverConfig.host, port: oaE.driverConfig.port, unitId: oaE.driverConfig.unitId }
for (const [sig, src, reg, kind, min, max, step] of [
  ['过时效温度SP', '过时效温度SP', 40021, 'dcw', 320, 480, 10],
  ['冷却档位SP', '冷却档位SP', 40023, 'dcw', 20, 100, 5],
  ['过时效温度PV', 'OaTempPV', 40001, 'daq', 20, 520, null],
]) {
  const e = exportOf('anneal-cool-rtu', src)
  push({
    kind, name: sig, driver: 'modbus-rtu',
    driverConfig: { ...rtBase, register: reg, registerType: 'holding', dataType: 'float32', byteOrder: e.driverConfig.byteOrder ?? 'big' },
    unit: kind === 'dcw' && sig === '冷却档位SP' ? '%' : '℃', decimals: 1, min, max,
    ...(kind === 'dcw' ? { stepLimit: step, holdIntervalMs: 120000, templateRef: 'temp-sp' } : { intervalMs: 2000, templateRef: 'daq-temp-tc' }),
  }, sig === '过时效温度SP' ? '过时效SP(modbus-rtu)' : undefined)
}

// —— 3.4 保护气 mqtt ——
const dewE = exportOf('anneal-gas-mqtt', 'DewPoint')
const h2E = exportOf('anneal-gas-mqtt', 'H2RatioSP')
const mqttBase = { host: dewE.driverConfig.host, port: dewE.driverConfig.port }
push({
  kind: 'daq', name: '保护气露点PV', driver: 'mqtt',
  driverConfig: { ...mqttBase, topic: dewE.driverConfig.topic, jsonPath: dewE.driverConfig.jsonPath },
  unit: '℃', decimals: 1, min: -70, max: 0, intervalMs: 3000, templateRef: 'daq-temp-tc',
}, '露点PV(mqtt)')
push({
  kind: 'daq', name: '氢气占比PV', driver: 'mqtt',
  driverConfig: { ...mqttBase, topic: exportOf('anneal-gas-mqtt', 'H2Act').driverConfig.topic, jsonPath: exportOf('anneal-gas-mqtt', 'H2Act').driverConfig.jsonPath },
  unit: '%', decimals: 1, min: 0, max: 20, intervalMs: 3000, templateRef: 'daq-temp-tc',
}, '氢气PV(mqtt)')
push({
  kind: 'dcw', name: '氢气占比SP', driver: 'mqtt',
  driverConfig: { ...mqttBase, topic: h2E.driverConfig.topic, jsonKey: h2E.driverConfig.jsonKey, qos: 1 },
  unit: '%', decimals: 1, min: 3, max: 15, stepLimit: 1, holdIntervalMs: 120000, templateRef: 'temp-sp',
}, '氢气SP(mqtt 写)')

// —— 3.5 质检 http(标量×5) ——
for (const [sig, src, , min, max, unit] of [
  ['硬度HV', 'Hardness', 'api/hardness', 60, 200, 'HV'],
  ['抗拉强度', 'Tensile', 'api/tensile', 200, 500, 'MPa'],
  ['屈服强度', 'YieldStr', 'api/yield', 100, 400, 'MPa'],
  ['晶粒度', 'GrainSize', 'api/grain', 2, 30, 'μm'],
  ['表面缺陷率', 'SurfaceDef', 'api/surface', 0, 5, '%'],
]) {
  const e = exportOf('anneal-inspect-http', src)
  push({
    kind: 'daq', name: sig, driver: 'http',
    driverConfig: { url: e.driverConfig.url, jsonPath: e.driverConfig.jsonPath ?? 'value' },
    unit, decimals: 1, min, max, intervalMs: 5000, templateRef: 'daq-temp-tc',
  }, sig === '硬度HV' ? '质检(http)' : undefined)
}

// MES 直取节点(参数直取模式;secretRef 零明文,token 走 env AW_MES_MES_ANNEAL_TOKEN)
const mesHistory = field => ({
  baseUrl: 'http://127.0.0.1:15060', authType: 'header', authHeaderName: 'x-api-token', secretRef: 'MES_ANNEAL',
  allowPrivateHost: 'true',
  historyMap: {
    method: 'GET', path: '/api/v1/series', query: { fields: field },
    response: { rowsPath: 'data.rows', valuePath: `values.${field}`, tsPath: 'ts', tsFormat: 'iso', nextCursorPath: 'data.nextCursor' },
  },
})
nodes.push({ kind: 'dcw', name: 'MES温度序列', driver: 'mes-rest', driverConfig: mesHistory('melt_temp'), unit: '℃', decimals: 1, min: 0, max: 400, stepLimit: 999, holdIntervalMs: 0, templateRef: 'temp-sp' })
nodes.push({ kind: 'dcw', name: 'MES压力序列', driver: 'mes-rest', driverConfig: mesHistory('melt_pressure'), unit: 'MPa', decimals: 2, min: 0, max: 40, stepLimit: 999, holdIntervalMs: 0, templateRef: 'temp-sp' })
connTests.push({ label: 'MES区间取数(mes-rest 直取)', driver: 'mes-rest', driverConfig: mesHistory('melt_temp'), domain: { min: 0, max: 400 } })

mkdirSync('tmp-e2e/anneal-onboarding', { recursive: true })
writeFileSync('tmp-e2e/anneal-onboarding/conn.json', JSON.stringify({ tests: connTests }, null, 1))
writeFileSync('tmp-e2e/anneal-onboarding/provision.json', JSON.stringify({
  line: { name: '连续退火线', description: '连续退火产线(冷轧板带);质量窗内产能最大;来源=标准产线开发文档' },
  nodes,
  recipe: {
    name: '退火基线配方',
    params: [
      { node: '均热区1炉温SP', value: 745 },
      { node: '均热区2炉温SP', value: 750 },
      { node: '均热区3炉温SP', value: 748 },
      { node: '线速SP', value: 120 },
      { node: '过时效温度SP', value: 400 },
      { node: '冷却档位SP', value: 60 },
      { node: '氢气占比SP', value: 8 },
    ],
  },
  startLine: true,
}, null, 1))
console.log('nodes:', nodes.length, '(dcw:', nodes.filter(n => n.kind === 'dcw').length, 'daq:', nodes.filter(n => n.kind === 'daq').length + ')')
console.log('conn tests:', connTests.length)
