/**
 * E2E · AML 训练与优化控制解耦验收(2026-09-26 计划 v3;验收规范 A/B/C/D/E 五组)。
 * 用法: node scripts/e2e-aml-decoupled.mjs [base=3005]
 * 依赖:平台已运行;复用现有产线/数据集/模型资产(训练 spec 来自 live-optloop run 目录)。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const BASE = process.argv[2] ? `http://127.0.0.1:${process.argv[2]}` : 'http://127.0.0.1:3005'
const RUNDIR = join(REPO, 'bench', 'results', '2026-09-26T01-55-11-aml-live-optloop')
const DATASET_ID = 'ds-muhrindr-0a4b2s'
const LINE_ID = 'ln-fd7cf3a0'
const MODEL_ID = 'mdl-muhy2feb-pd5iy3'
const SCENE_ID = 'castfilm-hold-opt-0926T0155'
const DATASET_SPEC_PATH = join(REPO, 'aml', 'datasets', DATASET_ID, 'spec.json')
process.env.NO_PROXY = '127.0.0.1,localhost'

const results = []
function assert(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
      return { status: r.status, json: await r.json().catch(() => null) }
    }
    catch (err) {
      if (attempt === 2) throw err
      await sleep(3000)
    }
  }
}
const reg = await api('POST', '/api/workshop/users/register', { name: `decouple-${Date.now()}` })
const token = reg.json?.data?.token
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'users.sqlite'))
  db.prepare(`UPDATE users SET role='admin' WHERE email LIKE 'decouple-%' AND role='user'`).run()
  db.close()
}
if (!token) throw new Error('注册失败')

/* ═══ A. 解耦:两面互斥 ═══ */
const tplTrain = await api('POST', '/api/workshop/channel-templates/chtpl-aml-training-default/instantiate', { name: `验收-训练通道-${Date.now() % 10000}` }, token)
const trainCh = tplTrain.json?.data
assert('A1a 训练通道实例化', tplTrain.status === 200 && !!trainCh?.channelId, JSON.stringify(tplTrain.json).slice(0, 120))
const trainWorker = trainCh.agents.find(a => a.role === 'worker')
const tplOpt = await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', { name: `验收-优化通道-${Date.now() % 10000}` }, token)
const optCh = tplOpt.json?.data
assert('A1b 优化通道实例化', tplOpt.status === 200 && !!optCh?.channelId, JSON.stringify(tplOpt.json).slice(0, 120))
const optWorker = optCh.agents.find(a => a.role === 'worker')

const trainTools = (await api('GET', `/api/workshop/agent-tools/list?agentId=${trainWorker.id}`, undefined, token)).json?.data?.tools?.map(t => t.name) ?? []
const optTools = (await api('GET', `/api/workshop/agent-tools/list?agentId=${optWorker.id}`, undefined, token)).json?.data?.tools?.map(t => t.name) ?? []
assert('A1c 训练面无 MPC/直写', !trainTools.includes('twin_trial_run') && !trainTools.includes('mpc_optimize') && !trainTools.includes('dcw_control') && !trainTools.includes('optimization_explore'), trainTools.filter(t => /twin_trial|mpc|dcw_control|explore|bayes/.test(t)).join(','))
assert('A1d 训练面有建模/训练/场景', trainTools.includes('aml_job_submit') && trainTools.includes('aml_dataset_build') && trainTools.includes('twin_scene_discover') && trainTools.includes('aml_training_plan_train'))
assert('A1e 优化面无训练族', !optTools.includes('aml_job_submit') && !optTools.includes('aml_dataset_build') && !optTools.includes('aml_training_plan_train'), optTools.filter(t => /aml_job|aml_dataset|plan/.test(t)).join(','))
assert('A1f 优化面有探索/验证/寻优', optTools.includes('optimization_explore') && optTools.includes('twin_trial_run') && optTools.includes('twin_bayes_optimize'))

const gateProfile = await api('GET', `/api/workshop/channels/${optCh.channelId}/twin-profile`, undefined, token)
assert('A2a 优化通道初始=探索模式', gateProfile.json?.data?.derived?.mode === 'exploration', JSON.stringify(gateProfile.json?.data?.derived ?? null).slice(0, 80))
const mpcReject = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'mpc_optimize', args: { snapshot_id: 'snap-none', baseline_controls: {} } }, token)
assert('A2b 探索模式拒绝 MPC', mpcReject.status === 200 && /探索模式/.test(mpcReject.json?.data?.result?.text ?? ''), (mpcReject.json?.data?.result?.text ?? '').slice(0, 100))
const bayesReject = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'twin_bayes_optimize', args: { snapshot_id: 'snap-none', baseline_controls: {} } }, token)
assert('A2c 探索模式拒绝贝叶斯', /探索模式|模型驱动/.test(bayesReject.json?.data?.result?.text ?? ''), (bayesReject.json?.data?.result?.text ?? '').slice(0, 80))
const trainJobReject = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'aml_job_submit', args: { dataset_id: 'x', code: 'x', change_note: 'x' } }, token)
assert('A2d 优化通道拒绝训练族', /职责解耦|仅限/.test(trainJobReject.json?.data?.result?.text ?? ''), (trainJobReject.json?.data?.result?.text ?? '').slice(0, 80))

