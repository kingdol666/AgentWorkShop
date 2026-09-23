/**
 * s1 账号 / s2 建模 / s3 驱动
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */
import { TAG, ctx } from './state.mjs'
import { api, ok, section } from './lib.mjs'

export async function s1_accounts() {
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
export async function s2_model() {
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
export async function s3_drivers() {
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
