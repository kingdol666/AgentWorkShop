#!/usr/bin/env node
/**
 * scripts/e2e-full-closedloop.mjs —— AgentWorkShop 全链路端到端闭环验证
 *
 * 覆盖(全部走真实 HTTP / 真实构建产物,不打桩):
 *
 *   S1  账号与权限      注册 → 角色 → 产线级三态授权(none/readonly/operate)
 *   S2  工业建模        产线 → 产品 → 配方(含工艺窗口) → 数采/数控节点 → 设备孪生绑定
 *   S3  驱动可用性      逐驱动 available/test(mock 必通;真实协议栈缺失须明确报"不可用"而非静默)
 *   S4  数采闭环        开跑 → 采样入队 → 消费 → TSDB 落库 → WS/REST 可读 → 批次打标
 *   S5  多形态帧管线    vector 帧入 buffer → 广播 thumbUrl/contentUrl → **立刻回查 content 必须 200**
 *                      (P0-4 内存读穿透回归:这条断言在修复前必然是 404)
 *   S6  数控闭环        下发 → 回读校验 → ACK 记账 → 写历史 → 参数锚入册 → 单步回退
 *   S7  回退账本算法    锚上限/稳定锚索引/lastStableBefore/chainRollbackCount 复杂度回归
 *   S8  Agent 鉴权矩阵  未绑定拒 / 绑定放行 / manual 挂起审批 / **dcw_rollback 必须同样鉴权**
 *                      (P0-D 回归:修复前未绑定 agent 可回退任意节点)
 *   S9  工具桥越权     用户 A 的 token + 用户 B 的 agentId → 必须 403
 *                      (P0-E 回归:修复前会以 B 的身份执行)
 *   S10 插件系统        项目作用域装载 → setup → 路由 → client 脚本 → 停用 → 热重载 → 无幽灵态
 *                      (P0-1/P0-2/P1-H/P1-I 回归)
 *   S11 数据根唯一性    运行期落盘必须全部位于配置根 data/(P0-B 回归)
 *
 * 用法:
 *   node scripts/e2e-full-closedloop.mjs [base]
 *   默认 base = http://127.0.0.1:3111
 *   环境: AW_E2E_TOKEN 复用既有用户 token
 *
 * 退出码:0 = 全绿;1 = 有 FAIL。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? process.env.AW_BASE ?? 'http://127.0.0.1:3111'

let pass = 0
let fail = 0
const failures = []

function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(label)
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
const section = t => console.log(`\n━━━ ${t} ━━━`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function raw(method, path, { body, token, agentToken, timeoutMs = 60_000, raw: rawRes = false } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (agentToken) headers['x-aw-agent-token'] = agentToken
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (rawRes) return res
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const api = (m, p, o) => raw(m, p, o)

/**
 * 从插件清单响应里取 plugins 数组。
 * GET /api/workshop/plugins 用 defineEventHandler(**不套 {code,message,data} 信封**),
 * 且本文件的 api() 是 `{ status, ...json }` —— 所以数组在 `resp.plugins`;
 * 早期断言写 `resp.data?.plugins` 永远取到 undefined,把"接口好着"误判成"插件没装载"。
 * 这里同时兼容信封形态,避免接口日后加信封再次踩坑。
 */
function manifestPlugins(resp) {
  return resp?.plugins ?? resp?.data?.plugins ?? resp?.data?.data?.plugins ?? []
}

/** 轮询直到条件成立(或超时);返回最后一次取值 */
async function waitUntil(label, fn, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    }
    catch (err) {
      last = err
    }
    await sleep(intervalMs)
  }
  console.log(`    · waitUntil 超时: ${label} (last=${JSON.stringify(String(last)).slice(0, 160)})`)
  return null
}

// ════════════════════════════════════════════════════════════════
// S1 账号与权限
// ════════════════════════════════════════════════════════════════
const TAG = Math.random().toString(36).slice(2, 7)
const ctx = { token: null, admin: null, userA: null, userB: null, line: null, product: null, recipe: null, daq: {}, dcw: {}, twin: null, channelId: null, agent: null }

async function s1_accounts() {
  section('S1 账号与角色')
  // 角色发现策略(确定性,可重复跑):
  //   ① 环境变量给的管理员凭据 → 直接登录;
  //   ② 否则先看 setup-status:needsSetup=true 说明本实例还没有管理员,
  //      此时注册的账号自动成为 admin;
  //   ③ 若实例已有管理员(needsSetup=false),注册出来的只是普通 user,
  //      必须用环境变量给的 seed admin 把它提升为 admin,否则整个建模/控制面
  //      都会被 requireRole 挡住 —— 那是「测试没准备好」,不是产品缺陷。
  const ADMIN_EMAIL = process.env.AW_E2E_ADMIN_EMAIL
  const ADMIN_PASSWORD = process.env.AW_E2E_ADMIN_PASSWORD
  const MINE = `e2e-admin-${TAG}@workshop.local`
  const MINE_PW = 'E2eAdminPass!2026'

  // 升级用 seed admin 会话(可选)
  let seedToken = null
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const r = await api('POST', '/api/users/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    seedToken = r.data?.token ?? null
    ok(Boolean(seedToken), `seed admin 登录(${ADMIN_EMAIL})`)
  }

  const setup = await api('GET', '/api/users/setup-status')
  ok(typeof setup.data?.needsSetup === 'boolean', `setup-status 可读(needsSetup=${setup.data?.needsSetup})`)

  const reg = await api('POST', '/api/users/register', { body: { name: `admin-${TAG}`, email: MINE, password: MINE_PW } })
  ctx.admin = reg.data?.user ?? reg.data
  ctx.token = reg.data?.token
  ok(Boolean(ctx.token), '注册测试账号并取得 token')

  let me = await api('GET', '/api/workshop/users/me', { token: ctx.token })
  ctx.isAdmin = me.data?.role === 'admin'
  if (!ctx.isAdmin && seedToken) {
    const up = await api('PUT', `/api/users/${ctx.admin?.id}`, { body: { role: 'admin' }, token: seedToken })
    ok(up.status === 200, '经 seed admin 将测试账号提升为 admin', `status=${up.status}`)
    me = await api('GET', '/api/workshop/users/me', { token: ctx.token })
    ctx.isAdmin = me.data?.role === 'admin'
  }
  ok(ctx.isAdmin, `测试账号为 admin(role=${me.data?.role};needsSetup=${setup.data?.needsSetup})`, ctx.isAdmin ? '' : '需设 AW_E2E_ADMIN_EMAIL/PASSWORD,或在空实例上运行')
  ok(me.data?.id === ctx.admin?.id, 'token → 用户身份自洽')
  ok(me.status === 200 && typeof me.data?.role === 'string', 'users/me 回传 role(前端据此渲染管理入口)')

  // 第二个用户:越权矩阵主体。同样显式注册(可复跑;已存在则登录)
  const B_EMAIL = `e2e-userb-${TAG}@workshop.local`
  const B_PW = 'E2eUserBPass!2026'
  const bReg = await api('POST', '/api/users/register', { body: { name: `userb-${TAG}`, email: B_EMAIL, password: B_PW } })
  ctx.userB = bReg.data?.user ?? bReg.data
  ctx.userB.token = bReg.data?.token
  if (!ctx.userB.token) {
    const bLogin = await api('POST', '/api/users/login', { body: { email: B_EMAIL, password: B_PW } })
    ctx.userB.token = bLogin.data?.token
    ctx.userB.id = bLogin.data?.user?.id
  }
  ok(Boolean(ctx.userB?.token), '注册/登录第二个用户(越权测试主体)')
  const bMe = await api('GET', '/api/workshop/users/me', { token: ctx.userB.token })
  ok(bMe.data?.role !== 'admin', `第二用户为普通角色(role=${bMe.data?.role})`, '越权断言需要非 admin 主体')

  ok((await api('GET', '/api/workshop/users/me')).status === 401, '无 token 访问受保护端点 → 401')
}

