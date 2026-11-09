/**
 * 真实产线供给（2026-11-11）：WWTP A2O 场景 → 共享模拟器 :4010 差分建场 → 平台 :4201 建线
 * （真实协议 driverConfig、DAQ/DCW 全真实链路、配方纳管、admin REST 开跑）。
 * 用法：node scripts/_live-rsi-provision.mjs
 */
process.env.SIM_BASE = 'http://127.0.0.1:4010'
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, ensureScenarioLine, provisionScenarioLine } from '../bench/lib/scenarios.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const TOKEN = state.token
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const api = {
  call: async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  },
}

console.log('── ① 模拟器差分建场（WWTP A2O；共享 :4010，增量不动他场景）──')
const ens = await ensureScenarioLine(SCENARIOS.wwtp)
console.log(`  report=${JSON.stringify(ens.report)}`)
console.log(`  verified=${JSON.stringify(ens.verified)}`)

console.log('── ② 平台建线（真实协议链路 + 配方 + 开跑）──')
const sfx = `d${Date.now().toString(36).slice(-4)}`
const rec = await provisionScenarioLine(api, SCENARIOS.wwtp, { sfx })
console.log(`  line=${rec.lineName} reused=${rec.reused}`)
console.log(`  ids=${JSON.stringify(rec.ids)}`)
console.log(`  devices=${JSON.stringify(rec.devices)}`)
console.log(`  driverTests=${JSON.stringify(rec.driverTests)}`)
console.log(`  errors=${JSON.stringify(rec.errors ?? [])}`)

state.line = { sfx, ...rec.ids, lineName: rec.lineName, dcw: rec.dcw, daq: rec.daq, reused: rec.reused, devices: rec.devices }
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
console.log('[state] line info saved')
if (!rec.ids?.lineId || !rec.ids?.recipeId || rec.errors?.length) {
  console.error('[halt] 供给未完成')
  process.exit(1)
}
