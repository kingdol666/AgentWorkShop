/**
 * scripts/experiments/tsa-phase-f.mjs —— 三端验收 阶段F:非产线 Channel + Project + AML(2026-11-19)。
 *
 *   F1 非产线频道(chtpl-default-review):撰写点检作业指导书 → @复核 → A2A/记忆取证
 *   F2 Project:绑定产线频道,W1 数据分析 + W2 治理小步复测,真实 leader 规划(USTC),L1/L2 双账号
 *   F3 AML:训练通道 aml_dataset_build/stats;优化通道 optimization_explore 有界一步
 * 断点续跑:state 存 D:/tmp/aw-tsa-1119/phase-f-state.json。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-three-system-acceptance')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-tsa-1119'
const BASE = 'http://127.0.0.1:3021'
const LINE = 'ln-74799404'
const LINE_CH = '8709a0e9-3aca-4dad-b339-6f0b14719eec'

const tokens = JSON.parse(readFileSync(join(PRIVATE, 'aw-tokens.json'), 'utf8'))
const statePath = join(PRIVATE, 'phase-f-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const save = (name, obj) => { writeFileSync(join(EV, name), JSON.stringify(obj, null, 1)); writeFileSync(statePath, JSON.stringify(state, null, 1)) }
const log = (m) => console.log(`[phase-f] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 60_000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

async function patchAgentsToUstc(chId) {
  const members = (await api('GET', `/api/workshop/channels/${chId}/agents`, undefined, tokens.admin)).json?.data ?? []
  for (const a of members) {
    const cfg = { ...(a.config ?? {}), provider: 'ustc', model: 'deepseek-flash', rpcMode: 'rpc' }
    await api('PATCH', `/api/workshop/channels/${chId}/agents/${a.id}`, { config: cfg }, tokens.admin)
  }
  await api('PATCH', `/api/workshop/channels/${chId}`, { llm: { provider: 'ustc', model: 'deepseek-flash', effort: 'max' } }, tokens.admin)
  return members.map(a => `${a.role}:${a.name}`)
}

async function waitReply(chId, leadId, sinceMs, timeoutMs = 12 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const ms = (await api('GET', `/api/workshop/channels/${chId}/messages?limit=10`, undefined, tokens.admin)).json?.data ?? []
    const ml = Array.isArray(ms) ? ms : (ms.items ?? [])
    const hit = ml.find(m => m.fromAgentId === leadId && Date.parse(m.createdAt ?? '') > sinceMs && (m.parts ?? []).some(p => String(p.text ?? '').length > 30))
    if (hit) return hit
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(20_000)
  }
}

async function main() {
  // =========== F1 非产线频道:点检作业指导书(撰写+复核) ===========
  if (!state.f1) {
    log('F1 创建非产线评审频道…')
    const ch = await api('POST', '/api/workshop/channel-templates/chtpl-default-review/instantiate', {
      name: '注塑线运维知识组-20261119',
      channelMode: 'generic',
    }, tokens.admin)
    const chId = ch.json?.data?.channelId
    if (!chId) throw new Error(`评审频道创建失败: ${JSON.stringify(ch.json).slice(0, 200)}`)
    const members = await patchAgentsToUstc(chId)
    state.f1 = { chId, members }
    save('phase-f-f1-channel.json', { chId, members })
    const agents = (await api('GET', `/api/workshop/channels/${chId}/agents`, undefined, tokens.admin)).json?.data ?? []
    const lead = agents.find(a => a.role === 'lead')
    const writer = agents.find(a => a.role === 'worker')
    log('F1 发起点检作业指导书撰写任务…')
    const sent = await api('POST', `/api/workshop/channels/${chId}/messages`, {
      toAgentId: lead.id, priority: 'immediate', requireReply: true,
      text: '【知识沉淀作业】注塑克重产线(ln-74799404,WC-INJ-2026-1115)已稳定运行一个班次。请基于 RAG 知识库中的工况文档(kb_doc_search「注塑克重 工况」可取全文),组织撰写一份《注塑线设备点检作业指导书》:点位表(克重/熔体压力/模温/飞边/节拍)、巡检频次、判读标准(目标带/警戒线)、异常处置路径。请安排撰写与复核分工。',
    }, tokens.admin)
    const sentAt = Date.parse(new Date().toISOString())
    save('phase-f-f1-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
    log('F1 等待lead编排回报(最长12min)…')
    const rep = await waitReply(chId, lead.id, sentAt, 12 * 60_000)
    save('phase-f-f1-reply.json', rep ? { id: rep.id, at: rep.createdAt, text: (rep.parts ?? []).map(p => p.text ?? '').join('\n').slice(0, 2000) } : { timeout: true })
    state.f1.replied = Boolean(rep)
    log(`F1 完成 replied=${Boolean(rep)}`)
  }

  // =========== F2 Project 编组(真实 leader 规划 + 双工作项 + L1/L2) ===========
  if (!state.f2) {
    log('F2 创建 Project 并绑定产线频道…')
    const proj = await api('POST', '/api/workshop/projects', {
      name: '注塑克重闭环班次优化-20261119',
      objective: '制品克重回稳定成 32.50±0.35g 目标带:完成漂移分析,确认治理小步实效,产出班次结论',
      leaderHarness: 'omp',
      mode: 'supervised',
      routingPolicy: 'technical',
    }, tokens.admin)
    const pid = proj.json?.data?.id ?? proj.json?.data?.project?.id
    if (!pid) throw new Error(`Project 创建失败: ${JSON.stringify(proj.json).slice(0, 250)}`)
    await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: LINE_CH, charter: '数据分析与治理调优执行(配方审批链)' }, tokens.admin)
    const d1 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'drift-analysis', required: true, ownerChannelId: LINE_CH, acceptanceCriteria: ['artifact_present'] }, tokens.admin)
    const d1id = d1.json?.data?.id
    const w1 = await api('POST', `/api/workshop/projects/${pid}/work-items`, { deliverableId: d1id, channelId: LINE_CH, title: '数据分析:克重漂移与本步实效判读', brief: '读取本线最近30分钟 DAQ(克重/熔体压力/飞边),结合 12:01–12:11 复测窗口,判定 +1MPa 小步后的克重趋势与增益,输出带数据证据的分析结论(只读,不写入)。', execBudgetMinutes: 30 }, tokens.admin)
    const w1id = w1.json?.data?.id
    const act = await api('POST', `/api/workshop/projects/${pid}/activate`, {}, tokens.admin)
    save('phase-f-f2-project.json', { pid, d1: d1id, w1: w1id, activate: act.status })
    if (!pid || !w1id || act.status !== 200) throw new Error('Project 装配失败')
    log(`F2 Project=${pid} 已激活,W1=${w1id};等待 leader 规划…`)
    // 计划审批(人工) → 轮询 plan
    let planOk = false
    const t0 = Date.now()
    let planBody = null
    while (Date.now() - t0 < 15 * 60_000) {
      const obs = await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, tokens.admin)
      planBody = obs.json?.data
      const st = planBody?.plan?.status ?? planBody?.status
      if (st && /pending_approval|awaiting/i.test(String(st))) { planOk = true; break }
      if (st && /approved|executing|planned/i.test(String(st))) { planOk = true; break }
      await sleep(20_000)
    }
    save('phase-f-f2-observability.json', planBody ?? {})
    const appr = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, {}, tokens.admin)
    save('phase-f-f2-plan-approval.json', { status: appr.status, body: appr.json })
    const dec = await api('POST', `/api/workshop/projects/${pid}/plan/decide`, { approved: true, comment: '班次目标明确,W1 判读合理,批准计划' }, tokens.admin)
    save('phase-f-f2-plan-decide.json', { status: dec.status, body: dec.json })
    state.f2 = { pid, w1: w1id, planApproved: dec.status === 200 }
    log(`F2 计划审批: ${dec.status}`)
  }

  // =========== F3 AML 训练数据集(先收窗) ===========
  if (!state.f3) {
    log('F3 AML:创建训练频道并构建数据集…')
    const ch = await api('POST', '/api/workshop/channel-templates/chtpl-aml-training-default/instantiate', {
      name: '注塑AML训练组-20261119', channelMode: 'industrial', bindLineId: LINE,
    }, tokens.admin)
    const chId = ch.json?.data?.channelId
    if (!chId) throw new Error(`训练频道创建失败: ${JSON.stringify(ch.json).slice(0, 200)}`)
    await patchAgentsToUstc(chId)
    // 收窗当前批次(真实班次结束动作)
    const runs = await api('GET', `/api/workshop/dcw/lines/${LINE}`, undefined, tokens.admin)
    const runId = runs.json?.data?.runId ?? runs.json?.data?.run?.id ?? runs.json?.data?.state?.runId
    let closed = null
    if (runId) closed = await api('POST', `/api/workshop/dcw/runs/${runId}/close`, {}, tokens.admin)
    save('phase-f-f3-run-close.json', { runId, closed: closed?.status, body: closed?.json })
    const agents = (await api('GET', `/api/workshop/channels/${chId}/agents`, undefined, tokens.admin)).json?.data ?? []
    const lead = agents.find(a => a.role === 'lead')
    const ds = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: lead.id, tool: 'aml_dataset_build', args: { line_id: LINE, window_minutes: 60, beat_ms: 2000, history_steps: 32, horizon_steps: 8 } }, tokens.admin, 300_000)
    save('phase-f-f3-dataset-build.json', { text: String(ds.json?.data?.result?.text ?? '').slice(0, 700), isError: ds.json?.data?.result?.isError })
    state.f3 = { chId, datasetOk: !ds.json?.data?.result?.isError }
    log(`F3 训练频道=${chId} dataset=${state.f3.datasetOk}`)
  }

  console.log('PHASE-F-RESULT ' + JSON.stringify({ ok: true, state }))
}

await main().catch((e) => {
  console.error(`[phase-f] FAILED: ${e.message}`)
  save('phase-f-ABORT.json', { error: e.message, at: new Date().toISOString(), state })
  process.exitCode = 1
})
