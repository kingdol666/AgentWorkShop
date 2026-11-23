/**
 * scripts/experiments/gemma4-supplement.mjs —— Gemma4 验收补测轮(2026-11-19)。
 *
 * 针对覆盖盘点识别出的未测项,在**存活实例 :3073**(上一轮 PIPELINE 的最终环境)上补测:
 *   A. worker 直派任务(assigneeId=worker 的独立派发路径)
 *   B. HITL 拒绝路径(批准的对面:拒绝+指导 → 零下发)
 *   C. 跨 Channel 通信(lead-only toChannelId + requireReply)
 *   D. validated 产线经验的召回复用(search_memory)
 *   E. 任务取消路径(CANCELED + 无经验副作用)
 *   F. recipe_update 版本固化 + versions 查询
 *   X. 全程模型来源取证(omp 会话 = local/gemma)
 *
 * 用法:node scripts/experiments/gemma4-supplement.mjs
 * 前置::3073 存活实例(PIPELINE 最终轮环境)+ LM Studio gemma-4-12b-qat @ 64k。
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.NO_PROXY_LIST = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVIDENCE = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-gemma4-supplement')
mkdirSync(EVIDENCE, { recursive: true })
const BASE = 'http://127.0.0.1:3073'
const MODEL_REF = 'local/google/gemma-4-12b-qat'
const AGENT_CFG = { provider: 'local', model: 'google/gemma-4-12b-qat', rpcMode: 'rpc' }

const log = (line) => {
  console.log(line)
  appendFileSync(join(EVIDENCE, 'run.log'), `${new Date().toISOString()} ${line}\n`)
}
const save = (name, obj) => {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 1))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 120_000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  }
  catch {
    json = { raw: text.slice(0, 2000) }
  }
  if (json && typeof json === 'object') json.httpStatus = r.status
  return json
}

async function pollUntil(fn, { timeoutMs = 120_000, everyMs = 3000, label = 'poll' } = {}) {
  const t0 = Date.now()
  let last = null
  for (;;) {
    try {
      last = await fn()
      if (last && last.done) return last
    }
    catch { /* 瞬态重试 */ }
    if (Date.now() - t0 > timeoutMs) {
      log(`[${label}] TIMEOUT ${Math.round((Date.now() - t0) / 1000)}s`)
      return { ...(last ?? {}), done: false, timeout: true }
    }
    await sleep(everyMs)
  }
}

async function invokeTool(agentId, tool, args, token, timeoutMs = 600_000) {
  const t0 = Date.now()
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token, timeoutMs)
  const text = String(r.data?.result?.text ?? r.data?.text ?? JSON.stringify(r))
  const isError = r.data?.result?.isError === true || r.data?.isError === true || r.code !== 0
  return { text, isError, ms: Date.now() - t0 }
}

function ompModelProvenance(sinceMs) {
  const root = join(homedir(), '.omp', 'agent', 'sessions')
  const out = []
  for (const dir of readdirSync(root)) {
    if (!dir.includes('AgentWorkShop-data-workspaces')) continue
    let files
    try {
      files = readdirSync(join(root, dir)).filter(f => f.endsWith('.jsonl'))
    }
    catch { continue }
    for (const f of files) {
      try {
        const p = join(root, dir, f)
        if (statSync(p).mtimeMs < sinceMs) continue
        const models = new Set()
        for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
          try {
            const j = JSON.parse(line)
            if (j?.type === 'message' && j.message?.role === 'assistant' && j.message?.model) models.add(`${j.message.provider}/${j.message.model}`)
          }
          catch { /* 坏行 */ }
        }
        if (models.size) out.push({ file: f, dir: dir.slice(0, 60), models: [...models] })
      }
      catch { /* 单文件失败 */ }
    }
  }
  return out
}

