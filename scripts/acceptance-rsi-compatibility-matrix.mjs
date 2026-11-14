#!/usr/bin/env node
/**
 * RSI Beta 真实兼容矩阵(PR-G,2026-11-14) —— off/on 两相隔离实例。
 *
 * 链路:Workspace → Channel(绑线)→ Worker → Session/Project → Recipe/DAQ
 *       → HITL(line_start 审批)→ DCW ACK/回读 → RSI Beta 只读运行证据。
 *
 * 诚实边界:
 *  - 隔离 AW_HOME + mock 驱动;不是物理 HIL,不证明真实工艺响应;
 *  - 共享模拟器 :4010 不是本脚本目标;
 *  - Mimosa 扫描不构成本轮安全结论;本脚本只证明平台链路接线与治理。
 *
 * 运行:
 *   node scripts/acceptance-rsi-compatibility-matrix.mjs
 * 产物:
 *   docs/audit/evidence/2026-11-14-rsi-compatibility-matrix/report.json
 *   docs/audit/evidence/2026-11-14-rsi-compatibility-matrix/*.png
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-rsi-matrix')
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
const EVIDENCE = join(REPO, 'docs', 'audit', 'evidence', '2026-11-14-rsi-compatibility-matrix')
mkdirSync(EVIDENCE, { recursive: true })
const TAG = `mx${Date.now().toString(36).slice(-5)}`
const ADMIN = { name: `矩阵管理员-${TAG}`, email: `matrix-${TAG}@awshop.local`, password: 'Matrix#2026-e2e' }
const SESSION_PASSWORD = 'RsiMatrix#2026-session-key'
const checks = []
const ok = (id, name, cond, detail = '') => {
  checks.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const candidate of [3897, 3896, 3895, 3894]) {
  try {
    const res = await fetch(`http://127.0.0.1:${candidate}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (res.ok) continue
  }
  catch { /* 端口空闲 */ }
  port = candidate
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'

const logFd = openSync(join(ROOT, 'server.log'), 'a')
let child = null
let token = ''

async function api(method, path, body, auth = token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON(404 页面等) */ }
  return { status: res.status, ...(json ?? {}) }
}
const payloadOf = response => response?.data
const textOf = value => String(value ?? '')

async function stopServer() {
  if (!child) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  child = null
  await sleep(1500)
}

async function startServer(phase, flags) {
  const env = {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: HOME,
    HOST: '127.0.0.1',
    AW_RATE_LIMIT_OFF: '1',
    NUXT_SESSION_PASSWORD: SESSION_PASSWORD,
    NO_PROXY: '127.0.0.1,localhost',
    AW_RSI_BETA_ENABLED: '0',
    AW_RSI_BETA_RESEARCH_ENABLED: '0',
    AW_RSI_BETA_UI_ENABLED: '0',
    ...flags,
  }
  child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
    cwd: REPO,
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(2000)
    try {
      const health = await api('GET', '/api/health', undefined, undefined, 3000)
      if (health?.data?.status === 'ok' && health?.data?.workshop === 'ready') {
        ok(`ENV-${phase.toUpperCase()}`, `${phase} 相隔离实例就绪`, true, `port=${port}`)
        return true
      }
    }
    catch { /* 未就绪 */ }
  }
  ok(`ENV-${phase.toUpperCase()}`, `${phase} 相隔离实例就绪`, false, '健康检查超时')
  return false
}