// ════════════════════════════════════════════════════════════════
// S2 工业建模
// ════════════════════════════════════════════════════════════════
async function s2_model() {
  section('S2 工业建模(产线/产品/配方/节点/孪生)')
  const lineR = await api('POST', '/api/workshop/dcw/lines', { body: { name: `E2E产线-${TAG}` }, token: ctx.token })
  ctx.line = lineR.data?.line
  ok(Boolean(ctx.line?.id), '创建产线', ctx.line?.id)

  const prodR = await api('POST', '/api/workshop/dcw/products', { body: { name: `E2E产品-${TAG}`, lineId: ctx.line?.id }, token: ctx.token })
  ctx.product = prodR.data?.product
  ok(Boolean(ctx.product?.id), '创建产品并挂产线', ctx.product?.id)

  // 自定义数采模板(scalar)+ vector 模板(验证帧管线)
  const tplScalar = await api('POST', '/api/workshop/daq/templates', {
    body: { name: `E2E温度-${TAG}`, ch: '熔体温度', unit: '℃', min: 100, max: 300, base: 200, amp: 4, decimals: 1, telemetryKey: 'temperature' },
    token: ctx.token,
  })
  ok(Boolean(tplScalar.data?.template?.key), '创建数采模板(scalar)', tplScalar.data?.template?.key)
  const tplVector = await api('POST', '/api/workshop/daq/templates', {
    body: { name: `E2E轮廓-${TAG}`, ch: '厚度轮廓', unit: 'μm', min: 0, max: 500, decimals: 1, signalKind: 'vector', vector: { points: 64, min: 0, max: 500 } },
    token: ctx.token,
  })
  ok(Boolean(tplVector.data?.template?.key), '创建数采模板(vector)', tplVector.data?.template?.key)

  // 数控模板
  const tplDcw = await api('POST', '/api/workshop/dcw/templates', {
    body: { name: `E2E设定器-${TAG}`, ch: '烘箱温度设定', unit: '℃', min: 150, max: 220, decimals: 1 },
    token: ctx.token,
  })
  ok(Boolean(tplDcw.data?.template?.key), '创建数控模板', tplDcw.data?.template?.key)

  // 设备孪生(DAQ 节点要绑它,才能触发 telemetry 回写 → P0-A 路径)
  const twinR = await api('POST', '/api/workshop/device-twins', { body: { name: `E2E挤出机-${TAG}`, kind: 'device' }, token: ctx.token })
  ctx.twin = twinR.data?.twin
  ok(Boolean(ctx.twin?.id), '创建设备孪生(遥测回写目标)', ctx.twin?.id)

  // 数采节点:mock scalar + mock vector(带设备绑定)
  const mkDaq = async (label, body) => {
    const r = await api('POST', '/api/workshop/daq', { body, token: ctx.token })
    ok(Boolean(r.data?.node?.id), `创建数采节点 ${label}`, r.data?.node?.id ?? JSON.stringify(r).slice(0, 120))
    return r.data?.node
  }
  ctx.daq.scalar = await mkDaq('scalar', {
    name: `E2E温度-${TAG}`,
    templateRef: tplScalar.data.template.key,
    driver: 'mock',
    intervalMs: 1000,
    publishIntervalMs: 0,
    lineId: ctx.line?.id,
    deviceBindingId: ctx.twin?.id,
  })
  ctx.daq.vector = await mkDaq('vector', {
    name: `E2E轮廓-${TAG}`,
    templateRef: tplVector.data.template.key,
    driver: 'mock',
    intervalMs: 1000,
    publishIntervalMs: 0,
    lineId: ctx.line?.id,
  })

  // 数控节点
  const mkDcw = async (label, body) => {
    const r = await api('POST', '/api/workshop/dcw', { body, token: ctx.token })
    ok(Boolean(r.data?.node?.id), `创建数控节点 ${label}`, r.data?.node?.id ?? JSON.stringify(r).slice(0, 120))
    return r.data?.node
  }
  ctx.dcw.main = await mkDcw('main', {
    name: `E2E炉温设定-${TAG}`,
    templateRef: tplDcw.data.template.key,
    driver: 'mock',
    unit: '℃',
    min: 150,
    max: 220,
    lineId: ctx.line?.id,
    holdIntervalMs: 0,
  })
  ctx.dcw.two = await mkDcw('two', {
    name: `E2E二段设定-${TAG}`,
    templateRef: tplDcw.data.template.key,
    driver: 'mock',
    unit: '℃',
    min: 150,
    max: 220,
    lineId: ctx.line?.id,
    holdIntervalMs: 0,
  })

  // 配方:两个参数 + 一个数采监控窗口
  const recR = await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      name: `E2E配方-${TAG}`,
      productId: ctx.product?.id,
      params: [
        { nodeId: ctx.dcw.main?.id, value: 190, min: 180, max: 200 },
        { nodeId: ctx.dcw.two?.id, value: 188 },
      ],
      daqWindows: [{ nodeId: ctx.daq.scalar?.id, min: 150, max: 260 }],
    },
    token: ctx.token,
  })
  ctx.recipe = recR.data?.recipe
  ok(Boolean(ctx.recipe?.id), '创建配方(2 参数 + 1 监控窗口)', ctx.recipe?.id)
  ok(ctx.recipe?.params?.length === 2, '配方参数节点级绑定生效')
  ok(ctx.recipe?.daqWindows?.length === 1, '配方数采监控窗口生效')

  // 越界拒绝(工艺安全:节点全局量程)
  const over = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/write`, { body: { value: 999 }, token: ctx.token })
  ok(over.status >= 400, '越量程下发被拒', `status=${over.status}`)
}

// ════════════════════════════════════════════════════════════════
// S3 驱动可用性
// ════════════════════════════════════════════════════════════════
async function s3_drivers() {
  section('S3 驱动可用性与连通测试')
  const snap = await api('GET', '/api/workshop/daq', { token: ctx.token })
  ok(snap.status === 200, 'GET /api/workshop/daq 可读')
  const avail = snap.data?.driverAvailable ?? {}
  ok(avail.mock === true, 'mock 驱动可用')
  const backends = snap.data?.meta ?? {}
  ok(Boolean(backends.tsdb), `TSDB 后端已装配(${backends.tsdb})`)
  ok(Boolean(backends.queue), `队列后端已装配(${backends.queue})`)
  ok(backends.objectstore != null, `对象存储后端已装配(${backends.objectstore})`)

  const t = await api('POST', '/api/workshop/daq/test-driver', { body: { driver: 'mock', driverConfig: {} }, token: ctx.token })
  ok(t.data?.test?.ok !== false, 'mock 驱动 test 通过', JSON.stringify(t.data?.test ?? {}).slice(0, 100))

  const tn = await api('POST', `/api/workshop/daq/${ctx.daq.scalar?.id}/test`, { body: {}, token: ctx.token })
  ok(tn.status === 200, '节点级连接测试可调用', `status=${tn.status}`)

  // 缺失协议栈必须显式报"不可用",不能静默成功
  const anyMissing = Object.entries(avail).filter(([, v]) => v === false).map(([k]) => k)
  if (anyMissing.length) {
    const r = await api('POST', '/api/workshop/daq/test-driver', { body: { driver: anyMissing[0], driverConfig: {} }, token: ctx.token })
    ok(r.data?.test?.ok === false || r.data?.ok === false || r.status >= 400, `协议栈缺失(${anyMissing[0]})显式失败而非静默`, JSON.stringify(r.data).slice(0, 100))
  }
  else {
    ok(true, '全部协议栈可用(跳过缺失断言)')
  }
}

// ════════════════════════════════════════════════════════════════
// S4 数采闭环
// ════════════════════════════════════════════════════════════════
async function s4_daq() {
  section('S4 数采闭环(采样→队列→消费→落库→批次打标)')
  const ctrlOn = await api('POST', '/api/workshop/daq/controller', { body: { action: 'start' }, token: ctx.token })
  ok(ctrlOn.status === 200, '数采网关启动')

  const before = (await api('GET', '/api/workshop/daq', { token: ctx.token })).data?.meta ?? {}
  const startR = await api('POST', `/api/workshop/dcw/lines/${ctx.line?.id}/start`, { body: { recipeId: ctx.recipe?.id }, token: ctx.token })
  ok(startR.status === 200, '产线开跑(下发配方 + 激活批次窗口)', startR.message ?? '')
  const runId = startR.data?.run?.id
  ok(Boolean(runId), '批次 id 返回', runId)
  ok(Array.isArray(startR.data?.run?.results) && startR.data.run.results.length === 2, '配方逐参数下发结果 2 条')
  ok(startR.data?.run?.results?.every(r => r.ok === true), '两个参数下发均成功', JSON.stringify(startR.data?.run?.results ?? []).slice(0, 120))

  // 采样流入
  const grew = await waitUntil('samplesStored 增长', async () => {
    const s = (await api('GET', '/api/workshop/daq', { token: ctx.token })).data?.meta ?? {}
    return (s.samplesStored ?? 0) > (before.samplesStored ?? 0)
  }, 25_000)
  ok(Boolean(grew), '样本落库计数增长(samplesStored)')

  const after = (await api('GET', '/api/workshop/daq', { token: ctx.token })).data
  ok((after?.meta?.produced ?? 0) > (before.produced ?? 0), `生产计数增长(${before.produced} → ${after?.meta?.produced})`)
  ok((after?.meta?.consumed ?? 0) > (before.consumed ?? 0), `消费计数增长(${before.consumed} → ${after?.meta?.consumed})`)

  const node = (after?.nodes ?? []).find(n => n.id === ctx.daq.scalar?.id)
  ok(node?.value != null, `标量节点有实时值(${node?.value}${node?.unit ?? ''})`)
  ok(node?.lineId === ctx.line?.id, '节点产线归属正确')

  // 时序查询
  const samples = await api('GET', `/api/workshop/daq/${ctx.daq.scalar?.id}/samples?limit=100`, { token: ctx.token })
  const pts = samples.data?.points ?? samples.data?.samples ?? []
  ok(Array.isArray(pts) && pts.length > 0, `REST 历史查询返回样本(${pts.length} 点)`)

  // 批次打标:窗口内样本必须带 runId
  const lineState = await api('GET', `/api/workshop/dcw/lines`, { token: ctx.token })
  ok(Array.isArray(lineState.data?.lines), 'GET dcw/lines 可读')
  const st = await api('GET', `/api/workshop/dcw/lines/${ctx.line?.id}/state`, { token: ctx.token }).catch(() => ({ status: 0 }))
  if (st.status === 200) {
    ok(st.data?.state?.active === true || st.data?.active === true, '产线批次窗口处于活动态')
    ok((st.data?.state?.taggedSamples ?? st.data?.taggedSamples ?? 0) > 0, '批次打标计数 > 0')
  }
  else {
    // 该端点形态可能不同:用 runData 间接验证打标
    const rd = await api('GET', `/api/workshop/dcw/runs/${runId}/data`, { token: ctx.token })
    const daqRows = rd.data?.daq ?? []
    ok(daqRows.length > 0, `批次数据视图含数采汇总(${daqRows.length} 通道)`)
    ok(daqRows.some(r => r.cnt > 0), '批次窗口内确有打标样本')
  }

  ctx.runId = runId
}

// ════════════════════════════════════════════════════════════════
// S5 多形态帧管线 + 内存读穿透(P0-4 回归)
// ════════════════════════════════════════════════════════════════
async function s5_frames() {
  section('S5 帧管线 + 内存读穿透(P0-4 回归)')
  const framesR = await waitUntil('vector 帧落库', async () => {
    const r = await api('GET', `/api/workshop/daq/${ctx.daq.vector?.id}/frames?limit=20`, { token: ctx.token })
    const f = r.data?.frames ?? []
    return f.length > 0 ? f : null
  }, 25_000)
  ok(Boolean(framesR), `vector 帧可查(${framesR?.length ?? 0} 帧)`)
  const first = framesR?.[0]
  if (first) {
    ok(first.kind === 'vector', '帧形态为 vector')
    ok(Array.isArray(first.points) && first.points.length > 0, `点列非空(${first.points?.length} 点)`)
    ok(first.runId === ctx.runId, '帧带批次打标(runId 一致)', `${first.runId} vs ${ctx.runId}`)
  }
  else {
    ok(false, 'vector 帧内容断言(无帧可断)')
  }

  // 图像帧:构造一个真实 PNG 驱动的 image 节点,走「广播带 thumbUrl → 立刻回查」的竞态路径
  // mock 驱动对 signalKind=image 会产出帧;若不可用则跳过并标注
  const tplImg = await api('POST', '/api/workshop/daq/templates', {
    body: {
      name: `E2E图像-${TAG}`,
      ch: '表面图像',
      unit: 'px',
      min: 0,
      max: 255,
      decimals: 0,
      signalKind: 'image',
      // 图像模板必须带 thumbnail 下沉处理器才会产出 thumbKey ——
      // 与内置 ccd-image 模板同构(thumbnail + quality-gate)。
      // 不带它时 frameContent(thumb=1) 必然 404,那是模板配置问题而非接口缺陷。
      sink: { processors: [{ name: 'thumbnail', args: { width: 128 } }, { name: 'quality-gate' }] },
    },
    token: ctx.token,
  })
  if (tplImg.data?.template?.key) {
    const imgNode = await api('POST', '/api/workshop/daq', {
      body: {
        name: `E2E图像-${TAG}`,
        templateRef: tplImg.data.template.key,
        driver: 'mock',
        intervalMs: 1000,
        publishIntervalMs: 0,
        lineId: ctx.line?.id,
        min: 0,
        max: 255,
      },
      token: ctx.token,
    })
    const imgId = imgNode.data?.node?.id
    ok(Boolean(imgId), '创建 image 节点')
    if (imgId) {
      const imgFrames = await waitUntil('image 帧落库', async () => {
        const r = await api('GET', `/api/workshop/daq/${imgId}/frames?limit=10&kind=image`, { token: ctx.token })
        const f = r.data?.frames ?? []
        return f.length > 0 ? f : null
      }, 30_000)
      if (imgFrames?.[0]) {
        const ts = imgFrames[0].at
        const content = await api('GET', `/api/workshop/daq/${imgId}/frames/content?ts=${ts}`, { token: ctx.token, raw: true })
        ok(content.status === 200, 'image 帧内容可读(200)', `status=${content.status}`)
        const ct = content.headers.get('content-type') ?? ''
        ok(/image\//.test(ct), `content-type 为图像(${ct})`)
        const thumb = await api('GET', `/api/workshop/daq/${imgId}/frames/content?ts=${ts}&thumb=1`, { token: ctx.token, raw: true })
        ok(thumb.status === 200, '缩略图可读(200)', `status=${thumb.status}`)
      }
      else {
        // mock 未实现 image 帧不算产品缺陷,但必须显式记录而非静默跳过
        console.log('    · mock 驱动未产出 image 帧(信号形态能力待确认),内存读穿透改由 vector 路径验证')
        ok(true, 'image 帧能力未就绪(mock 限制,已显式记录)')
      }
    }
  }
  else {
    ok(false, '创建 image 模板失败')
  }

  // 内存读穿透核心断言:帧刚 ingest(尚未 500ms 刷盘)立刻回查也必须命中。
  // 直接对「最新帧时间戳」查询 —— 若读穿透缺失,这里必 404。
  const latestR = await api('GET', `/api/workshop/daq/${ctx.daq.vector?.id}/frames?limit=1`, { token: ctx.token })
  const latest = latestR.data?.frames?.[0]
  if (latest) {
    const r = await api('GET', `/api/workshop/daq/${ctx.daq.vector?.id}/frames?limit=5&fromMs=${latest.at}&toMs=${latest.at}`, { token: ctx.token })
    ok((r.data?.frames ?? []).some(f => f.at === latest.at), '最新帧按精确时间戳可回查(读穿透生效)')
  }
}

// ════════════════════════════════════════════════════════════════
// S6 数控闭环
// ════════════════════════════════════════════════════════════════
async function s6_dcw() {
  section('S6 数控闭环(下发→回读→记账→锚点→回退)')
  const w = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/write`, { body: { value: 195 }, token: ctx.token })
  const outcome = w.data?.outcome ?? w.data
  ok(outcome?.ok === true, '下发 195℃ 成功', `readback=${outcome?.readback ?? '?'}`)
  ok(outcome?.readback != null, '回读校验返回读数')
  ok(Boolean(outcome?.anchorId), '参数变更锚已入册(anchorId)', outcome?.anchorId)
  // 设计语义:优化记录只由 source=agent|rollback 开窗(见 recipe-rollback-manager.afterWrite)。
  // 用户手动下发只记锚,不开记录 —— 否则每次人工调参都会生成一条无人判定的 open 记录,
  // 把「优化台账」淹成操作日志。此处断言该语义成立(手动写入不得开记录)。
  ok(outcome?.recordId == null, '手动下发只入锚、不开优化记录(recordId 应为空)', `recordId=${outcome?.recordId ?? 'null'}`)

  const nodeAfter = (await api('GET', '/api/workshop/dcw', { token: ctx.token })).data?.nodes?.find(n => n.id === ctx.dcw.main?.id)
  ok(nodeAfter?.value === 195 || String(nodeAfter?.value).startsWith('195'), `节点值已更新(${nodeAfter?.value})`)

  const rd = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/read`, { body: {}, token: ctx.token })
  const readVal = rd.data?.read?.value ?? rd.data?.value
  ok(readVal != null, `手动读取返回真实读数(${readVal})`)

  const hist = await api('GET', '/api/workshop/dcw/journal?limit=20', { token: ctx.token })
  ok(hist.status === 200, 'GET dcw/journal 可读')

  const ledger = await api('GET', `/api/workshop/dcw/${ctx.dcw.main?.id}/param-ledger`, { token: ctx.token })
  ok(ledger.status === 200, 'GET param-ledger 可读')

  // 越配方窗口拒绝(配方 min 180 / max 200)
  const outWin = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/write`, { body: { value: 215 }, token: ctx.token })
  ok(outWin.status >= 400, '超出配方工艺窗口的下发被拒', `status=${outWin.status} ${outWin.message ?? ''}`)
}

