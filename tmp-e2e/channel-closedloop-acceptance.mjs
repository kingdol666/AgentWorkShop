/**
 * 验收级端到端:Channel 创建闭环控制 + HITL 正反路径 + 数据获取分析(2026-10-09)。
 *
 * 被测主体 = **从零实例化的新频道**(模板 chtpl-generic-opti 通用闭环优化频道):
 *   腿 C  频道创建与装配(模板实例化 → 克隆 worker → lead 绑定 → 委托 → 绑线 → 激活)
 *   腿 L  闭环控制(新频道 worker:line_status → daq_query 观测 → recipe_propose → HITL 批准 → 设备证实 → 复测)
 *   腿 H  HITL 正反路径(卡片要素 / 拒绝意见逐字回流+节点值未变 / 审计留痕 / 线域定向通知)
 *   腿 D  数据获取分析(新频道 worker:daq_export 全窗宽表 → CSV 本地统计 → 与 daq_query 对拍)
 *   腿 Z  清理(频道删除 / 基准锚复原)
 *
 * 前置:3001 生产服务;benchmark 线在册运行(ln-5b12e11a, holdP 锚 63)。
 */
import benchCfg from '../scripts/testing/benchmark.config.json' with { type: 'json' }
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cfg = benchCfg
const BASE = 'http://127.0.0.1:3001'
const WORKER_TPL = '00f3c815-e623-4aa4-9ec6-b5ac01fd1b3f' // live-worker(omp)
const checks = []
let TOKEN = ''

function ok(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 170) })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 170)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token = TOKEN) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  let j = null
  try {
    j = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(j ?? {}) }
}

/** Agent 工具桥直调(返回 { text, isError }) */
async function inv(agentId, tool, args, timeoutMs = 400_000) {
  const res = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => ({}))
  return j?.data?.result ?? { text: JSON.stringify(j?.data ?? j).slice(0, 200), isError: j?.code !== 0 }
}

/** 并行裁决:审批卡出现后批准/拒绝;choice 仅整包方案需要 */
async function adjudicate(pattern, approved, comment, choice) {
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending')
    const items = pend?.data?.items ?? pend?.data?.cards ?? []
    card = items.filter(x => x.kind === 'dcw-approval' && pattern.test(String(x.nodeId ?? '')))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  }
  if (!card) return null
  const resp = await api('POST', '/api/workshop/hitl/respond', {
    kind: 'dcw-approval', id: card.id, confirmed: approved, comment,
    ...(Number.isInteger(choice) ? { choice } : {}),
  })
  return { ...card, _respond: resp?.code ?? resp?.status }
}

const login = await api('POST', '/api/users/login', { email: cfg.account.email, password: cfg.account.password })
TOKEN = login?.data?.token ?? ''
ok('登录(admin)', !!TOKEN, login?.message ?? '')

