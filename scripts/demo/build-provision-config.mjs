/**
 * 从模拟器 export 生成 provision-line 配置(driverConfig 一律取 export,绝不手抄)。
 * 用法:node scripts/demo/build-provision-config.mjs --sim http://127.0.0.1:4055 --device demo-injection --out <file>
 */
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const sim = argOf('--sim', 'http://127.0.0.1:4055')
const device = argOf('--device', 'demo-injection')
const out = argOf('--out')
if (!out) {
  console.error('缺少 --out')
  process.exit(2)
}
process.env.NO_PROXY = '127.0.0.1,localhost'
const r = await fetch(`${sim}/api/nodes/${device}/export`, { signal: AbortSignal.timeout(10000) })
const j = await r.json()
const items = j?.data?.items ?? []
if (!items.length) {
  console.error('export 无 items:', JSON.stringify(j).slice(0, 200))
  process.exit(3)
}
const byName = new Map(items.map(i => [i.signal, i]))
const need = ['保压压力SP', '保压时间SP', '模腔压力PV', '制品重量PV']
for (const name of need) if (!byName.has(name)) {
  console.error(`export 缺信号:${name}`)
  process.exit(4)
}
const nodeOf = (name, extra) => {
  const it = byName.get(name)
  return { driver: it.driver, driverConfig: it.driverConfig, unit: it.unit, min: it.min, max: it.max, ...extra }
}
const cfg = {
  line: { name: '演示注塑优化线', description: '端到端作业演示(PLC 模拟器孪生;modbus-tcp)' },
  nodes: [
    { ...nodeOf('保压压力SP', { name: '保压压力SP', kind: 'dcw', decimals: 1, stepLimit: 10, holdIntervalMs: 60000 }) },
    { ...nodeOf('模腔压力PV', { name: '模腔压力PV', kind: 'daq', intervalMs: 1000 }) },
    { ...nodeOf('制品重量PV', { name: '制品重量PV', kind: 'daq', intervalMs: 1000 }) },
  ],
  recipe: { name: '演示基线配方', params: [] },
  startLine: true,
}
writeFileSync(out, JSON.stringify(cfg, null, 2))
console.log(out)
