/** 一次性:重建流延膜产线设备(device-twins 注册表;强杀进程导致的注册表清空后恢复)
 *  设备 = 模型库实体(挤出机/MD 纵拉机/TD 拉幅机/收卷机/控制台/循环泵),沿 x 轴成线布置。
 */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { 'authorization': `Bearer ${login.data.token}`, 'content-type': 'application/json' }

const DEVICES = [
  { name: '挤出机 L1', modelRef: 'extruder', posX: 1300, posZ: 1100, rotationY: 0 },
  { name: 'MD 纵拉机 L1', modelRef: 'mdo', posX: 1650, posZ: 1100, rotationY: 0 },
  { name: 'TD 拉幅机 L1', modelRef: 'tdo', posX: 2000, posZ: 1100, rotationY: 0 },
  { name: '收卷机 L1', modelRef: 'winder', posX: 2350, posZ: 1100, rotationY: 0 },
  { name: '控制台 · CON', modelRef: 'device-console', posX: 1300, posZ: 1450, rotationY: 180, controls: ['start', 'stop'] },
  { name: '循环泵 #01', modelRef: 'pump', posX: 2300, posZ: 1500, rotationY: 30, scale: 1.6, controls: ['start', 'stop'], telemetry: { rpm: 2960, pressure: 0.82, temp: 63, vibration: 3.4 } },
]

const existing = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json())
const have = new Set((existing?.data?.twins ?? existing?.data ?? []).map(t => t.name))
for (const d of DEVICES) {
  if (have.has(d.name)) {
    console.log('skip (exists):', d.name)
    continue
  }
  const r = await fetch(`${BASE}/api/workshop/device-twins`, { method: 'POST', headers: H, body: JSON.stringify(d) })
  const j = await r.json().catch(() => ({}))
  console.log(r.ok ? 'created:' : 'FAILED:', d.name, r.ok ? j?.data?.twin?.id ?? j?.data?.id ?? '' : JSON.stringify(j).slice(0, 120))
}
const after = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json())
const list = after?.data?.twins ?? after?.data ?? []
console.log('total twins now:', list.length, '| placed:', list.filter(t => typeof t.posX === 'number').length)