async function uiCheck(phase, expectation) {
  if (!process.env.AW_CHROME && process.platform === 'win32') process.env.AW_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  try {
    const { launch, openPage, gotoReady } = await import('./ui/lib.mjs')
    const browser = await launch({ width: 1440, height: 900 })
    try {
      const page = await openPage(browser, { token, dark: true, width: 1440, height: 900 })
      await gotoReady(page, '/plugins', { timeout: 180_000 })
      const panel = await page.$('.aw-rsi-beta')
      ok(`${phase}-UI1`, `${phase}: /plugins 面板可见性符合预期`, expectation.panel ? Boolean(panel) : !panel, panel ? 'panel present' : 'panel absent')
      if (panel) {
        const panelText = await panel.evaluate(el => el.innerText)
        ok(`${phase}-UI2`, `${phase}: 面板展示能力/边界`, /capabilit|能力/i.test(panelText) && /read.?only|只读/i.test(panelText), panelText.slice(0, 240).replace(/\s+/g, ' '))
        await page.screenshot({ path: join(EVIDENCE, `${phase}-plugins.png`) })
      }
      await gotoReady(page, '/daq', { timeout: 240_000 })
      const daqTitle = await page.evaluate(() => document.body.innerText.slice(0, 400))
      ok(`${phase}-UI3`, `${phase}: /daq 页面水合可用`, /数采|DAQ/i.test(daqTitle), daqTitle.replace(/\s+/g, ' ').slice(0, 160))
      await page.screenshot({ path: join(EVIDENCE, `${phase}-daq.png`) })
    }
    finally {
      await browser.close()
    }
  }
  catch (error) {
    ok(`${phase}-UI0`, `${phase}: 浏览器检查可执行`, false, error instanceof Error ? error.message : String(error))
  }
}

