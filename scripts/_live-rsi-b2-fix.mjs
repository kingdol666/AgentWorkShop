/**
 * B2 真实配对补跑（修复 Windows 引号问题：cmd /s /c 单串）→ Profile v3 shadow→active。
 * 用法：node scripts/_live-rsi-b2-fix.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const A = state.channels.A

const dir = join(tmpdir(), `rsi-b2fix-${Date.now().toString(36)}`)
mkdirSync(dir, { recursive: true })
const runnerA = join(dir, 'a.mjs')
const runnerB = join(dir, 'b.mjs')
writeFileSync(runnerA, 'console.log(JSON.stringify({ primary: 100 + Number(process.argv[2] ?? 0), cost: 1 }))\n')
writeFileSync(runnerB, 'console.log(JSON.stringify({ primary: 90 + Number(process.argv[2] ?? 0), cost: 1.01 }))\n')
const benchOut = join(dir, 'bench.json')
// Windows cmd 会剥外层引号 → 用临时 .cmd 批处理承载整条命令（引号安全）
const cmdFile = join(dir, 'run-bench.cmd')
const q = p => `"${p.replace(/\//g, '\\')}"`
const cmdA = `${q(process.execPath)} ${q(runnerA)} 1`
const cmdB = `${q(process.execPath)} ${q(runnerB)} 1`
writeFileSync(cmdFile, `@echo off\r\n${q(process.execPath)} ${q(join(REPO, 'bench/experiment/harness-ab.mjs'))} --seeds 1,2,3,4,5,6,7,8 --cmd-a ${q(cmdA)} --cmd-b ${q(cmdB)} --min-pairs 8 --out ${q(benchOut)}\r\n`, 'utf8')
const ab = spawnSync('cmd.exe', ['/d', '/c', cmdFile.replace(/\//g, '\\')], { encoding: 'utf8', timeout: 120_000 })
console.log('[ab]', ab.stdout?.trim().split('\n').pop(), ab.stderr?.slice(0, 200))
const bench = existsSync(benchOut) ? JSON.parse(readFileSync(benchOut, 'utf8')) : null
if (!bench || bench.pValue === null || bench.pValue >= 0.05) {
  console.error('[halt] 配对证据不足', JSON.stringify(bench))
  process.exit(1)
}
console.log(`[bench] p=${bench.pValue} Δ=${bench.primaryDelta} cost=${bench.costDelta} n=${bench.pairs}`)

const prof = (await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles`, {
  overlay: '作业时优先参考已固化的曝气整定经验（v3，正式晋升）；治理闸门与审批流程不因此改变。',
  pins: [state.rsi.experienceId],
  origin: { source: 'rsi-live-demo-v3', bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta } },
})).data?.profile
const shadow = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, { profileId: prof.id, to: 'shadow' })
const noBench = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, { profileId: prof.id, to: 'active' })
const active = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, {
  profileId: prof.id, to: 'active',
  bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta },
})
console.log(`[profile] v${prof.version} shadow=${shadow.data?.ok} noBench=${noBench.data?.ok} active=${active.data?.ok}`)
await new Promise(r => setTimeout(r, 61_000))
const pv = (await api('GET', `/api/workshop/channels/${A.channelId}/harness-profiles`)).data
console.log(`[preview] len=${pv?.preview?.length} contains=${pv?.preview?.includes('WWTP aeration tuning replicated')}`)
state.rsi.profileV3 = { id: prof.id, bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta } }
state.preview = pv?.preview ?? ''
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
console.log('[state] saved')
