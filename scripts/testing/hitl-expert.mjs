// HITL 人工专家代理 v2:产线工程师视角裁决审批卡,打印完整理由供报告引用。
// 裁决链:①方向校验(A: SP 只许向上;B: screw 只许向下)②依据数值证据校验 ③首案步幅规程 ④批准+附言
// 场景A 第2次批准前注入 heaterDecay 扰动(工况恶化)并告知。
// 用法: node hitl-expert.mjs <channelId> <scenario A|B>
import { appendFileSync } from 'node:fs'

const [channelId, scenario] = process.argv.slice(2)
const GOAL_UP = scenario === 'A' // A: 熔体温度 GOAL 向上(SP 增);B: 泵压 GOAL 向下(screw 减)
const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const api = async (m, u, b) => {
  const r = await fetch(B + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })
  return r.json()
}
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  appendFileSync(`tmp-e2e/expert-${scenario}.log`, line + '\n')
}

let approvedCount = 0
let rejectedCount = 0
const seen = new Set()
const deadline = Date.now() + 80 * 60_000

log(`=== 专家代理v2启动 scenario=${scenario} channel=${channelId.slice(0, 8)} 方向=${GOAL_UP ? '向上' : '向下'} ===`)

const injectDisturbance = async () => {
  const r = await fetch('http://localhost:4010/api/plant/config', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disturbances: { heaterDecay: 4, feedDriftPerMin: 0.4 } }),
  })
  const j = await r.json().catch(() => ({}))
  log(`⚙️ 工况注入: heaterDecay 1→4, feedDrift 0.15→0.4 (code=${r.status} ${JSON.stringify(j.data ?? j).slice(0, 120)})`)
}

