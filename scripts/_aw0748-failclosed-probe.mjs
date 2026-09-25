/**
 * 0.7.48 打包系统验收 · 硬约束失败关闭探针(无需 LLM,秒级)
 * 场景:同一份真实快照 + 同一组候选,只改 constraints[].id
 *   ① id = weight(可映射)→ 试验正常给出约束结论
 *   ② id = part_weight(不可映射)→ 必须**判不通过**并给出"无法映射"明细(v0.7.47 会假通过)
 * 用法:AW_BASE=http://127.0.0.1:3001 [AW_HOME=<home>] node scripts/_aw0748-failclosed-probe.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

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
const firstJson = (text) => {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null
}

const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
console.log(`\n═══ 0.7.48 硬约束失败关闭探针 @ ${BASE} ═══`)

// 复用最近一次真实快照(阶段 7 / 阶段 5 产物)
const snapRoot = `${HOME}/aml/twins/snapshots`
const dirs = existsSync(snapRoot)
  ? readdirSync(snapRoot).map(d => ({ d, m: statSync(`${snapRoot}/${d}`).mtimeMs })).sort((a, b) => b.m - a.m)
  : []
check('存在真实 TwinSnapshot 工件(取最新)', dirs.length > 0, dirs[0]?.d ?? '(无)')
if (!dirs.length) {
  console.log('\n★ 无可复用快照,先跑阶段 7/5 生成')
  process.exit(2)
}
const snapshot = JSON.parse(readFileSync(`${snapRoot}/${dirs[0].d}/snapshots.json`, 'utf8'))
check('快照新鲜且水位>0(可直接跑试验)', snapshot.dataQuality?.fresh === true && Number(snapshot.daqWatermark) > 0, `fresh=${snapshot.dataQuality?.fresh} watermark=${snapshot.daqWatermark}`)

const chans = (await j('GET', '/api/workshop/channels', undefined, token)).data ?? []
const twin = chans.find(c => /闭环优化-hybridtwin/.test(c.name))
const members = (await j('GET', `/api/workshop/channels/${twin.id}/agents`, undefined, token)).data ?? []
const lead = members.find(m => m.role === 'lead')
const invoke = async (tool, args) => (await j('POST', '/api/workshop/agent-tools/invoke', { agentId: lead.id, tool, args }, token)).data?.result ?? {}

const baseScene = firstJson(String((await invoke('twin_scene_read', {})).text ?? ''))
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
const mapped = { ...baseScene, lineId: snapshot.lineId, productId: snapshot.productId, recipeId: snapshot.recipeId, constraints: [{ id: 'weight', kind: 'hard_range', min: 31, max: 34 }] }
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