const results = []
const step = (id, name, pass, detail) => {
  results.push({ id, name, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 900) })
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} :: ${String(detail ?? '').slice(0, 280).replace(/\n/g, ' ')}`)
}

// ---------- 主流程 ----------
async function main() {
  const token = readFileSync('C:/Users/87287/AppData/Local/Temp/aw-gemma4-pipeline/token.txt', 'utf8').trim()
  const t0 = Date.now()
  const CH = 'ce1bfe22-91d8-4f44-ac66-24bb1f1acbda' // 通用频道(lead+worker)
  const LINE_CH = '09868f2a-6efb-4e41-90cc-22f912610798' // 绑线频道
  const RECIPE = 'rc-2670c8cb'

  const agents = (await api('GET', `/api/workshop/channels/${CH}/agents`, undefined, token)).data ?? []
  const lead = agents.find(a => a.role === 'lead' && !String(a.name).includes('·session'))
  const worker = agents.find(a => a.role === 'worker' && a.name === 'Gemma Worker')
  const lineAgents = (await api('GET', `/api/workshop/channels/${LINE_CH}/agents`, undefined, token)).data ?? []
  const lineLead = lineAgents.find(a => a.role === 'lead')
  if (!lead?.id || !worker?.id || !lineLead?.id) throw new Error('成员缺失,无法补测')

  // ===== A. worker 直派任务 =====
  log('── 补测A:worker 直派任务 ──')
  const subA = await api('POST', `/api/workshop/channels/${CH}/tasks`, {
    title: 'worker 直派:5+7',
    description: '只输出数字:5 + 7 等于多少?不要调用任何工具,直接给出答案。',
    assigneeId: worker.id, mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' }, fromLabel: '验收员',
  }, token)
  const tidA = subA.data?.id
  const doneA = await pollUntil(async () => {
    const list = (await api('GET', `/api/workshop/channels/${CH}/tasks`, undefined, token)).data ?? []
    const t = list.find(x => x.id === tidA)
    return { done: ['COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED', 'EXPIRED'].includes(t?.state), task: t, state: t?.state }
  }, { timeoutMs: 25 * 60_000, everyMs: 15_000, label: 'worker-direct' })
  save('a-worker-direct-task.json', doneA.task ?? {})
  const artA = JSON.stringify(doneA.task?.artifacts ?? [])
  step('A1', 'worker 直派任务 COMPLETED 且产物=12(非工具报错)', doneA.state === 'COMPLETED' && /\b12\b/.test(artA) && !/Validation failed|xd:\/\/|tool `/.test(artA), `state=${doneA.state} artifacts=${artA.slice(0, 160)}`)

  // ===== B. HITL 拒绝路径 =====
  log('── 补测B:HITL 拒绝路径 ──')
  const dcw0 = (await api('GET', '/api/workshop/dcw', undefined, token)).data
  const spNode = (dcw0.nodes ?? []).find(n => n.name === '冷却温度设定SP')
  const spId = spNode?.id
  const lineEntity = (dcw0.lines ?? [])[0]
  const journalBefore = ((await api('GET', `/api/workshop/dcw/journal?lineId=${lineEntity.id}&limit=100`, undefined, token)).data?.anchors ?? []).filter(a => a.source === 'agent').length
  const startB = await api('POST', `/api/workshop/dcw/lines/${lineEntity.id}/start`, { recipeId: RECIPE }, token)
  step('B1', '产线重启(拒绝路径前置)', startB.code === 0, `run=${startB.data?.run?.id}`)
  await sleep(9000)
  const proposeB = invokeTool(lineLead.id, 'recipe_propose', {
    recipe_id: RECIPE,
    packages: [{
      name: '递减至 138(B 负例:将拒绝)',
      rationale: '窗口中值 138;本卡将被拒绝以验证拒绝路径',
      params: [{ node_id: spId, from: 144, to: 138, unit: '°C', basis: '窗口中值(将拒绝)', exp_ref: `负例:${lineEntity.id}` }],
    }],
  }, token, 10 * 60_000)
  const cardB = await pollUntil(async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${LINE_CH}`, undefined, token)
    return { done: (p.data?.items ?? []).some(i => i.kind === 'dcw-approval'), items: p.data?.items ?? [] }
  }, { timeoutMs: 120_000, everyMs: 3000, label: 'reject-card' })
  const hitlB = (cardB.items ?? []).find(i => i.kind === 'dcw-approval')
  save('b-reject-card.json', hitlB ?? {})
  step('B2', '审批卡生成(待拒绝)', Boolean(hitlB), JSON.stringify(hitlB ?? {}).slice(0, 200))
  if (hitlB) {
    const rej = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: hitlB.id, confirmed: false, cancelled: false, comment: '验收负例:拒绝本方案(理由:保持 144 已达标,无需再调);请勿重复提交同方向提案。' }, token)
    save('b-reject-decide.json', rej.data ?? rej)
    step('B3', 'HITL 拒绝(附指导)', rej.code === 0 && rej.data?.status === 'rejected', `status=${rej.data?.status}`)
  }
  const proposeResultB = await proposeB
  save('b-propose-result.json', { text: proposeResultB.text.slice(0, 1500), isError: proposeResultB.isError })
  step('B4', 'Agent 收到拒绝回执(方案未下发)', /拒绝/.test(proposeResultB.text), proposeResultB.text.slice(0, 300))
  const dcw1 = (await api('GET', '/api/workshop/dcw', undefined, token)).data
  const spAfter = (dcw1.nodes ?? []).find(n => n.id === spId)
  const journalAfter = ((await api('GET', `/api/workshop/dcw/journal?lineId=${lineEntity.id}&limit=100`, undefined, token)).data?.anchors ?? []).filter(a => a.source === 'agent').length
  save('b-node-after-reject.json', spAfter ?? {})
  step('B5', '产线零写入(节点值不变,journal 无新 agent 锚)', spAfter?.value === 144 && journalAfter === journalBefore, `value=${spAfter?.value} journal_agent=${journalBefore}→${journalAfter}`)
  const stopB = await api('POST', `/api/workshop/dcw/lines/${lineEntity.id}/stop`, {}, token)
  step('B6', '停线收窗', stopB.code === 0, `code=${stopB.code}`)

  // ===== C. 跨 Channel 通信 =====
  log('── 补测C:跨 Channel 通信 ──')
  const chB = await api('POST', '/api/workshop/channels', {
    name: 'Gemma4 跨频道协同频道',
    channelMode: 'generic',
    scenarioPrompt: '你是协同频道成员。回答简洁、直接,不需要调用工具。',
    leadAgent: { name: 'Gemma Lead B', harness: 'omp', config: AGENT_CFG },
  }, token)
  const chBId = chB.data?.channelId ?? chB.data?.id
  if (!chBId) throw new Error('跨频道频道创建失败')
  const cross = await api('POST', `/api/workshop/channels/${CH}/messages`, {
    fromAgentId: lead.id, toChannelId: chBId,
    text: '跨频道协同测试:请只回复一行纯文本 CROSS-OK-7。不要调用工具。',
    requireReply: true,
  }, token)
  save('c-cross-send.json', { code: cross.code, message: cross.message, data: cross.data ?? null })
  const crossReply = await pollUntil(async () => {
    const list = (await api('GET', `/api/workshop/channels/${chBId}/messages?limit=50`, undefined, token)).data ?? []
    const rep = list.find(m => (m.parts ?? []).some(p => String(p.text ?? '').includes('CROSS-OK-7')))
    return { done: Boolean(rep), rep }
  }, { timeoutMs: 20 * 60_000, everyMs: 10_000, label: 'cross-channel' })
  save('c-cross-reply.json', crossReply.rep ?? {})
  step('C1x', '跨频道直投成功(lead-only)', cross.code === 0, JSON.stringify({ code: cross.code, msg: cross.message }).slice(0, 160))
  step('C2x', '跨频道 requireReply 回执(CROSS-OK-7)', Boolean(crossReply.rep), String((crossReply.rep?.parts ?? [{}])[0]?.text ?? '').slice(0, 100))

  // ===== D. validated 经验召回 =====
  log('── 补测D:validated 经验召回 ──')
  const recall = await invokeTool(lineLead.id, 'search_memory', { query: '冷却温度 SP 温度整定 144', scope: 'auto', limit: 8 }, token)
  save('d-recall.json', { text: recall.text.slice(0, 2500), isError: recall.isError })
  step('D1', 'validated line 经验被召回(含整定/144 与 scope 标识)', !recall.isError && /(整定|144)/.test(recall.text) && /(line|validated|experience)/i.test(recall.text), recall.text.slice(0, 300))

  // ===== E. 任务取消路径 =====
  log('── 补测E:任务取消路径 ──')
  const subE = await api('POST', `/api/workshop/channels/${CH}/tasks`, {
    title: '取消路径测试:长任务', description: '计算 1 加 1 并输出。', mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' }, fromLabel: '验收员',
  }, token)
  const tidE = subE.data?.id
  const cancel = await api('POST', `/api/workshop/tasks/${tidE}/cancel`, {}, token)
  save('e-cancel.json', { code: cancel.code, state: cancel.data?.state, message: cancel.message })
  step('E1', '任务取消 → CANCELED', cancel.code === 0 && cancel.data?.state === 'CANCELED', `code=${cancel.code} state=${cancel.data?.state} msg=${cancel.message ?? ''}`)
  const finalE = (await api('GET', `/api/workshop/channels/${CH}/tasks`, undefined, token)).data ?? []
  const taskE = finalE.find(x => x.id === tidE)
  step('E2', '取消后任务终态稳定(CANCELED 不再执行)', taskE?.state === 'CANCELED', `state=${taskE?.state}`)

  // ===== F. recipe_update 版本固化 =====
  log('── 补测F:recipe 版本固化 ──')
  const upd = await invokeTool(lineLead.id, 'recipe_update', {
    recipe_id: RECIPE, params: [{ node_id: spId, value: 144 }],
    reason: '复验:144 经 HITL 批准下发且回读一致,固化达标候选值(版本留痕)',
  }, token)
  save('f-recipe-update.json', { text: upd.text.slice(0, 1200), isError: upd.isError })
  step('F1', 'recipe_update 固化新版本', !upd.isError && /(版本|v2|已保存)/i.test(upd.text), upd.text.slice(0, 250))
  const vers = await invokeTool(lineLead.id, 'recipe_versions', { recipe_id: RECIPE }, token)
  save('f-recipe-versions.json', { text: vers.text.slice(0, 1500), isError: vers.isError })
  step('F2', 'versions 可查(v1/v2 历史)', !vers.isError && /v?2/.test(vers.text), vers.text.slice(0, 250))

  // ===== X. 模型取证 =====
  const provenance = ompModelProvenance(t0)
  save('omp-provenance.json', provenance)
  const allLocal = provenance.length > 0 && provenance.every(p => p.models.every(m => m === MODEL_REF))
  step('X1', '补测回合模型来源全部=local/gemma', allLocal, JSON.stringify(provenance.map(p => ({ f: p.file.slice(0, 36), m: p.models }))).slice(0, 400))

  const pass = results.filter(r => r.pass).length
  const summary = { generatedAt: new Date().toISOString(), phase: 'supplement-2026-11-19', port: 3073, steps: results, pass, fail: results.length - pass, total: results.length }
  save('summary.json', summary)
  log(`SUMMARY pass=${pass} fail=${results.length - pass} total=${results.length}`)
}

await main().catch((e) => {
  results.push({ id: 'ABORT', name: '补测中止', pass: false, detail: e instanceof Error ? e.message : String(e) })
  save('summary.json', { generatedAt: new Date().toISOString(), phase: 'supplement-2026-11-19', steps: results, aborted: true })
  log(`SUPPLEMENT FAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