let failed
try {
  // ───────────────────────── Phase OFF ─────────────────────────
  if (await startServer('off', {})) {
    const registered = await api('POST', '/api/users/register', { ...ADMIN }, undefined, 60_000)
    token = payloadOf(registered)?.token
    ok('OFF-1', '隔离实例首管理员注册', Boolean(token), registered?.message ?? '')

    const offStatus = await api('GET', '/api/plugins/rsi-interface-beta/status')
    ok('OFF-2', 'feature-off:插件 status 路由不存在(404)', offStatus.status === 404, `status=${offStatus.status}`)
    const offMetadata = await api('GET', '/api/plugins/rsi-interface-beta/metadata')
    ok('OFF-3', 'feature-off:插件 metadata 路由不存在(404)', offMetadata.status === 404, `status=${offMetadata.status}`)
    const offResearch = await api('POST', '/api/plugins/rsi-interface-beta/research/run', {})
    ok('OFF-4', 'feature-off:research 路由不存在(404)', offResearch.status === 404, `status=${offResearch.status}`)
    const offLines = await api('GET', '/api/workshop/dcw/lines')
    ok('OFF-5', 'feature-off:既有产线 API 正常', offLines.status === 200, `status=${offLines.status}`)
    await uiCheck('off', { panel: false })
    await stopServer()
  }
  else {
    failed = true
  }

  // ───────────────────────── Phase ON ─────────────────────────
  if (await startServer('on', {
    AW_RSI_BETA_ENABLED: '1',
    AW_RSI_BETA_RESEARCH_ENABLED: '1',
    AW_RSI_BETA_UI_ENABLED: '1',
  })) {
    const login = await api('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password }, undefined, 60_000)
    token = payloadOf(login)?.token
    ok('ON-1', 'feature-on:管理员登录(同一隔离 home)', Boolean(token), login?.message ?? '')

    const workspace = payloadOf(await api('POST', '/api/workshop/workspaces', { name: `矩阵工作区-${TAG}` }))
    const workspaceId = workspace?.id
    const channel = payloadOf(await api('POST', '/api/workshop/channels', {
      name: `矩阵频道-${TAG}`,
      leadAgent: { name: `矩阵lead-${TAG}`, harness: 'mock' },
    }))
    const channelId = channel?.channelId
    const leadId = channel?.leadAgentId
    const mount = await api('POST', `/api/workshop/workspaces/${workspaceId}/channels/${channelId}`)
    const worker = payloadOf(await api('POST', `/api/workshop/channels/${channelId}/agents`, {
      name: `矩阵worker-${TAG}`,
      harness: 'mock',
      role: 'worker',
    }))
    const workerId = worker?.id
    ok('ON-2', 'Workspace/Channel/Worker 创建并挂载', Boolean(workspaceId && channelId && workerId && mount.status === 200),
      JSON.stringify({ workspaceId, channelId, leadId, workerId, mount: mount.status }).slice(0, 260))

    const line = payloadOf(await api('POST', '/api/workshop/dcw/lines', { name: `矩阵产线-${TAG}` }))?.line
    const lineId = line?.id
    const template = payloadOf(await api('POST', '/api/workshop/dcw/templates', {
      name: `矩阵温度-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 100, decimals: 1,
    }))?.template
    const dcwNode = payloadOf(await api('POST', '/api/workshop/dcw', {
      templateRef: template?.key,
      name: `矩阵数控-${TAG}`,
      driver: 'mock',
      lineId,
      stepLimit: 20,
      driverConfig: { key: `mx-dcw-${TAG}` },
    }))?.node
    const product = payloadOf(await api('POST', '/api/workshop/dcw/products', { lineId, name: `矩阵产品-${TAG}` }))?.product
    const recipe = payloadOf(await api('POST', '/api/workshop/dcw/recipes', {
      productId: product?.id,
      name: `矩阵配方-${TAG}`,
      params: [{ nodeId: dcwNode?.id, value: 80, min: 0, max: 100 }],
    }))?.recipe
    const daqNode = payloadOf(await api('POST', '/api/workshop/daq', {
      templateRef: 'daq-temp-tc',
      name: `矩阵数采-${TAG}`,
      driver: 'mock',
      lineId,
      intervalMs: 1000,
      publishIntervalMs: 0,
    }))?.node
    const bindLine = await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId })
    const controller = await api('POST', '/api/workshop/dcw/controller', { action: 'start' })
    ok('ON-3', 'Recipe/DAQ/绑线/控制网关就绪',
      Boolean(lineId && dcwNode?.id && product?.id && recipe?.id && daqNode?.id && bindLine.status === 200 && controller.status === 200),
      JSON.stringify({ lineId, dcw: dcwNode?.id, recipe: recipe?.id, daq: daqNode?.id, bind: bindLine.status, ctrl: controller.status }).slice(0, 300))

    const session = payloadOf(await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: `矩阵会话-${TAG}` }))
    const project = payloadOf(await api('POST', '/api/workshop/projects', {
      name: `矩阵项目-${TAG}`,
      objective: '验证 Workspace→Channel→Worker→Session/Project→Recipe/DAQ→HITL→DCW→RSI 只读证据链',
      successCriteria: ['HITL 批准后线开跑', 'RSI 只读证据含 DCW 回读与写审计'],
      mode: 'supervised',
      leaderHarness: 'mock',
    }))
    ok('ON-4', 'Session/Project 上下文创建', Boolean(session?.sessionId || session?.id) && Boolean(project?.id),
      JSON.stringify({ session: session?.sessionId ?? session?.id, project: project?.id }).slice(0, 200))

    // HITL:line_start 审批 → 开线 → 设备证实
    const pendingIds = async () => new Set((await api('GET', '/api/workshop/hitl/pending')).data?.items?.map(item => item.id) ?? [])
    const waitCard = async (known) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(1000)
        const items = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
        const card = items.find(item => !known.has(item.id) && String(item.nodeId ?? '').startsWith(`line-start:${lineId}`))
        if (card) return card
      }
      return null
    }
    const known = await pendingIds()
    const startPromise = api('POST', '/api/workshop/agent-tools/invoke', {
      agentId: leadId,
      tool: 'line_start',
      args: { recipe_id: recipe?.id, reason: `矩阵验收开线-${TAG}` },
    })
    const card = await waitCard(known)
    ok('ON-5', 'HITL:line_start 生成审批卡', Boolean(card), card?.id ?? '未出现')
    if (card) {
      const decision = await api('POST', '/api/workshop/hitl/respond', {
        kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '矩阵验收批准',
      })
      ok('ON-6', 'HITL:审批提交成功', decision.status === 200, JSON.stringify(decision).slice(0, 200))
    }
    const startResult = await Promise.race([startPromise, sleep(90_000).then(() => ({ timeout: true }))])
    const startText = textOf(startResult?.data?.result?.text ?? startResult?.data?.text)
    const startError = Boolean(startResult?.data?.result?.isError ?? startResult?.data?.isError)
    ok('ON-7', 'HITL 批准后开线成功且参数设备证实', !startError && /已开跑/.test(startText) && /设备证实/.test(startText), startText.slice(0, 260))
    const history = await api('GET', `/api/workshop/hitl/history?channelId=${channelId}&limit=20`)
    const historyRows = history?.data?.rows ?? []
    const approvedCard = historyRows.find(item => card && item.id === card.id)
    ok('ON-8', 'HITL 终态留痕(approved)', approvedCard?.status === 'approved',
      JSON.stringify(approvedCard ?? {}).slice(0, 240))

    // RSI Beta:精确宿主 scope
    const scopeQuery = `workspaceId=${encodeURIComponent(workspaceId)}&channelId=${encodeURIComponent(channelId)}&workerId=${encodeURIComponent(workerId)}`
    const betaStatus = await api('GET', `/api/plugins/rsi-interface-beta/status?${scopeQuery}`)
    ok('ON-9', 'RSI Beta status 在宿主 scope 下 ready', betaStatus?.ok === true && betaStatus?.code === 'READY', JSON.stringify(betaStatus).slice(0, 260))
    const metadataUnbound = await api('GET', '/api/plugins/rsi-interface-beta/metadata')
    ok('ON-10', '无 kv 预置时 metadata 不再是永久 default-deny', metadataUnbound?.code === 'SCOPE_UNBOUND' && metadataUnbound?.visible === true,
      JSON.stringify(metadataUnbound).slice(0, 220))
    const metadataScoped = await api('GET', `/api/plugins/rsi-interface-beta/metadata?${scopeQuery}`)
    ok('ON-11', 'metadata 随精确 scope 转 ready 且能力真相可见',
      metadataScoped?.status === 'ready' && Array.isArray(metadataScoped?.capabilities) && metadataScoped.capabilities.includes('observe')
      && !metadataScoped.capabilities.includes('simulate') && !metadataScoped.capabilities.includes('replay') && !metadataScoped.capabilities.includes('verify'),
      JSON.stringify(metadataScoped?.capabilities ?? []).slice(0, 160))
    const metadataForeign = await api('GET', `/api/plugins/rsi-interface-beta/metadata?workspaceId=${encodeURIComponent(workspaceId)}&channelId=${encodeURIComponent(channelId)}&workerId=foreign-worker`)
    ok('ON-19', 'metadata 显式 foreign scope 报 SCOPE_FORBIDDEN 且不可见',
      metadataForeign?.visible === false && metadataForeign?.code === 'SCOPE_FORBIDDEN',
      JSON.stringify(metadataForeign).slice(0, 260))

    await sleep(2500)
    const window = { fromMs: Date.now() - 10 * 60_000, toMs: Date.now(), bucketMs: 1000, limit: 100 }
    const operational = await api('POST', '/api/plugins/rsi-interface-beta/evidence/operational?'.concat(scopeQuery), {
      lineId,
      window,
      history: true,
      tagged: true,
      frames: true,
      writeAudit: { limit: 10 },
    })
    const evidence = operational?.evidence
    const dcwEvidence = (evidence?.dcw ?? []).find(item => item.nodeId === dcwNode?.id)
    const daqEvidence = (evidence?.daq ?? []).find(item => item.nodeId === daqNode?.id)
    ok('ON-12', 'operational evidence:只读边界与来源哈希',
      operational?.ok === true && evidence?.readOnly === true && evidence?.writeCount === 0 && /^[a-f0-9]{64}$/.test(String(evidence?.source?.contentHash ?? ''))
      && evidence?.source?.writeAuditAvailable !== false,
      JSON.stringify({ ok: operational?.ok, code: operational?.code, readOnly: evidence?.readOnly, writeCount: evidence?.writeCount, auditAvailable: evidence?.source?.writeAuditAvailable }).slice(0, 260))
    ok('ON-13', 'operational evidence:DCW 回读/ACK/写审计可达',
      Boolean(dcwEvidence)
      && typeof dcwEvidence?.readValue === 'number' && Number.isFinite(dcwEvidence.readValue)
      && Array.isArray(dcwEvidence?.writeAudit) && dcwEvidence.writeAudit.length > 0
      && dcwEvidence.writeAudit.some(row => Boolean(row?.ack) || row?.actualValue != null),
      JSON.stringify(dcwEvidence ?? {}).slice(0, 320))
    ok('ON-14', 'operational evidence:DAQ latest 新鲜度可判定', Boolean(daqEvidence) && ['fresh', 'stale', 'missing'].includes(String(daqEvidence?.latest?.freshness)),
      JSON.stringify(daqEvidence?.latest ?? {}).slice(0, 200))
    const auditPaths = new Set((dcwEvidence?.writeAudit ?? []).map(row => row.path))
    ok('ON-15', '写审计保留来源路径(recipe/agent/manual)', auditPaths.size > 0 && [...auditPaths].every(path => ['recipe', 'agent', 'manual', 'rollback'].includes(String(path))),
      JSON.stringify([...auditPaths]))

    // Research 只读执行(observe step)+ 写能力拒绝
    const researchScope = { workspaceId, channelId, workerId }
    const research = await api('POST', '/api/plugins/rsi-interface-beta/research/run', {
      id: `matrix-run-${TAG}`,
      idempotencyKey: `matrix-key-${TAG}`,
      objective: '读取运行证据',
      question: '当前线是否已开跑且回读一致?',
      subjectRefs: [{ namespace: 'industrial.line', id: lineId }],
      scope: researchScope,
      industrial: true,
      plan: {
        id: `matrix-plan-${TAG}`,
        steps: [{ id: 'observe-1', adapterId: 'rsi-interface-beta', capability: 'observe', payload: { lineId }, sourceRef: `industrial.read:${lineId}` }],
      },
      execute: true,
    })
    ok('ON-16', 'research:只读 observe 计划可执行并产出候选证据', research?.ok === true && research?.run?.state === 'completed' && (research?.run?.evidenceIds ?? []).length > 0,
      JSON.stringify(research).slice(0, 400))
    const actuation = await api('POST', '/api/plugins/rsi-interface-beta/research/run', {
      id: `matrix-act-${TAG}`,
      idempotencyKey: `matrix-act-key-${TAG}`,
      objective: '越界测试',
      question: '能不能写?',
      subjectRefs: [{ namespace: 'industrial.line', id: lineId }],
      scope: researchScope,
      plan: { id: 'act-plan', steps: [{ id: 'act-1', adapterId: 'rsi-interface-beta', capability: 'actuate', payload: {}, sourceRef: 'matrix:actuate' }] },
      execute: true,
    })
    ok('ON-17', 'research:actuate 能力被拒(只读边界)', actuation?.ok === false && /READ_ONLY|ACTUATE/.test(String(actuation?.code)), JSON.stringify(actuation).slice(0, 220))
    const foreign = await api('GET', `/api/plugins/rsi-interface-beta/status?workspaceId=${encodeURIComponent(workspaceId)}&channelId=${encodeURIComponent(channelId)}&workerId=foreign-worker`)
    ok('ON-18', 'foreign worker scope 被拒', foreign?.ok === false && String(foreign?.code ?? '').includes('SCOPE'), JSON.stringify(foreign).slice(0, 220))

    await uiCheck('on', { panel: true })

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
    const report = {
      manifestVersion: 'rsi-compatibility-matrix.v1',
      recordedAt: new Date().toISOString(),
      head,
      branch: spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
      environment: {
        mode: 'isolated AW_HOME',
        drivers: 'mock (DCW/DAQ) — not physical hardware',
        simulator: 'none; shared :4010 not used',
        physicalHil: 'NOT RUN',
        security: 'Mimosa not run/not a pass for this script; no security claim',
      },
      ids: { workspaceId, channelId, leadId, workerId, lineId, dcwNodeId: dcwNode?.id, daqNodeId: daqNode?.id, recipeId: recipe?.id, sessionId: session?.sessionId ?? session?.id, projectId: project?.id },
      checks,
      summary: {
        total: checks.length,
        pass: checks.filter(check => check.pass).length,
        fail: checks.filter(check => !check.pass).length,
      },
    }
    writeFileSync(join(EVIDENCE, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\n[矩阵] ${report.summary.pass}/${report.summary.total} PASS → ${join(EVIDENCE, 'report.json')}`)
    failed = report.summary.fail > 0
  }
  else {
    failed = true
  }
}
catch (error) {
  console.error('矩阵执行失败:', error)
  failed = true
}
finally {
  await stopServer()
}
process.exit(failed ? 1 : 0)
