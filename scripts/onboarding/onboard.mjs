/**
 * scripts/onboarding/onboard.mjs —— 一键接入编排器(skill 全阶段流水;2026-10-10 优化轮)。
 *
 * 从**一份统一配置 JSON**直接创建:连通性预检 → 产线供给(线/节点/上下限/配方/开跑)→
 * 场景化频道锻造(模板/插件/绑定/MES 授权配方/种子任务)→ V1-V6 验收 →(可选)冒烟闭环步
 * (自动 HITL 裁决)→ 交接声明。**投入使用必须由用户 judge & taste,本脚本只到"可投用"为止**。
 *
 * 统一配置 JSON(provision-line / forge-channel / verify-line 的输入并集):
 * {
 *   "line":{"name":..,"description":..}, "nodes":[...同 provision...], "recipe":{...},
 *   "startLine":true, "product":{"name":..}?,
 *   "connectivity":{"tests":[...]}?,            // 缺省=跳过预检(--skip-connectivity 同效)
 *   "channel":{"scenario":"optimize","name":..,"plugins":{..},"bindings":[..],
 *              "mesFetchGrants":[{agentRole,nodeIds:[..]}]?, "seedTask":{..},
 *              "scene"?:{..}, "promptVariables"?:{..}},
 *   "smoke":{"param":"线速SP","delta":4}?,       // 可选:冒烟闭环步(自动 HITL;建议测试期用)
 *   "verify":{"plugins":[..]}?                   // 其余字段由供给摘要自动推导
 * }
 * 用法:node scripts/onboarding/onboard.mjs <config.json> [--skip-connectivity] [--smoke]
 * 交接红线:冒烟=测试语义(自动裁决);正式投用由用户在界面上做 judge & taste 后自行放行。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const configPath = args.find(a => !a.startsWith('--'))
const skipConnectivity = args.includes('--skip-connectivity')
const smoke = args.includes('--smoke')
if (!configPath) {
  console.error('用法:node scripts/onboarding/onboard.mjs <config.json> [--skip-connectivity] [--smoke]')
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))

let pass = 0, fail = 0
let smokeRunId = null
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 150)}` : ''}`)
  cond ? pass++ : fail++
  return cond
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 跑子脚本:输出落临时文件,返回 {code, out};末行 JSON 摘要由调用方解析 */
function runScript(script, configObj, label) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-onboard-'))
  const cfgFile = join(dir, 'cfg.json')
  const outFile = join(dir, 'out.log')
  writeFileSync(cfgFile, JSON.stringify(configObj, null, 1))
  const code = (() => {
    const outFd = openSync(outFile, 'a')
    try {
      execFileSync(process.execPath, [resolve('scripts/onboarding', script), cfgFile], {
        stdio: ['ignore', outFd, outFd],
        timeout: 15 * 60_000,
      })
      return 0
    }
    catch (e) {
      return e.status ?? 1
    }
    finally {
      closeSync(outFd)
    }
  })()
  const out = readFileSync(outFile, 'utf8')
  console.log(out.split('\n').filter(l => l.trim()).slice(-4).join('\n'))
  ok(label, code === 0, `exit=${code}`)
  const last = out.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).at(-1)
  let summary = {}
  try {
    summary = last ? JSON.parse(last) : {}
  }
  catch { /* 无摘要行 */ }
  return { code, out, summary }
}

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
async function api(m, u, b, tok) {
  return (await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) })).json()
}
async function login() {
  if (process.env.AW_TOKEN) return process.env.AW_TOKEN
  const j = await api('POST', '/api/users/login', { email: process.env.AW_EMAIL ?? 'admin@awshop.local', password: process.env.AW_PASS ?? 'admin123' })
  return j.data?.token
}

// ---------- 阶段 1:连通性预检(未全绿不供给) ----------
if (cfg.connectivity?.tests?.length && !skipConnectivity) {
  const r = runScript('test-connection.mjs', { tests: cfg.connectivity.tests }, '阶段1 连通性预检')
  if (r.code !== 0) {
    console.error('连通性未全绿 —— 按 skill 铁律不进入供给;请修正 driverConfig 或向用户确认连接信息后重跑。')
    process.exit(1)
  }
}
else ok('阶段1 连通性预检', true, skipConnectivity ? '显式跳过' : '配置无 tests,跳过')

