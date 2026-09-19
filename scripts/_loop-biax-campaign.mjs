/**
 * 双拉任务确定性 campaign —— R11 Major-1 的实验落地:
 * 固定模拟器状态(plantReset warm)+ 固定 commit + 固定配方,连续执行 N=30 次
 * AgentTeam 双拉闭环任务,记录每次入带结果,给出入带率的 Wilson 95% CI。
 * 预注册判据:入带 = |最终厚度 − 25.0| ≤ 0.7 µm;每次写后等待 ≥12s 运输滞后。
 * 运行: AW_BASE=http://127.0.0.1:3005 NO_PROXY=127.0.0.1,localhost node scripts/_loop-biax-campaign.mjs [N]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const N = Number(process.argv[2] ?? 30)
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const OUT = join(REPO, 'bench', 'results', 'biax-campaign')
const SIM = process.env.E2E_SIM_API ?? 'http://127.0.0.1:4010'
const fetchRetry = async (url, opts = {}, tries = 8) => {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) })
    }
    catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, Math.min(500 * 2 ** (i - 1), 6000)))
    }
  }
  throw lastErr
}

mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await (await fetch(BASE + '/api/users/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
})).json()
const H = { 'authorization': `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const api = {
  call: async (method, u, b) => (await fetch(BASE + u, { method, headers: H, body: b ? JSON.stringify(b) : undefined })).json(),
}

const { ensureSimulator, simUp, simNodes, plantReset } = await import(pathToFileURL(join(REPO, 'bench', 'lib', 'sim.mjs')).href)
const { provisionBiaxLine, runBiaxMission, ensureBiaxLine } = await import(pathToFileURL(join(REPO, 'bench', 'lib', 'biax.mjs')).href)

if (!(await simUp())) {
  console.error('模拟器不可达:请先启动 plc-node-simulator (:4010)')
  process.exit(1)
}
await ensureSimulator().catch(() => {})

const sfx = 'camp' + Date.now().toString(36).slice(-4)
// 平台夹具:channel + mock lead/worker(任务板剧本)+ opencode 绑定执行体
const ch = await api.call('POST', '/api/workshop/channels', { name: `biax-campaign-${sfx}`, leadAgent: { name: `clead-${sfx}`, harness: 'mock', config: { delayMs: 40 } } })
const channelId = ch.data?.channelId ?? ch.data?.channel?.id ?? ch.data?.id
const worker = await api.call('POST', '/api/workshop/agents', { name: `cworker-${sfx}`, harness: 'mock', config: { delayMs: 60 } })
await api.call('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: worker.data?.id, role: 'worker' })
const agent = await api.call('POST', '/api/workshop/agents', { name: `cexec-${sfx}`, harness: 'opencode', config: {} })
const joinResp = await api.call('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: agent.data?.id, role: 'worker' })
const instId = joinResp.data?.id ?? joinResp.data?.agentId
if (!instId) {
  console.error('执行体创建失败')
  process.exit(1)
}

const runs = []
const stateFile = join(OUT, 'campaign-state.json')
const save = () => writeFileSync(stateFile, JSON.stringify({ sfx, startedAt: new Date().toISOString(), runs }, null, 1))

console.log(`campaign start: N=${N} base=${BASE} sim=:4010`)
for (let k = 1; k <= N; k++) {
  const t0 = Date.now()
  // ① 固定模拟器状态(确定性根修:零随机漂移 + warm 标称)
  await plantReset({ warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } })
  await sleep(1500)
  // ②.5 SP 归一化:崩塌任务会把 SP 写到量程外(实测 pump-sp=0 残留),起跑前统一设回
  // 量程内 35% 位(确定性起点;任务只写铸速/快辊/轨宽三旋钮,其余 SP 仅作配方合法值)
  {
    const nodes = (await simNodes()).filter(n => n.id.startsWith('biax-'))
    for (const dev of nodes) {
      for (const sig of dev.signals ?? []) {
        if (!/SP/i.test(sig.id) && !/SP/i.test(sig.name ?? '')) continue
        const lo = sig.min ?? 0, hi = sig.max ?? 100
        const v = Number(sig.value)
        if (!Number.isFinite(v) || v < lo + 0.05 * (hi - lo)) {
          const target = +(lo + 0.35 * (hi - lo)).toFixed(sig.decimals ?? 1)
          await fetchRetry(SIM + '/api/nodes/' + dev.id + '/signals/' + encodeURIComponent(sig.id) + '/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: target }) }).catch(() => {})
        }
      }
    }
    await sleep(1200)
  }

  // ② 每轮独立布线(探测补建幂等;节点随 purge 回收)
  const ensured = await ensureBiaxLine()
  if (!ensured?.verified) throw new Error('ensureBiaxLine 失败')
  const provisioned = await provisionBiaxLine(api, { sfx: sfx + k })
  const line = provisioned
  // ③ 绑定执行体到三个执行节点的 DCW
  for (const nodeId of Object.values(line.dcw)) {
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId, kind: 'dcw', mode: 'auto' })
  }
  await sleep(2000)
  // ④ 任务(含治理写与判定)
  const mission = await runBiaxMission(api, { instId, line, simDevices: (await simNodes()).filter(n => n.id.startsWith('biax')), sfx: sfx + k, maxRounds: 6 })
  if (k === 1 || !mission.attained) console.log('DIAG provErrors:', JSON.stringify(provisioned.errors ?? []), '| dcw:', Object.keys(line.dcw ?? {}).length, '| daq:', Object.keys(line.daq ?? {}).length, '| ids:', JSON.stringify(line.ids ?? {}))
  const run = {
    k, attained: mission.attained, thickness: mission.thickness,
    writes: mission.writes, knobs: mission.distinctNodes.size, wallS: Math.round((Date.now() - t0) / 1000),
  }
  runs.push(run)
  save()
  console.log(`[${k}/${N}] attained=${run.attained} h=${run.thickness?.toFixed(2)}µm writes=${run.writes} wall=${run.wallS}s`)
  // ⑤ 收尾:停线防批次泄漏
  await api.call('POST', `/api/workshop/dcw/lines/${line.ids.line}/stop`, {}).catch(() => {})
  await api.call('DELETE', `/api/workshop/dcw/lines/${line.ids.line}?purge=1`, {}).catch(() => {})
  await sleep(2000)
}

const ok = runs.filter(r => r.attained).length
const n = runs.length
const p = ok / n
const z = 1.96
const ci = n ? [p - z * Math.sqrt((p * (1 - p)) / n), p + z * Math.sqrt((p * (1 - p)) / n)] : [0, 0]
const summary = { n, ok, rate: +p.toFixed(3), wilson95: ci.map(c => +c.toFixed(3)), runs }
writeFileSync(join(OUT, 'campaign-summary.json'), JSON.stringify(summary, null, 1))
console.log(`\n结果: ${ok}/${n} 入带,rate=${(p * 100).toFixed(1)}%,Wilson95=[${ci[0].toFixed(3)},${ci[1].toFixed(3)}]`)
console.log(`产物: ${OUT}`)
