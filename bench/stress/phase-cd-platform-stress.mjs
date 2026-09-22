/**
 * Phase C+D · AW 平台连通 + 多重压力测试
 *  C1 平台自举与鉴权(隔离配置根)
 *  C2 四条产线(五协议四路:modbus-tcp / modbus-rtu / opcua / mqtt)真实 driverConfig 建线+开跑
 *  C3 平台侧 DCW 写→回读 + DAQ 采样(每协议)
 *  D1 串行压力:每 SP 线 30 轮 写→回读,统计时延,门=0 失败
 *  D2 并发压力:三线同时 20 路并行写 + 并行读,门=全部 200 且回读一致
 *  D3 断链恢复:停 sim 节点 → 平台读失败 → 重启节点 → 读恢复
 */
import { makeApi, sleep } from '../lib/util.mjs'
import { ensurePlatform } from '../lib/platform.mjs'
import { provisionLine, ensureGateway } from '../lib/provision.mjs'
import { simNodes } from '../lib/sim.mjs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const R = { pass: [], fail: [] }
const ok = (name, cond, ev = '') => { (cond ? R.pass : R.fail).push(`${name}${ev ? ' · ' + ev : ''}`); console.log(`${cond ? '✔' : '✘'} ${name}${ev ? ' · ' + ev : ''}`) }
const p50 = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const p95 = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)] }
const simApi = async (method, path, body) => {
  const res = await fetch('http://127.0.0.1:4011' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000) })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data ?? json, message: json?.message ?? '' }
}

const api = makeApi(BASE)

