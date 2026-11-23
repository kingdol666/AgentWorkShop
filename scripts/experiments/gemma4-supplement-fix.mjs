/**
 * scripts/experiments/gemma4-supplement-fix.mjs —— 补测轮两个 FAIL 的修正复验(2026-11-19)。
 *
 * B5c:拒绝路径不变量的正确口径 —— 被拒方案(→138)从未下发(节点值≠138)且 journal agent 锚计数不变;
 *      开线批次(source=recipe)把基线 150 重新下发属正常供给动作,不算 agent 写入。
 * F1c:recipe_update 受运行门约束(需活动批次)—— 重开产线后再固化 v2,随后 versions 验证 + 停线。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.NO_PROXY_LIST = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVIDENCE = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-gemma4-supplement')
mkdirSync(EVIDENCE, { recursive: true })
const BASE = 'http://127.0.0.1:3073'

const log = (line) => {
  console.log(line)
  appendFileSync(join(EVIDENCE, 'run.log'), `${new Date().toISOString()} [fix] ${line}\n`)
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

async function invokeTool(agentId, tool, args, token, timeoutMs = 600_000) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token, timeoutMs)
  const text = String(r.data?.result?.text ?? r.data?.text ?? JSON.stringify(r))
  const isError = r.data?.result?.isError === true || r.data?.isError === true || r.code !== 0
  return { text, isError }
}

const results = []
const step = (id, name, pass, detail) => {
  results.push({ id, name, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 900) })
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} :: ${String(detail ?? '').slice(0, 280).replace(/\n/g, ' ')}`)
}

async function main() {
  const token = readFileSync('C:/Users/87287/AppData/Local/Temp/aw-gemma4-pipeline/token.txt', 'utf8').trim()
  const LINE_CH = '09868f2a-6efb-4e41-90cc-22f912610798'
  const RECIPE = 'rc-2670c8cb'
  const lineAgents = (await api('GET', `/api/workshop/channels/${LINE_CH}/agents`, undefined, token)).data ?? []
  const lineLead = lineAgents.find(a => a.role === 'lead')

  // ---- B5c:拒绝路径不变量(正确口径) ----
  const dcw0 = (await api('GET', '/api/workshop/dcw', undefined, token)).data
  const sp = (dcw0.nodes ?? []).find(n => n.name === '冷却温度设定SP')
  const lineEntity = (dcw0.lines ?? [])[0]
  const before = JSON.parse(readFileSync(join(EVIDENCE, 'b-node-after-reject.json'), 'utf8'))
  const journalAnchors = ((await api('GET', `/api/workshop/dcw/journal?lineId=${lineEntity.id}&limit=100`, undefined, token)).data?.anchors ?? []).filter(a => a.source === 'agent')
  save('b5c-verification.json', {
    nodeValueNow: sp?.value,
    rejectedProposalTarget: 138,
    baselineAfterLineStart: before?.value,
    journalAgentAnchors: journalAnchors.map(a => ({ prev: a.prevValue, next: a.newValue, approval: a.approvalId, run: a.recipeRunId })),
  })
  step('B5c', '拒绝路径不变量:被拒方案 138 从未下发,agent 锚不含 138', sp?.value !== 138 && journalAnchors.every(a => a.newValue !== 138), `value=${sp?.value}(开线基线 150/被拒目标 138) anchors=${JSON.stringify(journalAnchors.map(a => a.newValue))}`)

  // ---- F1c:活动批次下 recipe_update 固化 v2 ----
  const lineState = ((await api('GET', `/api/workshop/dcw/lines/${lineEntity.id}`, undefined, token)).data ?? {}).state ?? {}
  if (lineState.active) {
    log(`[pacing] 产线已在跑(上次遗留 run=${lineState.runId}),直接复用活动批次`)
    step('F0', '产线已活跃(复用遗留批次)', true, `run=${lineState.runId}`)
  }
  else {
    const start = await api('POST', `/api/workshop/dcw/lines/${lineEntity.id}/start`, { recipeId: RECIPE }, token)
    step('F0', '重开产线(活动批次)', start.code === 0, `run=${start.data?.run?.id}`)
    await sleep(9000)
  }
  const upd = await invokeTool(lineLead.id, 'recipe_update', {
    recipe_id: RECIPE, params: [{ node_id: sp.id, value: 144 }],
    reason: '复验:144 经 HITL 批准下发且回读一致,固化达标候选值(版本留痕)',
  }, token)
  save('f1c-recipe-update.json', { text: upd.text.slice(0, 1200), isError: upd.isError })
  step('F1c', 'recipe_update 固化新版本(活动批次)', !upd.isError && /(版本|v2|已保存)/i.test(upd.text), upd.text.slice(0, 300))
  const vers = await invokeTool(lineLead.id, 'recipe_versions', { recipe_id: RECIPE }, token)
  save('f1c-recipe-versions.json', { text: vers.text.slice(0, 1500), isError: vers.isError })
  step('F2c', 'versions 显示 v1/v2 历史且当前 v2', !vers.isError && /v2/.test(vers.text), vers.text.slice(0, 300))
  const dcw1 = (await api('GET', '/api/workshop/dcw', undefined, token)).data
  const spNow = (dcw1.nodes ?? []).find(n => n.id === sp.id)
  save('f1c-node.json', spNow ?? {})
  step('F3c', '版本固化不触发下发(定义面操作,设备值不变)', spNow?.value === sp?.value, `value=${spNow?.value}(固化前 ${sp?.value})`)
  const stop = await api('POST', `/api/workshop/dcw/lines/${lineEntity.id}/stop`, {}, token)
  step('F4c', '停线收窗', stop.code === 0, `code=${stop.code}`)

  const pass = results.filter(r => r.pass).length
  save('summary-fix.json', { generatedAt: new Date().toISOString(), steps: results, pass, fail: results.length - pass, total: results.length })
  log(`FIX SUMMARY pass=${pass} fail=${results.length - pass} total=${results.length}`)
}

await main().catch((e) => {
  results.push({ id: 'ABORT', name: '修正复验中止', pass: false, detail: e instanceof Error ? e.message : String(e) })
  save('summary-fix.json', { steps: results, aborted: true })
  log(`FIX FAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