// ================= 腿 C:频道创建与装配 =================
console.log('\n── 腿 C:Channel 从零创建与装配 ──')
const stamp = Date.now().toString(36)
const chName = `验收-闭环频道-${stamp}`
const inst = await api('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate', {
  name: chName,
  bindLineId: cfg.lineId,
})
const channelId = inst?.data?.channelId ?? inst?.data?.channel?.id ?? ''
ok('C1 模板实例化频道', !!channelId, `ch=${String(channelId).slice(0, 12)}`)
// leadId 从频道台账取(instantiate 响应不带 leadAgentId 字段)
const chRow0 = (await api('GET', '/api/workshop/channels'))
const leadId = (chRow0?.data?.items ?? chRow0?.data ?? []).find(c => c.id === channelId)?.leadAgentId ?? ''
ok('C1b lead 身份可读(频道台账)', !!leadId, `lead=${String(leadId).slice(0, 8)}`)
const wAdd = await api('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: WORKER_TPL, name: `${chName}-worker` })
const workerId = wAdd?.data?.id ?? wAdd?.data?.agentId ?? wAdd?.data?.agent?.id ?? ''
ok('C2 worker 克隆在册(lead+worker 双成员)', !!workerId, `worker=${String(workerId).slice(0, 8)}`)
const members = await api('GET', `/api/workshop/channels/${channelId}/agents`)
const mCount = (members?.data?.items ?? members?.data ?? []).length
ok('C3 频道成员清单可读', mCount >= 2, `members=${mCount}`)

const daqNodes = [cfg.nodes.daq.weight, cfg.nodes.daq.spMirror]
let bindOk = 0
const bindErrs = []
for (const nodeId of [cfg.recipeId, ...daqNodes]) {
  const kind = nodeId === cfg.recipeId ? 'recipe' : 'daq'
  const g = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId, kind, mode: 'manual' })
  if (g?.code === 0 || g?.status === 200) bindOk += 1
  else bindErrs.push(`${kind}:${String(nodeId).slice(0, 10)} ${g?.message ?? g?.code}`)
}
ok('C4 lead 绑定(recipe manual + daq×2)', bindOk === 3, bindOk === 3 ? '3/3' : bindErrs.join(' | ').slice(0, 140))
const grant = await api('POST', '/api/workshop/agent-tools/bindings/grant', {
  channelId, agentId: workerId, nodeIds: [cfg.recipeId, ...daqNodes], mode: 'manual',
})
ok('C5 lead→worker 委托(manual)', grant?.code === 0, JSON.stringify(grant?.data ?? grant?.message ?? '').slice(0, 90))
const chList = await api('GET', '/api/workshop/channels')
const chRow = (chList?.data?.items ?? chList?.data ?? []).find(c => c.id === channelId)
ok('C6 频道绑线生效', String(chRow?.lineId ?? '') === cfg.lineId, `lineId=${chRow?.lineId ?? '(空)'}`)
const act = await api('POST', `/api/workshop/channels/${channelId}/activate`)
ok('C7 频道激活', act?.code === 0 || act?.status === 200, `${act.code ?? act.status} ${act.message ?? ''}`)

// ================= 腿 L:闭环控制(新频道 worker) =================
console.log('\n── 腿 L:新频道闭环控制 ──')
const st = await inv(workerId, 'line_status', {})
ok('L1 line_status 产线上下文(worker 可用)', !st.isError && /产线/.test(String(st.text ?? '')), String(st.text ?? '').split('\n')[0]?.slice(0, 80))
const now = Date.now()
const obs = await inv(workerId, 'daq_query', { node_id: cfg.nodes.daq.weight, from_ms: now - 8 * 60_000, to_ms: now, bucket_ms: 5_000 })
ok('L2 daq_query 观测 8min 有数', !obs.isError && /\d/.test(String(obs.text ?? '')), String(obs.text ?? '').split('\n')[1]?.slice(0, 70) ?? '')

// propose(单参微步 63→64,五要素)→ HITL 批准 → 设备证实(治理窗按提示等待;在飞单直接批准收敛)
let propTxt = '(未执行)'
let okDispatch = false
let cardL = null
for (let attempt = 1; attempt <= 4 && !okDispatch; attempt++) {
  const pkg = {
    name: `AC-保压微升(验收 ${attempt})`,
    params: [{ node_id: cfg.nodes.dcw.holdP, to: 64, basis: '验收闭环:当前 63→64(≤步限 10bar,有界单变量)', exp_ref: 'KB:R1/R2 方向性实证;验收基准锚 63' }],
  }
  const propP = inv(workerId, 'recipe_propose', { recipe_id: cfg.recipeId, packages: [pkg], emergency: true })
  cardL = await adjudicate(/^recipe-propose:/, true, `验收自动裁决:批准该闭环步(方案 #0,attempt ${attempt})`, 0)
  const prop = await propP
  let txt = String(prop.text ?? '')
  // 在飞单收敛:同配方同时只允许一张在飞单 —— 上一 attempt 的卡若未被裁决窗捕获,这里直接批准它再重提
  const flying = /已有在飞方案审批单\((ap-[\w-]+)\)/.exec(txt)?.[1]
  if (flying) {
    console.log(`  ↩ 在飞单 ${String(flying).slice(0, 10)} 采纳:批准后重提`)
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: flying, confirmed: true, comment: '验收:批准在飞单(收敛重复提交)', choice: 0 })
    await sleep(5000)
    const prop2 = await inv(workerId, 'recipe_propose', { recipe_id: cfg.recipeId, packages: [pkg], emergency: true }, 300_000)
    txt = String(prop2.text ?? '')
  }
  propTxt = txt
  okDispatch = /已获批准|已批准/.test(txt) && /设备证实/.test(txt) && !/失败|超时未批|未获批准/.test(txt)
  if (!okDispatch) {
    const waitSec = Number(/请等待约?\s*(\d+)s/.exec(txt)?.[1] ?? 0)
    if (waitSec > 0 && attempt < 4) {
      console.log(`  ⏳ 治理窗未放行(在岗),等 ${waitSec + 10}s 后重提(attempt ${attempt}→${attempt + 1})…`)
      await sleep((waitSec + 10) * 1000)
      continue
    }
  }
}
ok('L3 提案→批准→整批下发(设备证实)', okDispatch, propTxt.split('\n')[0]?.slice(0, 110))
const runId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? ''
ok('L4 回执携带 runId(回访锚)', !!runId, runId)
await sleep(15_000)
if (okDispatch) {
  const post = await inv(workerId, 'daq_query', { node_id: cfg.nodes.daq.spMirror, from_ms: Date.now() - 60_000, to_ms: Date.now(), bucket_ms: 5_000 })
  ok('L5 镜像 SP 复测跟上(64)', !post.isError && /64/.test(String(post.text ?? '')), String(post.text ?? '').split('\n')[1]?.slice(0, 70) ?? '')
}
else ok('L5 镜像 SP 复测跟上(64)', false, '(L3 未下发,跳过前提)')

