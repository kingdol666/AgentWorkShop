/**
 * 0.7.48 打包系统验收 · 硬约束失败关闭探针(无需 LLM,秒级)
 * 场景:同一份真实快照 + 同一组候选,只改 constraints[].id
 *   ① id = weight(可映射)→ 试验正常给出约束结论
 *   ② id = part_weight(不可映射)→ 必须**判不通过**并给出"无法映射"明细(v0.7.47 会假通过)
 * 用法:AW_BASE=http://127.0.0.1:3001 [AW_HOME=<home>] node scripts/_aw0748-failclosed-probe.mjs
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const HOME = process.env.AW_HOME ?? `${process.cwd()}/.aw0746-home`
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(name)
}
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
console.log(`\n═══ 0.7.48 硬约束失败关闭探针 @ ${BASE} ═══`)

const chans = (await j('GET', '/api/workshop/channels', undefined, token)).data ?? []
const twin = chans.find(c => /闭环优化-hybridtwin/.test(c.name))
const members = (await j('GET', `/api/workshop/channels/${twin.id}/agents`, undefined, token)).data ?? []
const lead = members.find(m => m.role === 'lead')
const invoke = async (tool, args) => (await j('POST', '/api/workshop/agent-tools/invoke', { agentId: lead.id, tool, args }, token)).data?.result ?? {}
const firstJson = (text) => {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null
}

// 快照必须"真新鲜":VirtualTrial 只认 60s 内的水位 → 先开跑采样,再用 auto_daq 让服务端按绑定取样
const dcw = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const line = (dcw.lines ?? []).find(l => /injection-aw0746/i.test(String(l.name)))
const product = (dcw.products ?? []).find(p => p.lineId === line.id)
const recipe = (dcw.recipes ?? []).find(r => r.lineId === line.id)
await j('POST', `/api/workshop/dcw/lines/${line.id}/stop`, {}, token)
await new Promise(r => setTimeout(r, 2500))
const st = await j('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id }, token)
console.log(`  · 开跑采样:start status=${st.status} ${st.code ?? ''}`)
await new Promise(r => setTimeout(r, 30_000))

const daq = (await j('GET', '/api/workshop/daq', undefined, token)).data
const daqNodes = (daq.nodes ?? []).filter(n => n.lineId === line.id)
const byName = re => daqNodes.find(n => re.test(n.name))
const baseScene = firstJson(String((await invoke('twin_scene_read', {})).text ?? ''))
const scene = {
  ...baseScene,
  lineId: line.id,
  productId: product.id,
  recipeId: recipe.id,
  observations: baseScene.observations.map(o => ({ ...o, nodeId: byName({ weight: /part-weight/, flash_rate: /flash-rate/, sink_rate: /sink-mark/ }[o.id])?.id })),
  states: baseScene.states.map(s => ({ ...s, nodeId: byName({ melt_temperature: /melt-temp-pv/, cavity_pressure: /melt-pressure-pv/ }[s.id])?.id })),
}
// auto_daq 走 Agent 的真实 DAQ 绑定:探针必须自备绑定(模板实例化不自带)
const requiredNodeIds = [...scene.observations, ...scene.states].map(o => o.nodeId).filter(Boolean)
let bound = 0
for (const m of members) {
  for (const nodeId of requiredNodeIds) {
    const r = await j('POST', '/api/workshop/agent-tools/bindings', { agentId: m.id, nodeId, kind: 'daq', mode: 'auto' }, token)
    if (r.code === 0) bound += 1
  }
}
check('探针自备 DAQ 绑定(auto_daq 前置)', bound >= members.length * requiredNodeIds.length, `bound=${bound} members=${members.length} nodes=${requiredNodeIds.length}`)
const snapRes = await invoke('twin_snapshot_create', { scene_json: scene, channel_id: twin.id, phase: 'holding', controls: { hold_pressure: 65, hold_time: 8, melt_temperature_setpoint: 247 }, auto_daq: true, freshness_max_ms: 300_000 })
const snapText = String(snapRes.text ?? '')
const snapshotId = (snapText.match(/snapshot_id:\s*(\S+)/) ?? [])[1]
const snapshot = snapshotId ? JSON.parse(readFileSync(`${HOME}/aml/twins/snapshots/${snapshotId}/snapshots.json`, 'utf8')) : null
check('真实快照生成(auto_daq 按绑定取样)', Boolean(snapshot) && snapshot.dataQuality?.fresh === true && Number(snapshot.daqWatermark) > 0, snapshot ? `${snapshotId} fresh=${snapshot.dataQuality?.fresh} stale=${(snapshot?.dataQuality?.staleNodeIds ?? []).length}` : snapText.slice(0, 160))
if (!snapshot) {
  console.log(`\n★ 0.7.48 探针:${pass} 通过 / ${fails.length} 失败(无法建快照,后续断言无意义)`)
  process.exit(2)
}
const controls = { hold_pressure: 65, hold_time: 8, melt_temperature_setpoint: 247 }
const objective = { schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: lead.id, objectiveId: 'weight-quality', targets: { weight: 32.5 }, weights: { weight: 1 }, controlCosts: {}, horizonSteps: 1, trustRegion: {} }
const trialOf = async (scene) => {
  const res = await invoke('twin_trial_run', { scene_json: scene, snapshot_json: snapshot, baseline_controls: controls, candidate_controls: [{ ...controls, hold_pressure: 67 }], objective })
  const text = String(res.text ?? '')
  const id = (text.match(/trial_id:\s*(\S+)/) ?? [])[1]
  const artifact = id ? JSON.parse(readFileSync(`${HOME}/aml/twins/trials/${id}/trials.json`, 'utf8')) : null
  return { text, trial: artifact?.trial ?? null }
}

// ① 可映射 id:baseline 预测克重 32.5 g 落在 31~34 内 → 应通过
const mapped = { ...scene, constraints: [{ id: 'weight', kind: 'hard_range', min: 31, max: 34 }] }
const okTrial = await trialOf(mapped)
const okWeight = okTrial.trial?.constraintResults?.[0]
check('可映射约束 id(weight)正常评估', Boolean(okTrial.trial) && okWeight?.id === 'weight' && okWeight.passed === true, `weight=${okTrial.trial?.predictedTrajectory?.[0]?.weight?.toFixed?.(3)} detail=${okWeight?.detail}`)

// ② 不可映射 id:必须失败关闭(旧版本这里会返回"全轨迹通过")
const unmapped = { ...mapped, constraints: [{ id: 'part_weight', kind: 'hard_range', min: 31, max: 34 }] }
const badTrial = await trialOf(unmapped)
const badCon = badTrial.trial?.constraintResults?.[0]
const allPassed = (badTrial.trial?.constraintResults ?? []).every(c => c.passed)
check('不可映射约束 id 判为不通过(失败关闭)', Boolean(badTrial.trial) && badCon?.passed === false && /无法映射/.test(String(badCon?.detail)), `passed=${badCon?.passed} detail=${String(badCon?.detail).slice(0, 80)}`)
check('候选不再被当作安全(constraints_passed=false)', allPassed === false, `constraints_passed=${allPassed}`)
check('工具文本同步反映未通过', /constraints_passed:\s*false/.test(badTrial.text), (badTrial.text.match(/constraints_passed:.*/) ?? [''])[0])

// ③ 空轨迹(候选为空)同样失败关闭
const empty = await invoke('twin_trial_run', { scene_json: mapped, snapshot_json: snapshot, baseline_controls: controls, candidate_controls: [], objective })
const emptyTrialId = (String(empty.text ?? '').match(/trial_id:\s*(\S+)/) ?? [])[1]
const emptyTrial = emptyTrialId ? JSON.parse(readFileSync(`${HOME}/aml/twins/trials/${emptyTrialId}/trials.json`, 'utf8')).trial : null
check('空轨迹判为不通过(不再默认通过)', emptyTrial ? emptyTrial.constraintResults.every(c => c.passed === false) : false, `details=${(emptyTrial?.constraintResults ?? []).map(c => c.detail).join(' | ').slice(0, 80)}`)

console.log(`\n★ 0.7.48 探针:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