// ---------- 阶段 2:产线供给 ----------
const provRun = runScript('provision-line.mjs', {
  line: cfg.line, nodes: cfg.nodes, recipe: cfg.recipe, product: cfg.product,
  productId: cfg.productId, startLine: cfg.startLine !== false,
}, '阶段2 产线供给')
if (provRun.code !== 0) process.exit(1)
const prov = provRun.summary

// ---------- 阶段 3:场景化频道锻造 ----------
const ch = cfg.channel ?? {}
const forgeRun = runScript('forge-channel.mjs', {
  scenario: ch.scenario ?? 'optimize', name: ch.name ?? `${cfg.line.name}闭环频道`,
  lineId: prov.lineId, plugins: ch.plugins ?? {}, bindings: ch.bindings ?? [],
  mesFetchGrants: (ch.mesFetchGrants ?? []).map(g => ({ ...g, nodeIds: (g.nodeIds ?? []).map(n => prov.dcw[n] ?? n) })),
  seedTask: ch.seedTask, provision: prov, scene: ch.scene, promptVariables: ch.promptVariables,
}, '阶段3 频道锻造')
if (forgeRun.code !== 0) process.exit(1)
const chSummary = forgeRun.summary

// ---------- 阶段 3b:MES 直取可见面验证(历史-only 节点不在 V1 数采面,必须用真实 mes_fetch 证明) ----------
if (Array.isArray(ch.mesFetchGrants) && ch.mesFetchGrants.length > 0) {
  const tok = await login()
  const members = await api('GET', `/api/workshop/channels/${chSummary.channelId}/agents`, undefined, tok)
  const agents = members.data ?? []
  const workers = agents.filter(a => a.role === 'worker')
  const resolveAgent = (role) => {
    if (role === 'lead') return agents.find(a => a.role === 'lead')?.id ?? agents.find(a => a.role === 'lead')?.agentId
    const idx = Number(String(role).split(':')[1] ?? 0)
    return workers[idx]?.id ?? workers[idx]?.agentId
  }
  const from = new Date(Date.now() - 30 * 60_000).toISOString()
  const to = new Date().toISOString()
  for (const g of ch.mesFetchGrants) {
    const agentId = resolveAgent(g.agentRole)
    const ids = (g.nodeIds ?? []).map(n => prov.dcw[n] ?? n)
    if (!agentId || ids.length === 0) {
      ok(`阶段3b MES直取[${g.agentRole}]`, false, `agentId=${agentId} nodeIds=${ids.length}`)
      continue
    }
    for (const id of ids) {
      const nodeCfg = cfg.nodes.find(n => prov.dcw[n.name] === id)
      const nodeName = nodeCfg?.name ?? id
      let hm = {}
      try {
        hm = typeof nodeCfg?.driverConfig?.historyMap === 'string'
          ? JSON.parse(nodeCfg.driverConfig.historyMap)
          : (nodeCfg?.driverConfig?.historyMap ?? {})
      }
      catch { /* 配置坏由 mes_fetch 自身报错 */ }
      const format = String(hm?.response?.format ?? 'scalar')
      const expectDict = Boolean(hm?.response?.dictionaryPath || nodeCfg?.driverConfig?.dictionary)
      const expectedPoints = Number(g.expectedPoints ?? 0)
      const r = await api('POST', '/api/workshop/agent-tools/invoke', {
        agentId,
        tool: 'mes_fetch',
        args: { ids: [id], from, to, max_rows: 20, ...(format === 'vector' ? { include_data: true } : {}) },
      }, tok)
      const d = r?.data?.result ?? r?.data ?? {}
      const text = String(d.text ?? '')
      const rows = Number(/行数\s+(\d+)/.exec(text)?.[1] ?? 0)
      const dimOk = format !== 'vector'
        || (expectedPoints > 0 ? new RegExp(`dim=${expectedPoints}(?!\\d)`).test(text) : /dim=\d+/.test(text))
      const imageArtifactOk = format !== 'image' || /产物\(\d+(?:,[^)]*)?\):/.test(text)
      const formatOk = format === 'vector'
        ? dimOk && /values=\[/.test(text)
        : format === 'image'
          ? /格式 图像\(/.test(text) && imageArtifactOk
          : format === 'table' || format === 'event'
            ? /格式 表格记录|格式 事件记录/.test(text)
            : /格式 标量/.test(text) && /统计:/.test(text)
      const dictOk = !expectDict || /字段字典\(\d+ 个字段/.test(text)
      ok(`阶段3b MES直取[${nodeName}]`, d.isError !== true && rows > 0 && formatOk && dictOk,
        `rows=${rows} dim=${dimOk} img=${imageArtifactOk} format=${formatOk} dict=${dictOk} | ${text.split('\n').slice(0, 2).join(' | ').slice(0, 140)}`)
      await sleep(300)
    }
  }
}

// ---------- 阶段 4:V1-V6 验收(verify 配置自动推导) ----------
const verifyCfg = {
  lineId: prov.lineId, recipeId: prov.recipeId, channelId: chSummary.channelId,
  dcw: cfg.nodes.filter(n => n.kind === 'dcw' && n.driver !== 'mes-rest').map((n) => {
    const id = prov.dcw[n.name]
    const step = Number(n.stepLimit ?? Math.max(1, Math.round((n.max - n.min) / 20)))
    const probe = n.probeValue ?? Math.round(n.min + (n.max - n.min) * 0.35)
    return { id, name: n.name, min: n.min, max: n.max, stepLimit: step, probeValue: probe }
  }),
  daq: cfg.nodes.filter(n => n.kind === 'daq').map(n => prov.daq[n.name]).filter(Boolean),
  recipeParams: (cfg.recipe?.params ?? []).map(p => ({
    nodeId: prov.dcw[p.node] ?? p.node,
    value: p.value,
    ...(p.min != null ? { min: p.min } : {}),
    ...(p.max != null ? { max: p.max } : {}),
    ...(p.stepLimit != null ? { stepLimit: p.stepLimit } : {}),
  })),
  plugins: Object.entries(cfg.channel?.plugins ?? {}).filter(([, enabled]) => enabled === true).map(([name]) => name),
}
const verifyRun = runScript('verify-line.mjs', verifyCfg, '阶段4 V1-V6 验收')
if (verifyRun.code !== 0) {
  console.error('验收未全绿 —— 不得交付投用;按报告修复后重跑。')
  process.exit(1)
}

// ---------- 阶段 5(可选):冒烟闭环步(自动 HITL 裁决;测试语义) ----------
if (smoke) {
  const tok = await login()
  const bs = await api('GET', '/api/workshop/agent-tools/bindings', undefined, tok)
  const workerId = (bs?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === prov.recipeId)?.agentId ?? ''
  ok('冒烟:持配方绑定 Agent', !!workerId, workerId.slice(0, 8))
  const agg = await api('GET', '/api/workshop/dcw', undefined, tok)
  const smokeParam = cfg.smoke?.param ?? Object.entries(prov.dcw).find(([k]) => k.includes('SP'))?.[0]
  const node = (agg?.data?.nodes ?? []).find(n => n.id === prov.dcw[smokeParam])
  const cur = Math.round(Number(node?.value ?? (node?.min + node?.max) / 2))
  // 冒烟目标必须落在当前配方窗口内;当前值可能已被上一轮冒烟推到窗口上沿,
  // 直接 cur+delta 会越窗(实测 47+2 > 48)。优先向窗内反向走,仍越界则夹到边界。
  const smokeRp = (cfg.recipe?.params ?? []).find(p => p.node === smokeParam)
  const lower = smokeRp?.min ?? node?.min ?? Number.NEGATIVE_INFINITY
  const upper = smokeRp?.max ?? node?.max ?? Number.POSITIVE_INFINITY
  let target = cur + Number(cfg.smoke?.delta ?? 1)
  if (target > upper) target = cur - Number(cfg.smoke?.delta ?? 1)
  target = Math.min(upper, Math.max(lower, target))
  target = Math.round(target * 10) / 10
  ok('冒烟目标在配方窗口内', target >= lower && target <= upper, `cur=${cur} target=${target} window=${lower}~${upper}`)
  let okDispatch = false
  let propTxt = ''
  for (let attempt = 1; attempt <= 4 && !okDispatch; attempt++) {
    const pkg = { name: `SM-冒烟步(${attempt})`, params: [{ node_id: node.id, to: target, basis: `投用冒烟(测试语义,自动裁决):${cur}→${target}(≤步限)`, exp_ref: 'onboard --smoke 自动 HITL' }] }
    const smokeMarker = `SM-冒烟步(${attempt})`
    const known = new Set((await api('GET', '/api/workshop/hitl/pending', undefined, tok))?.data?.items?.map(x => x.id) ?? [])
    const propP = api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'recipe_propose', args: { recipe_id: prov.recipeId, packages: [pkg] } }, tok)
      .then(r => r?.data?.result ?? { text: '' })
      .catch(e => ({ text: `冒烟 invoke 失败:${e instanceof Error ? e.message : String(e)}` }))
    let card = null
    for (let i = 0; i < 60 && !card; i++) {
      await sleep(2000)
      const pend = await api('GET', '/api/workshop/hitl/pending', undefined, tok)
      const items = pend?.data?.items ?? []
      // 只批准本次冒烟新挂的单:必须是 invoke 前不存在、recipe-propose 且 detail 含本包名,
      // 防 seed task/其他 Agent 并发提案被误批。
      card = items.find(x => !known.has(x.id)
        && x.kind === 'dcw-approval'
        && /^recipe-propose:/.test(String(x.nodeId ?? ''))
        && String(x.detail ?? '').includes(smokeMarker)) ?? null
    }
    if (!card) {
      ok(`冒烟闭环步(attempt ${attempt})`, false, '未出现本次 SM-冒烟步 的 recipe-propose 审批卡(拒绝批准他卡)')
      break
    }
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment: `冒烟自动裁决(测试语义,attempt ${attempt})`, choice: 0 }, tok)
    const prop = await propP
    let txt = String(prop?.text ?? '')
    const flying = /已有在飞方案审批单\((ap-[\w-]+)\)/.exec(txt)?.[1]
    if (flying) {
      const items = (await api('GET', '/api/workshop/hitl/pending', undefined, tok))?.data?.items ?? []
      const flyingCard = items.find(x => x.id === flying && String(x.detail ?? '').includes(smokeMarker))
      if (!flyingCard) {
        txt = `在飞审批单 ${flying} 不属于本次冒烟,拒绝自动批准`
      }
      else {
        await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: flying, confirmed: true, comment: '冒烟:批准本方案在飞单', choice: 0 }, tok)
        await sleep(5000)
        const r2 = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'recipe_propose', args: { recipe_id: prov.recipeId, packages: [pkg] } }, tok)
        txt = String(r2?.data?.result?.text ?? '')
      }
    }
    propTxt = txt
    okDispatch = /已获批准|已批准/.test(txt) && /设备证实/.test(txt) && !/失败|超时未批|未获批准/.test(txt)
    if (!okDispatch) {
      const w = Number(/请等待约?\s*(\d+)s/.exec(txt)?.[1] ?? 0)
      if (w > 0 && attempt < 4) {
        console.log(`  ⏳ 治理窗(${w}s),等 ${w + 10}s 重提…`)
        await sleep((w + 10) * 1000)
        continue
      }
    }
  }
  smokeRunId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? null
  ok('冒烟闭环步(自动 HITL):批准→下发→设备证实', okDispatch, `${propTxt.split('\n')[0]?.slice(0, 90)} runId=${smokeRunId}`)
}

// ---------- 交接声明 ----------
console.log(`
================ 交接声明(投用前必读)================
落袋 id:线=${prov.lineId} 配方=${prov.recipeId} 频道=${chSummary.channelId}
冒烟语义 = 测试(自动 HITL 裁决)。**投入使用前请产线负责人在界面上做 judge & taste**:
  ① 复核绑定矩阵与 HITL 策略(配方绑定当前 manual,每步下发需人工批准);
  ② 确认量程/步长/安全限与工艺规程一致;
  ③ 由人裁决首批真实提案后,方可视为正式投用。
(对产线负责:任何不确定 —— 量程/步限/SP-PV 判定/认证方式/场景目标 —— skill 必须先询问用户,禁止猜测。)
=====================================================`)
// 机器可读摘要(末行 JSON;与 provision-line/forge-channel 摘要惯例对齐,供管道解析)
console.log(JSON.stringify({ summary: true, lineId: prov.lineId, recipeId: prov.recipeId, channelId: chSummary.channelId, smokeRunId, pass, fail }))
console.log(`\n======== 一键接入: ${pass} 通过 / ${fail} 失败 ========`)
process.exit(fail === 0 ? 0 : 1)