/* ═══ E1/E3 提示词:绑定节点 + 工况块 + 场景提示 ═══ */
const bindDcw = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: optWorker.id, nodeId: 'dw-352ec66a', kind: 'dcw', mode: 'auto' }, token)
const bindDaq = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: optWorker.id, nodeId: 'dn-a0d54660', kind: 'daq', mode: 'auto' }, token)
assert('E0a 绑定数控/数采节点', bindDcw.status === 200 && bindDaq.status === 200)
const tuningRes = await api('PATCH', `/api/workshop/agent-tools/bindings/${bindDcw.json?.data?.binding?.id}`, { tuning: { step: 0.5, note: '线速度微调;温度未稳时禁调' } }, token)
assert('E0b 绑定调试元数据(step=0.5)', tuningRes.status === 200 && tuningRes.json?.data?.binding?.tuning?.step === 0.5)

const goalObjective = { schemaVersion: 1, objectiveId: 'thickness-50um', targets: { node_cd2d2d09b5fd7d72: 50 }, weights: { node_cd2d2d09b5fd7d72: 1 }, controlCosts: {}, horizonSteps: 4, trustRegion: {} }
const patchGoal = await api('PATCH', `/api/workshop/channels/${optCh.channelId}/twin-profile`, { objective: goalObjective }, token)
assert('E0c goal 下发(REST)', patchGoal.status === 200 && patchGoal.json?.data?.profile?.objective?.objectiveId === 'thickness-50um')

const promptRes = await api('GET', `/api/workshop/channels/${optCh.channelId}/twin-profile?agentId=${optWorker.id}`, undefined, token)
const prompt = promptRes.json?.data?.derived?.promptPreview ?? ''
assert('E1 探索模式提示词(纪律+工况块+跨度)', /探索执行者/.test(prompt) && /调试范围/.test(prompt) && /每步跨度 0\.5/.test(prompt) && /物理意义/.test(prompt), prompt.slice(0, 120))
assert('E3 场景提示追加', /工艺优化团队/.test(prompt))

/* ═══ B. 真实探索与数据回流 ═══ */
const dcwBefore = (await api('GET', '/api/workshop/dcw/', undefined, token)).json?.data?.nodes.find(n => n.id === 'dw-352ec66a')?.value
const explore = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'optimization_explore', args: { direction: 'up', settle_seconds: 12, hypothesis: 'E2E 探索:验证真实写入与响应配对' } }, token)
const exploreText = explore.json?.data?.result?.text ?? ''
assert('B1a 探索步真实写入成功', /探索步完成/.test(exploreText), exploreText.slice(0, 150))
const dcwAfter = (await api('GET', '/api/workshop/dcw/', undefined, token)).json?.data?.nodes.find(n => n.id === 'dw-352ec66a')?.value
assert('B1b DCW 设定实际变化', Number(dcwAfter) !== Number(dcwBefore), `${dcwBefore} → ${dcwAfter}`)
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'workshop.sqlite'), { readOnly: true })
  const row = db.prepare('SELECT COUNT(*) AS c FROM optimization_explorations WHERE channel_id = ? AND write_status = ?').get(optCh.channelId, 'ok')
  db.close()
  assert('B1c 探索记录落库(写入值↔响应值)', row.c >= 1, `rows=${row.c}`)
}