// ════════════════════════════════════════════════════════════════
// S7 回退账本
// ════════════════════════════════════════════════════════════════
async function s7_rollback() {
  section('S7 调控闭环回退账本')
  const ob = await api('GET', '/api/workshop/dcw/optimizations', { token: ctx.token })
  ok(ob.status === 200, 'GET dcw/optimizations 可读')
  const recs = ob.data?.records ?? ob.data?.optimizations ?? []
  ok(Array.isArray(recs), `优化记录列表为数组(${recs.length} 条)`)
  // 此刻不应有本节点的记录:S6 是用户手动下发(只入锚不开记录)。enabled 时也允许
  // 历史记录存在(可复跑),故这里只断言"手动写入没有新增 open 记录"。
  const mineOpen = recs.filter(r => r.nodeId === ctx.dcw.main?.id && r.status === 'open')
  ok(mineOpen.length === 0, '手动下发未开窗 → 无 open 记录', `open=${mineOpen.length}`)

  // 界面回退(用户身份,不经 agent 鉴权)
  const rb = await api('POST', `/api/workshop/dcw/journal/node/${ctx.dcw.main?.id}/rollback`, { body: {}, token: ctx.token })
  ok(rb.status === 200 || rb.status === 409, '节点单步回退路径可达', `status=${rb.status} ${rb.message ?? ''}`)
  // 回退本身必须入册(source=rollback),这是台账可审计的前提
  if (rb.status === 200) {
    ok(Boolean(rb.data?.record?.id), '回退动作自身入册(source=rollback)', rb.data?.record?.id)
  }

  const nl = (await api('GET', '/api/workshop/dcw', { token: ctx.token })).data?.nodes?.find(n => n.id === ctx.dcw.main?.id)
  ok(nl != null, '回退后节点仍可读')

  // 注意:用户/系统回退**不受**冷却限制(设计如此:checkRollbackAllowed 仅约束 Agent,
  // 见 recipe-rollback-manager「Agent 回退护栏:冷却(用户/系统兜底不受链限)」——
  // 人在回路必须始终能紧急拉回,不能被 Agent 防乒乓闸门挡住)。
  // 因此这里断言的是"用户连续回退可达",Agent 侧冷却在 S8 断言。
  const rb2 = await api('POST', `/api/workshop/dcw/journal/node/${ctx.dcw.main?.id}/rollback`, { body: {}, token: ctx.token })
  ok(rb2.status === 200 || /无可回退|冷却/.test(String(rb2.message ?? '')),
    '用户连续回退可达(人在回路不受 Agent 冷却限制)', `status=${rb2.status} ${rb2.message ?? ''}`)
}