// ================= 腿 H:HITL 正反路径 =================
console.log('\n── 腿 H:HITL 正反路径 ──')
ok('H1 审批卡含推理依据(basis/exp_ref)', !!cardL && /basis|依据|exp_ref/.test(JSON.stringify(cardL)), cardL ? String(cardL.id).slice(0, 12) : '(无卡)')
// 拒绝路径:微调 64→63 提案(若被拒,值保持 64)
const rejComment = `验收拒绝路径:保持当前设定,不做回调(${stamp})`
const updP = inv(workerId, 'recipe_update', {
  recipe_id: cfg.recipeId,
  params: [{ node_id: cfg.nodes.dcw.holdP, value: 63 }],
  reason: `验收 HITL 反路径:尝试回调 ${64}→63(预期被拒,验证意见回流)`,
})
const cardH = await adjudicate(/^recipe:/, false, rejComment)
const upd = await updP
const updTxt = String(upd.text ?? '')
ok('H2 拒绝:人工意见逐字回流', !!cardH && /人工未批准/.test(updTxt) && updTxt.includes(stamp), `card=${cardH ? String(cardH.id).slice(0, 10) : '(无卡)'} ${updTxt.split('\n')[0]?.slice(0, 70)}`)
const dcwNow = await api('GET', '/api/workshop/dcw')
const holdPRow = (dcwNow?.data?.nodes ?? []).find(n => n.id === cfg.nodes.dcw.holdP)
ok('H3 拒绝后节点值未变(无越权执行)', Number(holdPRow?.value) === 64, `holdP=${holdPRow?.value}`)
const testStartAt = new Date(Date.now() - 30 * 60_000).toISOString()
const auditRows = await api('GET', `/api/workshop/audit?action=approval.reject&limit=50`)
const rejRows = auditRows?.data?.entries ?? auditRows?.data ?? []
const topRej = rejRows.find((l) => {
  const d = l.detail ?? {}
  const chId = d.channelId ?? l.channelId
  const status = d.status ?? l.status
  return chId === channelId && status === 'rejected' && String(l.at ?? '') >= testStartAt
})
ok('H4 审计留痕:拒绝决定可追溯(actor/频道/状态)', !!topRej, topRej ? `${String(topRej.actorName ?? topRej.actor ?? '')}@${String(topRej.at ?? '').slice(11, 19)} ch=${String((topRej.detail ?? {}).channelId ?? '').slice(0, 8)} status=${(topRej.detail ?? {}).status}` : `(audit 返回 ${rejRows.length} 条,无本频道条目)`)
// 线域定向通知:线 operate 用户收到 hitl_request(硬ening E0 已授 ops-ack 线域 operate)
const opsLogin = await api('POST', '/api/users/login', { email: 'ops-ack@test.local', password: 'OpsAck@2026' })
const opsTok = opsLogin?.data?.token ?? ''
const notif = opsTok ? await api('GET', '/api/workshop/notifications?limit=30', undefined, opsTok) : null
const notifItems = notif?.data?.notifications ?? notif?.data?.items ?? notif?.data ?? []
const hitlNotif = (Array.isArray(notifItems) ? notifItems : []).find(n => /审批|hitl/i.test(String(n.title ?? '') + String(n.body ?? n.summary ?? '')))
ok('H5 线域定向通知触达(operate 用户)', !!hitlNotif, hitlNotif ? String(hitlNotif.title ?? '').slice(0, 60) : `(notifications=${Array.isArray(notifItems) ? notifItems.length : 'shape:' + Object.keys(notif?.data ?? {}).join(',')})`)