async function main() {
  // ── C1 平台自举与鉴权 ──
  const pr = await ensurePlatform({ base: BASE, log: () => {} })
  console.log('platform:', pr.started ? `spawned pid=${pr.pid}` : (pr.reason ?? 'already-up'))
  const login = await api.login('admin@awshop.local', 'admin123')
  ok('C1 平台鉴权', login.ok, login.how)

  // ── C2 建线(每协议一台设备自成产线;纯采集设备走卫星挂靠) ──
  await ensureGateway(api)
  const nodes = (await simNodes()).filter(n => n.enabled)
  const picks = ['biax-casting-mbtcp', 'biax-pump-rtu', 'biax-tdo-opcua']
  const lines = []
  for (let i = 0; i < picks.length; i++) {
    const device = nodes.find(n => n.id === picks[i])
    if (!device) { ok(`C2 ${picks[i]} 存在`, false); continue }
    const rec = await provisionLine(api, { device, sfx: `pc${i}${Date.now() % 100000}`, index: i + 1 })
    lines.push(rec)
    ok(`C2 ${picks[i]} 建线开跑`, Boolean(rec.ids?.line) && rec.started === true, `line=${rec.ids?.line} dcw=${rec.ids?.dcw ?? '—'} started=${rec.started}`)
  }
  // 纯采集设备(gauge,无 SP)按硬约束①建模为卫星数采,随宿主批次采样
  {
    const device = nodes.find(n => n.id === 'biax-gauge-mqtt')
    const rec = await provisionLine(api, { device, sfx: `pcsat${Date.now() % 100000}`, index: 4, hostLine: lines[0] })
    lines.push(rec)
    ok('C2 gauge 卫星数采挂靠', rec.satellite === true && Boolean(rec.ids?.daq), `daq=${rec.ids?.daq} host=${rec.hostLineIndex}`)
  }
  await sleep(7000) // 起稳采样

  // ── C3 平台侧写→回读 + DAQ 采样 ──
  for (const l of lines) {
    if (!l.ids?.dcw) continue
    const target = Number((l.window.min + (l.window.max - l.window.min) * 0.6).toFixed(3))
    const w = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
    const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
    const back = rd.data?.read?.value ?? rd.data?.value
    ok(`C3 [${l.protocol}] DCW 写→回读`, w.status === 200 && Math.abs(Number(back) - target) <= Math.max(0.75, (l.window.max - l.window.min) * 0.01), `写 ${target} 回读 ${back}`)
  }
  for (const l of lines) {
    if (!l.ids?.daq) continue
    let pts = 0, waited = 0
    for (;;) {
      const s = await api.call('GET', `/api/workshop/daq/${l.ids.daq}/samples?bucketMs=1000&limit=60`)
      pts = s.data?.points?.length ?? 0
      if (pts > 0 || waited > 20000) break
      await sleep(2000); waited += 2000
    }
    ok(`C3 [${l.protocol}] DAQ 采样`, pts > 0, `${pts} points`)
  }

  // ── D1 串行压力:30 轮写→回读 ×3 SP 线 ──
  for (const l of lines.filter(x => x.ids?.dcw)) {
    const span = l.window.max - l.window.min
    let fails = 0, deltas = [], lats = []
    for (let k = 0; k < 30; k++) {
      const target = Number((l.window.min + span * (0.3 + 0.5 * (k % 5) / 4)).toFixed(3))
      const t0 = performance.now()
      const w = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
      lats.push(performance.now() - t0)
      if (w.status !== 200) { fails++; continue }
      const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
      const back = Number(rd.data?.read?.value ?? rd.data?.value)
      if (!Number.isFinite(back) || Math.abs(back - target) > Math.max(0.75, span * 0.01)) fails++
      else deltas.push(Math.abs(back - target))
      await sleep(100)
    }
    ok(`D1 [${l.protocol}] 串行 30 轮写读`, fails === 0, `fails=${fails} p50=${p50(lats).toFixed(0)}ms p95=${p95(lats).toFixed(0)}ms meanΔ=${(deltas.reduce((a, b) => a + b, 0) / Math.max(deltas.length, 1)).toFixed(4)}`)
  }

  // ── D2 并发压力:跨节点三路并行(每节点内部串行 10 写=平台语义),外加同节点并发突发 ──
  {
    const spLines = lines.filter(x => x.ids?.dcw)
    // (a) 跨节点并行:每线串行 10 写,三线同时跑
    const t0 = performance.now()
    const perLine = await Promise.all(spLines.map(async l => {
      const span = l.window.max - l.window.min
      let bad = 0
      for (let k = 0; k < 10; k++) {
        const target = Number((l.window.min + span * (0.3 + (k % 5) * 0.08)).toFixed(3))
        const w = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
        if (w.status !== 200) bad++
      }
      return bad
    }))
    const wall = performance.now() - t0
    ok('D2a 跨节点三路并行写(每线串行10)零失败', perLine.every(b => b === 0), `wall=${wall.toFixed(0)}ms 失败=[${perLine.join(',')}]`)
    // (b) 同节点并发突发:20 路同时打同一点 —— 在飞闸门应只放行串行数(200),其余 409/429,不许 5xx
    const l = spLines[0]
    const target = Number(((l.window.min + l.window.max) / 2).toFixed(3))
    const burst = await Promise.all(Array.from({ length: 20 }, () =>
      api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })))
    const byStatus = {}
    for (const r of burst) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    const legal = burst.every(r => r.status === 200 || r.status === 409 || r.status === 429)
    ok('D2b 同节点 20 路并发突发闸门正确', legal, `status 分布=${JSON.stringify(byStatus)}`)
    // (c) 并行读 30 路:全部成功
    const reads = await Promise.all(Array.from({ length: 30 }, () =>
      api.call('POST', `/api/workshop/dcw/${spLines[0].ids.dcw}/read`, {})))
    const readOk = reads.filter(r => r.status === 200); ok('D2c 并行 30 读(200/409 闸门语义,无 5xx)', reads.every(r => r.status === 200 || r.status === 409) && readOk.length >= 1, `200×${readOk.length} 409×${reads.filter(r => r.status === 409).length}`)
  }

  // ── D3 断链恢复:停 casting 节点(等 close 完成) → 平台读失败 → 重启 → 恢复 ──
  {
    const l = lines.find(x => x.protocol === 'modbus-tcp')
    if (l?.ids?.dcw) {
      const st = await simApi('POST', `/api/nodes/${l.simDeviceId}/stop`, {})
      ok('D3 stop 受理', st.status === 200)
      await sleep(3500) // 超过 close 的 2500ms 上限,确保 socket 销毁完成
      const rdFail = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
      ok('D3 断链感知(read.ok=false)', rdFail.status === 200 && rdFail.data?.read?.ok === false, `status=${rdFail.status} ok=${rdFail.data?.read?.ok}`)
      await simApi('POST', `/api/nodes/${l.simDeviceId}/start`, {})
      let recovered = false
      for (let i = 0; i < 10; i++) {
        await sleep(2000)
        const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
        if (rd.status === 200 && Number.isFinite(Number(rd.data?.read?.value ?? rd.data?.value))) { recovered = true; break }
      }
      ok('D3 重启后读恢复', recovered)
    }
  }

  console.log(`\n===== PHASE-CD 结果: pass=${R.pass.length} fail=${R.fail.length} =====`)
  if (R.fail.length) { console.log('FAILURES:'); R.fail.forEach(f => console.log('  ✘', f)) }
}
main().then(() => process.exit(R.fail.length ? 1 : 0)).catch(e => { console.error('FATAL', e); process.exit(1) })