/* ═══ C. 建模任务:创建 → 立即修正训练 → 模型入册 ═══ */
const datasetsRes = await api('GET', '/api/workshop/aml/datasets', undefined, token)
const ds = (datasetsRes.json?.data?.datasets ?? []).find(d => d.id === DATASET_ID)
assert('C0 现有数据集可用', !!ds?.id, ds?.id)
const trainingSpecPath = join(RUNDIR, 'physics-spec-remapped.json')
const trainingSpec = existsSync(trainingSpecPath) ? JSON.parse(readFileSync(trainingSpecPath, 'utf8')) : null
const datasetSpec = existsSync(DATASET_SPEC_PATH) ? JSON.parse(readFileSync(DATASET_SPEC_PATH, 'utf8')) : ds?.spec ?? ds?.datasetSpec ?? null
assert('C0b 训练 spec 可用', !!trainingSpec)
assert('C0c 数据集 spec 可用', !!datasetSpec)
const planRes = await api('POST', '/api/workshop/aml/training-plans', {
  name: 'E2E 修正训练任务', lineId: LINE_ID, productId: ds.productId, recipeId: ds.recipeId,
  sceneId: SCENE_ID, sceneVersion: '1.0.0', objectiveId: 'thickness-50um',
  strategy: 'manual', datasetSpec, trainingSpec,
  modelNamePrefix: 'E2E 解耦验收模型', params: { epochs: 600, hidden: 192, lr: 0.0008, residual_scale: 2.5, ensemble: 3 }, seed: 7,
}, token)
assert('C1a 建模任务创建', planRes.status === 200 && !!planRes.json?.data?.plan?.id, JSON.stringify(planRes.json).slice(0, 150))
const planId = planRes.json?.data?.plan?.id
const trainRes = await api('POST', `/api/workshop/aml/training-plans/${planId}/train`, {}, token)
assert('C1b 修正训练触发', trainRes.status === 200 && !!trainRes.json?.data?.jobId, JSON.stringify(trainRes.json).slice(0, 120))
let planDone = null
for (let i = 0; i < 60; i++) {
  await sleep(10_000)
  const st = (await api('GET', '/api/workshop/aml/training-plans', undefined, token)).json?.data?.plans?.find(p => p.id === planId)
  if (st && (st.lastStatus === 'done' || st.lastStatus === 'failed')) {
    planDone = st
    break
  }
}
assert('C2 修正训练完成且模型入册', planDone?.lastStatus === 'done' && !!planDone?.lastModelId, `status=${planDone?.lastStatus} model=${planDone?.lastModelId}`)

/* ═══ D. 投用:绑定校验 → 模型受控 → trial/bayes ═══ */
const rejectBind = await api('PATCH', `/api/workshop/channels/${optCh.channelId}/twin-profile`, { boundModelId: 'mdl-muhrno7x-l5fp4f' }, token)
assert('D1 未过门模型绑定被拒(409)', rejectBind.status === 409, JSON.stringify(rejectBind.json).slice(0, 100))
const okBind = await api('PATCH', `/api/workshop/channels/${optCh.channelId}/twin-profile`, { boundModelId: MODEL_ID, optimizationMode: 'aml' }, token)
assert('D2 合规模型绑定 → 模型受控', okBind.status === 200 && okBind.json?.data?.mode === 'model_backed', JSON.stringify(okBind.json?.data).slice(0, 100))

const snapRes = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'twin_snapshot_create', args: { auto_daq: true, channel_id: optCh.channelId, phase: 'calibration' } }, token)
const snapshotId = (snapRes.json?.data?.result?.text ?? '').match(/snapshot_id:\s*(\S+)/)?.[1]
assert('D3a 快照创建', !!snapshotId, (snapRes.json?.data?.result?.text ?? '').slice(0, 80))
const baseline = { node_3bb27a47f55e26fb: 95.2, node_82be092f2cdf43f4: 200, node_09ee97dc03e102a7: 150, node_45c7316fe5067dfd: 200, node_ca64b4f10ae9cd2c: 1, node_d1298f9e18c09b4d: 200 }
const trialRes = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'twin_trial_run', args: { snapshot_id: snapshotId, model_id: MODEL_ID, baseline_controls: baseline, candidate_controls: Array.from({ length: 4 }, () => ({ ...baseline, node_3bb27a47f55e26fb: 95.2 + 0.5 })) } }, token)
const trialText = trialRes.json?.data?.result?.text ?? ''
assert('D3b 孪生验证用绑定模型 rollout', new RegExp(MODEL_ID).test(trialText) && /training|hybrid|模型驱动/.test(trialText), trialText.slice(0, 120))
const bayesRes = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: optWorker.id, tool: 'twin_bayes_optimize', args: { snapshot_id: snapshotId, baseline_controls: baseline, rounds: 2, candidates_per_round: 4 } }, token)
const bayesText = bayesRes.json?.data?.result?.text ?? ''
assert('D4 贝叶斯寻优(收敛轨迹+受治理推荐)', /surrogate_ucb/.test(bayesText) && /convergence/.test(bayesText) && /recommendationId/.test(bayesText), bayesText.slice(0, 120))

/* ═══ E4 模式切换后提示词重算 ═══ */
const backToExplore = await api('PATCH', `/api/workshop/channels/${optCh.channelId}/twin-profile`, { optimizationMode: 'exploration' }, token)
const promptAfter = (await api('GET', `/api/workshop/channels/${optCh.channelId}/twin-profile?agentId=${optWorker.id}`, undefined, token)).json?.data?.derived
assert('E4 模式切换 → 提示词重算(回探索纪律)', backToExplore.status === 200 && promptAfter.mode === 'exploration' && /探索执行者/.test(promptAfter.promptPreview ?? ''), (promptAfter.promptPreview ?? '').slice(0, 80))

/* ═══ 汇总 ═══ */
const pass = results.filter(r => r.ok).length
console.log(`\n===== E2E 解耦验收:${pass}/${results.length} 通过 =====`)
if (pass < results.length) {
  for (const f of results.filter(r => !r.ok)) console.log(`  FAIL: ${f.name} ${f.detail}`)
  process.exit(1)
}