// 从审批单提取参数变更行:[{from,to,basis,name}]
const extractChanges = (item) => {
  const pkgs = item.payload?.packages
  if (Array.isArray(pkgs) && pkgs.length > 0) {
    return (pkgs[0].params ?? []).map(p => ({ name: p.paramName ?? p.nodeId, from: p.from, to: p.to, basis: p.basis ?? '' }))
  }
  // 非整包(trial/update/rollback):从 detail 的「A→B℃/MPa/rpm」行提取
  const rows = []
  const detail = String(item.detail ?? '')
  for (const m of detail.matchAll(/([\u4e00-\u9fa5A-Za-z·()]+)\s(\d+(?:\.\d+)?)→(\d+(?:\.\d+)?)(℃|MPa|rpm)/g)) {
    rows.push({ name: m[1], from: Number(m[2]), to: Number(m[3]), basis: detail })
  }
  return rows
}

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 12_000))
  try {
    const pend = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`)
    const items = (pend.data?.items ?? []).filter(i => i.kind === 'dcw-approval' && !seen.has(i.id))
    for (const item of items) {
      seen.add(item.id)
      log('────────────────────────────────────')
      log(`🙋 审批单 ${item.id} title=${item.title ?? ''} node=${item.nodeId ?? ''}`)
      log(`📄 detail:\n${(item.detail ?? '').split('\n').map(l => '   ' + l).join('\n')}`)
      const pkgs = item.payload?.packages
      if (Array.isArray(pkgs)) {
        for (const [i, p] of pkgs.entries()) {
          log(`📦 方案${i + 1}「${p.name}」rationale=${p.rationale ?? ''}`)
          for (const par of (p.params ?? [])) {
            log(`   · ${par.paramName ?? par.nodeId} ${par.from ?? '?'}→${par.to}${par.unit ?? ''} | basis=${par.basis} | exp_ref=${par.exp_ref} | 预检=${par.preflight?.ok}`)
          }
        }
      }
      else if (item.payload) {
        log(`📦 payload: ${JSON.stringify(item.payload).slice(0, 400)}`)
      }

      const respond = (confirmed, comment) => api('POST', '/api/workshop/hitl/respond', {
        kind: 'dcw-approval', id: item.id, confirmed, ...(confirmed ? { choice: 0 } : {}), comment,
      })

      // ===== ⓪ 产线管理作业(line-start/line-stop):按测试计划预授权,核对理由后批准 =====
      const nodeIdStr = String(item.nodeId ?? '')
      if (nodeIdStr.startsWith('line-start:') || nodeIdStr.startsWith('line-stop:')) {
        approvedCount++
        const d = await respond(true, '管理作业按本次测试计划预授权:启停理由已核对(完工/检修/流程验证),批次窗口与数采联动语义已知悉,批准执行;执行后回报批次号与打标样本数。')
        log(`✅ 产线管理批准#${approvedCount}(${nodeIdStr.split(':')[0]}) respond code=${d.code}`)
        continue
      }

      // ===== ① 方向校验 =====
      const changes = extractChanges(item)
      const moving = changes.filter(c => Number.isFinite(c.to) && Number.isFinite(c.from) && c.to !== c.from)
      const wrongDir = moving.filter(c => GOAL_UP ? c.to < c.from : c.to > c.from)
      if (moving.length > 0 && wrongDir.length === moving.length) {
        rejectedCount++
        const d = await respond(false, GOAL_UP
          ? '方向反了:任务 GOAL 是熔体温度 3min 均值 ≥202.5℃(当前实测约 199.6),必须向上调 SP;恢复配方 SP=190 的"一致性"是次要目标,任务优先级高于配方回归。请向上提案(先小步),并保留数据依据。'
          : '方向反了:任务 GOAL 是泵压 3min 均值 ≤15.8 MPa(当前约 16.7),必须向下调 screw;请向下提案并保留数据依据。')
        log(`🚫 拒绝#${rejectedCount}(方向反)respond code=${d.code}`)
        continue
      }

      // ===== ② 依据数值证据 =====
      const bases = Array.isArray(pkgs) && pkgs.length > 0
        ? (pkgs[0].params ?? []).map(x => String(x.basis ?? ''))
        : [String(item.detail ?? '')]
      const hasNumbers = bases.length > 0 && bases.every(b => /(均值|实测|读回|min|max|std|n=)/.test(b) && /\d/.test(b))
      if (!hasNumbers) {
        rejectedCount++
        const d = await respond(false, '依据里没有可核查的测量证据(点位/时间窗/均值数值),产线专家无法核对你的判断链;请补齐后重提。')
        log(`🚫 拒绝#${rejectedCount}(依据无数值)respond code=${d.code}`)
        continue
      }

      // ===== ③ 场景A 第2次批准前注入工况恶化 =====
      if (approvedCount === 1 && scenario === 'A') await injectDisturbance()

      // ===== ④ 批准 =====
      approvedCount++
      const comment = scenario === 'A' && approvedCount === 2
        ? '工况已切换:加热器老化加剧+进料漂移加大(我已在模拟器调整),按新工况评估;批准执行,注意观察数据并如实报告。'
        : '依据链清晰(点位/时间窗/数值可核对),方向正确,批准执行;执行后按规程等惯性收敛再复测。'
      const d = await respond(true, comment)
      log(`✅ 批准#${approvedCount} respond code=${d.code}`)
    }

    // 任务终态检测
    const st = await api('GET', `/api/workshop/channels/${channelId}/tasks`)
    const tasks = st.data?.items ?? st.data ?? []
    const mine = tasks.filter(t => ['WATCH-NONE'].includes(t.id))
    const active = mine.filter(t => !['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(t.state))
    if (mine.length > 0 && active.length === 0) {
      log(`=== 本场景任务终态(${mine.map(t => t.state).join(',')}),专家代理退出 ===`)
      break
    }
  }
  catch (e) {
    log('轮询异常: ' + e.message)
  }
}
log(`=== 结束统计: 批准${approvedCount} 拒绝${rejectedCount} ===`)