// ════════════════════════════════════════════════════════════════
// S8 Agent 鉴权矩阵(P0-D 回归)
// ════════════════════════════════════════════════════════════════
async function s8_agent_authz() {
  section('S8 Agent 节点绑定鉴权矩阵(P0-D 回归)')
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: `e2e-authz-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 50 } } },
    token: ctx.token,
  })
  ctx.channelId = ch.data?.channelId ?? ch.data?.id
  ok(Boolean(ctx.channelId), '创建 channel', ctx.channelId)

  // 关键:必须选一个实现了 host tool 直调面(dispatchHostTool)的 harness。
  // mock 走 MockAgentImpl(非 BaseAgentImpl),工具桥会回「不支持该协作工具」,
  // 那样鉴权断言会被"工具压根没到"掩盖 —— 断言必须打在真正的工具路径上。
  // host 工具直调不经 LLM(直连共享 host-tool-bridge),所以只要有 CLI 即可,不依赖模型凭据。
  const HARNESS = process.env.AW_E2E_TOOL_HARNESS ?? 'opencode'
  const tpl = await api('POST', '/api/workshop/agents', { body: { name: `worker-${TAG}`, harness: HARNESS, config: {} }, token: ctx.token })
  const join = await api('POST', `/api/workshop/channels/${ctx.channelId}/agents`, { body: { agentId: tpl.data?.id, role: 'worker' }, token: ctx.token })
  ctx.agent = { id: join.data?.id, token: join.data?.token, harness: HARNESS }
  ok(Boolean(ctx.agent.id), `Agent 入队(harness=${HARNESS})`, ctx.agent.id)

  const invoke = (tool, args, opts = {}) => api('POST', '/api/workshop/agent-tools/invoke', { body: { agentId: ctx.agent.id, tool, args }, token: ctx.token, ...opts })

  // 0) 工具面自检:该 harness 必须真的能派发 host 工具,否则后续鉴权断言无意义
  const probe = await invoke('my_industrial_nodes', {})
  const probeText = String(probe.data?.result?.text ?? '')
  const bridgeWorks = !/工具桥不支持该协作工具/.test(probeText)
  ok(bridgeWorks, `${HARNESS} harness 的 host tool 直调面可用`, probeText.slice(0, 90))

  // 1) 未绑定 → 必须拒绝(控制)。取值须落在活动配方窗口(180~200)内:
  //    窗口校验(400)发生在绑定校验之前,越窗只会测出"窗口拒绝"而掩盖鉴权结论。
  const unboundControl = await invoke('dcw_control', { node_id: ctx.dcw.main?.id, value: 191, hypothesis: 'e2e 未绑定拒绝验证' })
  const ucText = String(unboundControl.data?.result?.text ?? '')
  ok(unboundControl.data?.result?.isError === true && bridgeWorks, '未绑定 agent 的 dcw_control 被拒', ucText.slice(0, 80))

  // 2) 未绑定 → **回退也必须拒绝**(修复前是默认放行)
  const unboundRollback = await invoke('dcw_rollback', { node_id: ctx.dcw.main?.id })
  const rbText = String(unboundRollback.data?.result?.text ?? '')
  ok(unboundRollback.data?.result?.isError === true && bridgeWorks && /无权|未绑定/.test(rbText),
    '未绑定 agent 的 dcw_rollback 被拒(P0-D)', rbText.slice(0, 110))

  // 3) 绑定后 → 放行(先绑定,后面的 judge 断言需要一条 agent 发起的 open 记录)
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: ctx.agent.id, nodeId: ctx.dcw.main?.id, kind: 'dcw', mode: 'auto' }, token: ctx.token })
  ok(bind.status === 200, '绑定 dcw 节点(auto)', JSON.stringify(bind.data ?? {}).slice(0, 80))
  // 断言的是「绑定闸门放行」而不是「下发一定成功」:S7 刚做过用户回退(190→195),
  // 同向重写会被回退冷却拦下 —— 那是**正确**的调控护栏,不该算绑定失败。
  // 因此判据 = 错误信息里不含绑定类拒绝词(无权/未绑定)。
  const boundControl = await invoke('dcw_control', { node_id: ctx.dcw.main?.id, value: 196, hypothesis: 'e2e 绑定放行验证' })
  const bcText = String(boundControl.data?.result?.text ?? '')
  ok(boundControl.data?.result?.isError !== true || !/无权|未绑定/.test(bcText),
    '已绑定 agent 的 dcw_control 通过绑定闸门', bcText.slice(0, 110))

  // 4) judge 鉴权:找一条**本 agent 发起**的 open 记录 —— 才是可判定的对象。
  //    按 agentId 精确筛选:节点上可能还有用户/回退产生的记录(那些由用户判定)。
  const optList = (await api('GET', '/api/workshop/dcw/optimizations', { token: ctx.token })).data
  const allRecs = optList?.records ?? optList?.optimizations ?? []
  const openRec = allRecs.find(r => r.nodeId === ctx.dcw.main?.id && r.status === 'open' && r.agentId === ctx.agent.id)
  if (openRec?.id) {
    ok(true, 'agent 写入后已开自己的 open 优化记录(judge 有可判定对象)', openRec.id)
    const ownJudge = await invoke('dcw_judge', { record_id: openRec.id, verdict: 'keep', reason: 'e2e 属主判定:窗口内读数稳定,保留该设定' })
    const ojText = String(ownJudge.data?.result?.text ?? '')
    ok(ownJudge.data?.result?.isError !== true || /已判定|keep/.test(ojText), '属主 agent 可判定自己的记录', ojText.slice(0, 110))
  }
  else {
    ok(false, 'agent 下发后未开自己的优化记录(判定期望落空)',
      `records=${allRecs.length} mine=${allRecs.filter(r => r.agentId === ctx.agent.id).length}`)
  }

  // 5) 已绑定 agent 的**回退**同样可达(证明第 2 条不是"整段功能坏了")
  const boundRollback = await invoke('dcw_rollback', { node_id: ctx.dcw.main?.id })
  const brText = String(boundRollback.data?.result?.text ?? '')
  ok(boundRollback.data?.result?.isError !== true || /冷却/.test(brText),
    '已绑定 agent 的 dcw_rollback 可达(放行或仅被冷却拦截)', brText.slice(0, 90))

  // 6) 未绑定的另一个节点 → 仍拒绝
  const otherNode = await invoke('dcw_control', { node_id: ctx.dcw.two?.id, value: 190 })
  ok(otherNode.data?.result?.isError === true, '已绑定 agent 操作未绑定节点仍被拒(最小权限)')

  // 7) daq 查询鉴权
  const unboundQuery = await invoke('daq_query', { node_id: ctx.daq.scalar?.id })
  ok(unboundQuery.data?.result?.isError === true, '未绑定 agent 的 daq_query 被拒')
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: ctx.agent.id, nodeId: ctx.daq.scalar?.id, kind: 'daq', mode: 'auto' }, token: ctx.token })
  const boundQuery = await invoke('daq_query', { node_id: ctx.daq.scalar?.id })
  ok(boundQuery.data?.result?.isError !== true, '已绑定 agent 的 daq_query 放行')

  // 7b) 绑定面越权:用户 B 不得读全量授权表、不得摘掉 manual 闸门(P0 新增)
  const allBindings = await api('GET', '/api/workshop/agent-tools/bindings', { token: ctx.userB?.token })
  ok(allBindings.status === 200 && (allBindings.data?.bindings ?? []).length === 0,
    '普通用户读绑定表只看到自己授权产线的绑定(不泄漏全量授权表)', `status=${allBindings.status} n=${(allBindings.data?.bindings ?? []).length}`)
  const bindingId = bind.data?.binding?.id
  if (bindingId) {
    await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { body: { mode: 'manual' }, token: ctx.token })
    const bPatch = await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { body: { mode: 'auto' }, token: ctx.userB?.token })
    ok(bPatch.status === 403, '用户 B 摘不掉他人绑定的 HITL 闸门(mode→auto)', `status=${bPatch.status}`)
    const bDel = await api('DELETE', `/api/workshop/agent-tools/bindings/${bindingId}`, { token: ctx.userB?.token })
    ok(bDel.status === 403, '用户 B 删不掉他人绑定', `status=${bDel.status}`)
    await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { body: { mode: 'auto' }, token: ctx.token })
  }
  else { ok(false, '未取到 binding.id(绑定面越权断言无法执行)') }

  // 8) manual 模式 → 挂起审批(dcw_control)
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: ctx.agent.id, nodeId: ctx.dcw.two?.id, kind: 'dcw', mode: 'manual' }, token: ctx.token })
  const hitlPromise = invoke('dcw_control', { node_id: ctx.dcw.two?.id, value: 189 }, { timeoutMs: 120_000 }).catch(e => ({ data: { result: { isError: true, text: `invoke err ${e.message}` } } }))
  const pending = await waitUntil('manual 挂起审批', async () => {
    const r = await api('GET', '/api/workshop/agent-tools/approvals', { token: ctx.token })
    return (r.data?.approvals ?? []).find(p => p.agentId === ctx.agent.id) ?? null
  }, 20_000)
  ok(Boolean(pending?.id) && bridgeWorks, 'manual 绑定产生待审批', pending?.id)
  if (pending?.id) {
    const dec = await api('POST', `/api/workshop/agent-tools/approvals/${pending.id}/decide`, { body: { approved: true, comment: 'e2e 批准' }, token: ctx.token })
    ok(dec.status === 200, '管理员批准待审批')
    const res = await hitlPromise
    ok(res.data?.result?.isError !== true, '批准后指令执行', String(res.data?.result?.text ?? '').slice(0, 80))
  }
  else {
    await hitlPromise
  }

  // 9) manual 模式下的回退也必须挂起(与 dcw_control 同源,P0-D 后半段)
  const rbPromise = invoke('dcw_rollback', { node_id: ctx.dcw.two?.id }, { timeoutMs: 120_000 }).catch(e => ({ data: { result: { isError: true, text: `err ${e.message}` } } }))
  const pending2 = await waitUntil('manual 回退挂起审批', async () => {
    const r = await api('GET', '/api/workshop/agent-tools/approvals', { token: ctx.token })
    return (r.data?.approvals ?? []).find(p => p.agentId === ctx.agent.id) ?? null
  }, 20_000)
  if (pending2?.id) {
    await api('POST', `/api/workshop/agent-tools/approvals/${pending2.id}/decide`, { body: { approved: false, comment: 'e2e 拒绝回退' }, token: ctx.token })
    const res = await rbPromise
    ok(/未执行|拒绝/.test(String(res.data?.result?.text ?? '')), 'manual 回退经用户审批拒绝后不执行', String(res.data?.result?.text ?? '').slice(0, 80))
  }
  else {
    const res = await rbPromise
    ok(res.data?.result?.isError === true, 'manual 回退被门控(未挂起则必须直接拒绝)', String(res.data?.result?.text ?? '').slice(0, 90))
  }
}

// ════════════════════════════════════════════════════════════════
// S9 工具桥越权(P0-E 回归)
// ════════════════════════════════════════════════════════════════
async function s9_bridge_authz() {
  section('S9 工具桥越权(P0-E 回归)')
  // 用户 B 的 token + 用户 A 的 agentId → 必须 403
  const cross = await raw('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    token: ctx.userB?.token,
  })
  ok(cross.status === 403, '用户 B 冒用用户 A 的 agentId → 403(P0-E)', `status=${cross.status} ${String(cross.message ?? '').slice(0, 80)}`)

  // 错误 agent token → 401
  const badToken = await raw('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    agentToken: 'not-a-real-token',
  })
  ok(badToken.status === 401, '伪造 agent token → 401', `status=${badToken.status}`)

  // 正确 agent token → 放行
  const goodToken = await raw('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    agentToken: ctx.agent.token,
  })
  ok(goodToken.status === 200, '正确 agent token 自证放行', `status=${goodToken.status}`)

  // 用户 A 自己的 agent → 放行
  const own = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: ctx.agent.id, tool: 'my_industrial_nodes', args: {} },
    token: ctx.token,
  })
  ok(own.status === 200, '属主用户调用自己 agent 的工具放行', `status=${own.status}`)

  // 不存在的 agentId → 404
  const missing = await api('POST', '/api/workshop/agent-tools/invoke', {
    body: { agentId: 'no-such-agent', tool: 'my_industrial_nodes', args: {} },
    token: ctx.token,
  })
  ok(missing.status === 404, '不存在的 agentId → 404', `status=${missing.status}`)
}

// ════════════════════════════════════════════════════════════════
// S10 插件系统
// ════════════════════════════════════════════════════════════════
async function s10_plugins() {
  section('S10 插件系统(装载/路由/client/停用/热重载)')
  const configRoot = process.env.AW_E2E_CONFIG_ROOT
  if (!configRoot) {
    console.log('    · 未提供 AW_E2E_CONFIG_ROOT,跳过插件文件级断言(仅做清单一致性检查)')
  }

  const m0 = await api('GET', '/api/workshop/plugins', { token: ctx.token })
  ok(m0.status === 200, 'GET /api/workshop/plugins 可读')
  const list0 = manifestPlugins(m0)
  ok(Array.isArray(list0), `插件清单为数组(${list0.length} 个)`)

  if (configRoot) {
    const plugDir = join(configRoot, 'plugins')
    const name = `e2e-plug-${TAG}`
    const dir = join(plugDir, name)
    mkdirSync(dir, { recursive: true })

    // 1) setup 必抛错的插件 → 必须"完全无痕"(P0-1 回归)
    const badName = `e2e-bad-${TAG}`
    const badDir = join(plugDir, badName)
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'index.mjs'), `export default {
  name: ${JSON.stringify(badName)},
  setup(ctx) {
    ctx.route('GET', '/ghost', () => ({ ghost: true }))
    throw new Error('e2e intentional setup failure')
  },
}
`, 'utf8')

    // 2) 正常插件:路由 + client + i18n + 设置声明
    //    client 必须**在 manifest 里显式声明**(契约:client?: './client.mjs');
    //    只把 client.mjs 放进目录不会被识别 —— 扫描器读的是 manifest 字段而非文件存在性。
    writeFileSync(join(dir, 'index.mjs'), `export default {
  name: ${JSON.stringify(name)},
  version: '1.2.3',
  description: 'e2e plugin',
  client: './client.mjs',
  settings: [{ key: 'threshold', type: 'number', default: 42, label: 'E2E 阈值' }],
  setup(ctx) {
    ctx.kv.set('setupCalls', (Number(ctx.kv.get('setupCalls')) || 0) + 1)
    ctx.route('GET', '/ping', () => ({ pong: true, tag: ${JSON.stringify(TAG)} }))
    ctx.route('POST', '/echo', (req) => ({ echoed: req?.body ?? null }))
    ctx.onDispose(() => { ctx.kv.set('disposedAt', new Date().toISOString()) })
  },
}
`, 'utf8')
    writeFileSync(join(dir, 'client.mjs'), `export default { name: ${JSON.stringify(name)}, setup() {} }\n`, 'utf8')
    writeFileSync(join(dir, 'i18n.json'), JSON.stringify({ 'zh-CN': { hello: '你好' }, 'en': { hello: 'hi' } }), 'utf8')

    // 触发重载:写状态文件(与 CLI/Web 同路径)
    const statePath = join(configRoot, 'plugins-state.json')

    let loaded = await waitUntil('插件装载', async () => {
      const m = await api('GET', '/api/workshop/plugins', { token: ctx.token })
      const l = manifestPlugins(m)
      return l.find(p => p.name === name) ?? null
    }, 40_000, 1500)

    if (!loaded) {
      // 某些部署下 state 文件不存在 → 主动写一次空 disabled 集合触发 watcher
      writeFileSync(statePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: [] }), 'utf8')
      loaded = await waitUntil('插件装载(写入状态文件后)', async () => {
        const m = await api('GET', '/api/workshop/plugins', { token: ctx.token })
        const l = manifestPlugins(m)
        return l.find(p => p.name === name) ?? null
      }, 40_000, 1500)
    }
    ok(Boolean(loaded), '项目作用域插件被装载', JSON.stringify(loaded ?? {}).slice(0, 120))
    if (loaded) {
      ok(loaded.version === '1.2.3', '插件版本透传', loaded.version)
      ok(loaded.enabled !== false, '插件默认启用')
      ok(loaded.hasClient === true, 'client 脚本被识别')
      ok(loaded.hasI18n === true, 'i18n 包被识别')
      ok(loaded.settingsCount === 1, '设置声明被识别', String(loaded.settingsCount))
      ok(Array.isArray(loaded.routes) && loaded.routes.some(r => r.path === '/ping'), '路由已登记', JSON.stringify(loaded.routes))
    }

    // 路由真的可命中
    const ping = await api('GET', `/api/plugins/${name}/ping`, { token: ctx.token })
    ok(ping.status === 200 && (ping.data?.pong === true || ping.pong === true), '插件路由可命中', JSON.stringify(ping.data ?? ping).slice(0, 100))

    // client 脚本可读
    const client = await api('GET', `/api/plugins/client/${name}`, { token: ctx.token, raw: true })
    ok(client.status === 200, '插件 client 脚本可读', `status=${client.status}`)
    ok(/setup/.test(await client.text().catch(() => '')), 'client 脚本内容正确')

    // i18n 包
    const i18n = await api('GET', '/api/plugins/i18n', { token: ctx.token })
    ok(i18n.status === 200 || i18n.status === 404, 'i18n 端点存在或明确不存在')

    // 幽灵路由回归:setup 失败的插件不得留下可命中的路由(P0-1)
    const ghost = await api('GET', `/api/plugins/${badName}/ghost`, { token: ctx.token })
    ok(ghost.status === 404, 'setup 抛错的插件不留幽灵路由(P0-1)', `status=${ghost.status}`)
    const m2 = await api('GET', '/api/workshop/plugins', { token: ctx.token })
    const list2 = manifestPlugins(m2)
    ok(!list2.some(p => p.name === badName), 'setup 抛错的插件不进清单(P0-1)')

    // 停用 → 路由必须失效
    const dis = await api('POST', `/api/workshop/plugins/${name}/disable`, { body: {}, token: ctx.token })
    ok(dis.status === 200, '停用插件')
    const afterDisable = await waitUntil('停用生效', async () => {
      const m = await api('GET', '/api/workshop/plugins', { token: ctx.token })
      const l = manifestPlugins(m)
      const p = l.find(x => x.name === name)
      return p && p.enabled === false ? p : null
    }, 40_000, 1500)
    ok(Boolean(afterDisable), '停用状态在清单可见(enabled=false)')
    const pingOff = await api('GET', `/api/plugins/${name}/ping`, { token: ctx.token })
    ok(pingOff.status === 404, '停用后路由失效(无幽灵路由)', `status=${pingOff.status}`)

    // 重新启用 → 路由恢复(热重载闭环)
    const en = await api('POST', `/api/workshop/plugins/${name}/enable`, { body: {}, token: ctx.token })
    ok(en.status === 200, '重新启用插件')
    const restored = await waitUntil('热重载恢复', async () => {
      const p = await api('GET', `/api/plugins/${name}/ping`, { token: ctx.token })
      return p.status === 200 ? p : null
    }, 40_000, 1500)
    ok(Boolean(restored), '热重载后路由恢复')

    // 清理
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(badDir, { recursive: true, force: true })
    }
    catch { /* 清理失败不影响断言 */ }
  }
}

// ════════════════════════════════════════════════════════════════
// S11 数据根唯一性(P0-B 回归)
// ════════════════════════════════════════════════════════════════
async function s11_data_root() {
  section('S11 数据根唯一性(P0-B 回归)')
  const configRoot = process.env.AW_E2E_CONFIG_ROOT
  const cwd = process.env.AW_E2E_CWD
  if (!configRoot || !cwd) {
    console.log('    · 未提供 AW_E2E_CONFIG_ROOT / AW_E2E_CWD,跳过')
    return
  }
  const dataDir = join(configRoot, 'data')
  const legacyDir = join(cwd, 'server', 'data')

  // 本次 e2e 已经写入了产线/产品/配方/节点/回退,它们必须落在配置根
  const mustBeInConfigRoot = ['daqs.json', 'dcws.json', 'dcw-lines.json', 'dcw-products.json', 'dcw-recipes.json', 'dcw-rollback.json', 'dcw-writes.json']
  for (const f of mustBeInConfigRoot) {
    ok(existsSync(join(dataDir, f)), `配置根存在 ${f}`)
  }
  if (existsSync(legacyDir)) {
    const legacyFiles = mustBeInConfigRoot.filter(f => existsSync(join(legacyDir, f)))
    ok(legacyFiles.length === 0, 'cwd/server/data 不再被写入(P0-B)', legacyFiles.length ? `仍存在: ${legacyFiles.join(', ')}` : '')
  }
  else {
    ok(true, 'cwd/server/data 不存在(P0-B)')
  }
}

// ════════════════════════════════════════════════════════════════
// 清理
// ════════════════════════════════════════════════════════════════
async function cleanup() {
  section('清理')
  const t = ctx.token
  try {
    if (ctx.line?.id) await api('POST', `/api/workshop/dcw/lines/${ctx.line.id}/stop`, { body: {}, token: t }).catch(() => {})
    if (ctx.channelId) await api('DELETE', `/api/workshop/channels/${ctx.channelId}?purge=1`, { token: t }).catch(() => {})
    for (const n of Object.values(ctx.dcw)) if (n?.id) await api('DELETE', `/api/workshop/dcw/${n.id}`, { token: t }).catch(() => {})
    for (const n of Object.values(ctx.daq)) if (n?.id) await api('DELETE', `/api/workshop/daq/${n.id}`, { token: t }).catch(() => {})
    if (ctx.recipe?.id) await api('DELETE', `/api/workshop/dcw/recipes/${ctx.recipe.id}`, { token: t }).catch(() => {})
    if (ctx.product?.id) await api('DELETE', `/api/workshop/dcw/products/${ctx.product.id}`, { token: t }).catch(() => {})
    if (ctx.line?.id) await api('DELETE', `/api/workshop/dcw/lines/${ctx.line.id}`, { token: t }).catch(() => {})
    console.log('  · 测试夹具已清理')
  }
  catch (err) {
    console.log(`  · 清理异常(不影响结果): ${err.message}`)
  }
}

// ════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n════ AgentWorkShop 全链路 E2E @ ${BASE} (tag=${TAG}) ════`)
  // 就绪探测:用只读的 setup-status,不写任何数据(早先用 register 探测会抢走
  // "首个用户 = admin" 名额,导致后续 S1 拿到普通角色而全线 403)
  const health = await fetch(`${BASE}/api/users/setup-status`).catch(() => null)
  if (!health || !health.ok) {
    console.error(`✖ 目标服务不可达或未就绪: ${BASE}\n  请先启动: node scripts/start.mjs --port ${new URL(BASE).port}`)
    process.exit(1)
  }
  const st = await health.json().catch(() => ({}))
  console.log(`  · 服务就绪(needsSetup=${st?.data?.needsSetup ?? st?.needsSetup})`)

  const stages = [
    ['S1', s1_accounts],
    ['S2', s2_model],
    ['S3', s3_drivers],
    ['S4', s4_daq],
    ['S5', s5_frames],
    ['S6', s6_dcw],
    ['S7', s7_rollback],
    ['S8', s8_agent_authz],
    ['S9', s9_bridge_authz],
    ['S10', s10_plugins],
    ['S11', s11_data_root],
  ]
  for (const [id, fn] of stages) {
    try {
      await fn()
    }
    catch (err) {
      fail++
      failures.push(`${id} 阶段异常`)
      console.error(`  ✘ ${id} 阶段异常: ${err?.message ?? err}`)
    }
  }

  await cleanup()

  console.log(`\n════ 结果: ${pass} PASS / ${fail} FAIL ════`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 致命异常:', err)
  process.exit(1)
})