// ================= 腿 D:数据获取分析 =================
console.log('\n── 腿 D:数据获取与分析 ──')
const dFrom = Date.now() - 30 * 60_000
const exp = await inv(workerId, 'daq_export', { line_id: cfg.lineId, from_ms: dFrom, merge: true, purpose: `验收:全窗宽表分析(${stamp})` })
const expId = /daqexp-[\d]+-[\w]+/.exec(String(exp.text ?? ''))?.[0] ?? ''
ok('D1 daq_export 全窗宽表(worker 可导出)', !!expId && !exp.isError, expId || String(exp.text ?? '').split('\n')[0]?.slice(0, 80))
const csvPath = expId ? resolve('.AgentWorkShop', 'data', 'daq-exports', expId, 'merged.csv') : ''
const csvExists = !!expId && existsSync(csvPath)
ok('D2 CSV 落盘可读', csvExists, csvPath.slice(-60))
let mean = null
let std = null
let inSpec = null
let n = 0
if (csvExists) {
  const lines = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/)
  const header = (lines[0] ?? '').split(',')
  const wCol = header.findIndex(h => h.includes('克重'))
  const vals = lines.slice(1).map(r => Number(r.split(',')[wCol >= 0 ? wCol : 1])).filter(Number.isFinite)
  n = vals.length
  if (n > 0) {
    mean = vals.reduce((a, b) => a + b, 0) / n
    std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
    inSpec = vals.filter(v => Math.abs(v - 32.5) <= 0.35).length / n
  }
}
ok('D3 宽表行数达标(≥100)', n >= 100, `rows=${n}`)
ok('D4 克重统计有效(mean 32.3±0.4 / inSpec ≥60%)', mean != null && Math.abs(mean - 32.3) <= 0.4 && inSpec >= 0.6, `mean=${mean?.toFixed(3)} std=${std?.toFixed(3)} inSpec=${(inSpec * 100)?.toFixed(1)}%`)
const seg = await inv(workerId, 'daq_query', { node_id: cfg.nodes.daq.weight, from_ms: Date.now() - 10 * 60_000, to_ms: Date.now(), bucket_ms: 60_000 })
const segMeanStr = String(seg.text ?? '')
const segVals = [...segMeanStr.matchAll(/均值[=:]?\s*([\d.]+)/g)].map(m => Number(m[1]))
const segMean = segVals.length ? segVals.reduce((a, b) => a + b, 0) / segVals.length : null
ok('D5 daq_query 分桶与导出统计对拍(±0.5g)', segMean != null && mean != null && Math.abs(segMean - mean) <= 0.5, `query均值=${segMean?.toFixed(3)} vs export均值=${mean?.toFixed(3)}`)

// ================= 腿 Z:清理 =================
console.log('\n── 腿 Z:清理与复原 ──')
const chDel = await api('DELETE', `/api/workshop/channels/${channelId}`)
ok('Z1 验收频道删除(用后清场)', chDel?.code === 0 || chDel?.status === 200, `${chDel.code ?? chDel.status}`)
// 基准锚复原:配方 REST 路(hardening F 后线 auto+绑定 auto → 免批直执行)
await api('PUT', `/api/workshop/dcw/recipes/${cfg.recipeId}`, {
  params: [{ nodeId: cfg.nodes.dcw.holdP, value: 63 }],
  reason: `验收收尾:恢复基准锚 63(${stamp})`,
})
await sleep(1000)
const applyZ = await api('POST', `/api/workshop/dcw/recipes/${cfg.recipeId}/apply`)
const zResults = applyZ?.data?.run?.results ?? []
ok('Z2 基准锚复原并整批下发(设备证实)', zResults.length >= 5 && zResults.every(r => r.ok), `results=${zResults.length} 全证实=${zResults.every(r => r.ok)}`)

const pass = checks.filter(c => c.pass).length
console.log(`\n======== 验收 e2e(频道闭环+HITL+数据分析): ${pass}/${checks.length} ========`)
process.exit(pass === checks.length ? 0 : 1)
