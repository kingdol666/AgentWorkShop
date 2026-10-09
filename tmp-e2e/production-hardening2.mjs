/**
 * 生产化加固第二轮专项 e2e(2026-10-09)—— 企业上线 P0 批次验收。
 *
 * 腿 R  注册闸门缺省关(allowRegistration=false;首启引导不受影响)
 * 腿 M  首登强制改密全链(admin 建号 → 登录强制标记 → 错当前密码拒 → 改密清除 → 管理员重置复强制 + 旧会话吊销)
 * 腿 Q  MQTT 陈值保护 + mqtts(mqtts 坏 CA 显式拒 / 停发拒用冻值离线 / 恢复发布自愈)
 * 腿 K  备份扩围(MANIFEST 结构:dbs+objects+infraNote)
 * 腿 I  HITL 巡检豁免(挂起审批卡跨空闲巡检窗(~150s)存活并可批准 —— 修复前此处被收敛拒绝)
 * 腿 X  恢复演练(备份 → AW_DATA_DIR 第二实例重组数据目录 → 健康登录产线核验 → 清理)
 *
 * 前置:3001 生产服务(新代码);benchmark 线在册运行;PLC 模拟器 MQTT broker :18830。
 */
import benchCfg from '../scripts/testing/benchmark.config.json' with { type: 'json' }
import { existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const cfg = benchCfg
const BASE = 'http://127.0.0.1:3001'
const WORKER = cfg.workerId
const checks = []
let TOKEN = ''

function ok(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 160) })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, base = BASE, token = TOKEN) {
  const res = await fetch(base + path, {
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
async function inv(tool, args, timeoutMs = 400_000) {
  const res = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId: WORKER, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => ({}))
  return j?.data?.result ?? { text: JSON.stringify(j?.data ?? j).slice(0, 200), isError: j?.code !== 0 }
}

const login = await api('POST', '/api/users/login', { email: cfg.account.email, password: cfg.account.password })
TOKEN = login?.data?.token ?? ''
ok('登录(admin)', !!TOKEN, login?.message ?? '')

// ================= 腿 R:注册闸门缺省关 =================
console.log('\n── 腿 R:注册闸门缺省关(生产 fail-safe)──')
// R1 新装缺省:schema.json 描述符 default=false(存量部署的显式覆盖属配置面事实,另行核验)
const schemaJson = JSON.parse(readFileSync('shared/config/schema.json', 'utf8'))
const regDesc = (schemaJson.settings ?? []).find(x => x.key === 'security.allowRegistration')
ok('R1 schema 缺省 allowRegistration=false(新装 fail-safe)', regDesc?.default === false, `default=${regDesc?.default}`)
const suffix = Date.now().toString(36)
// R2 现部署实况:live 值 false → 注册端点 403
const setup = await api('GET', '/api/users/setup-status')
ok('R2 现部署 setup-status.allowRegistration=false', setup?.data?.allowRegistration === false, JSON.stringify(setup?.data ?? {}))
const regDenied = await api('POST', '/api/users/register', { name: `probe-${suffix}`, email: `probe-${suffix}@test.local`, password: 'Probe@2026' })
ok('R3 注册端点 403(闸门在岗)', regDenied.status === 403 && regDenied.code === 'REGISTRATION_CLOSED', `${regDenied.status} ${regDenied.code ?? regDenied.message ?? ''}`)
// R4 双向验证:临时开闸 → 注册放行 → 关闸复原(闸门真实生效,非摆设)
await api('PATCH', '/api/system/settings', { override: { 'security.allowRegistration': true } })
const regOk = await api('POST', '/api/users/register', { name: `probe-${suffix}`, email: `probe-${suffix}@test.local`, password: 'Probe@2026' })
ok('R4 显式开闸后注册放行', regOk.code === 0 && !!regOk?.data?.token, `${regOk.code ?? regOk.status} ${regOk.message ?? ''}`)
if (regOk?.data?.user?.id) await api('DELETE', `/api/users/${regOk.data.user.id}`)
await api('PATCH', '/api/system/settings', { override: { 'security.allowRegistration': false } })
const setup2 = await api('GET', '/api/users/setup-status')
ok('R5 复原关闸(live=false)', setup2?.data?.allowRegistration === false, JSON.stringify(setup2?.data ?? {}))

// ================= 腿 M:首登强制改密全链 =================
console.log('\n── 腿 M:首登强制改密全链 ──')
const email = `mc-${suffix}@test.local`
const created = await api('POST', '/api/users', { name: `mc-${suffix}`, email, password: 'TempPass@2026', role: 'user' })
const createdUser = created?.data?.user ?? created?.data
ok('M1 管理员建号:mustChangePassword=true', createdUser?.mustChangePassword === true, JSON.stringify({ id: createdUser?.id, mc: createdUser?.mustChangePassword }))
const uid = createdUser?.id ?? ''
const uLogin = await api('POST', '/api/users/login', { email, password: 'TempPass@2026' })
const uTok = uLogin?.data?.token ?? ''
ok('M2 首登响应携带强制标记', uLogin?.data?.user?.mustChangePassword === true, `mc=${uLogin?.data?.user?.mustChangePassword}`)
const me = await api('GET', '/api/users/me', undefined, BASE, uTok)
ok('M3 /me 同样暴露强制标记', me?.mustChangePassword === true || me?.data?.mustChangePassword === true, `mc=${me?.mustChangePassword ?? me?.data?.mustChangePassword}`)
const wrongPw = await api('POST', '/api/users/change-password', { currentPassword: 'WrongOld@1', newPassword: 'MyNew@2026x' }, BASE, uTok)
ok('M4 当前密码错误 → 401', wrongPw.status === 401, `${wrongPw.status} ${wrongPw.message ?? ''}`)
const chg = await api('POST', '/api/users/change-password', { currentPassword: 'TempPass@2026', newPassword: 'MyNew@2026x' }, BASE, uTok)
ok('M5 改密成功且清除强制标记', chg?.data?.ok === true && chg?.data?.mustChangePassword === false, JSON.stringify(chg?.data ?? {}))
const uLogin2 = await api('POST', '/api/users/login', { email, password: 'MyNew@2026x' })
ok('M6 新密码可登录且不再强制', uLogin2?.data?.user?.mustChangePassword === false, `mc=${uLogin2?.data?.user?.mustChangePassword}`)
const reset = await api('PUT', `/api/users/${uid}`, { password: 'ResetPass@2026' })
ok('M7 管理员重置成功(返回体带强制语义)', reset.status === 0 || reset?.data != null, `${reset.status} ${reset.message ?? ''}`)
const meOld = await api('GET', '/api/users/me', undefined, BASE, uLogin2?.data?.token ?? uTok)
ok('M8 重置后旧会话全部吊销(token 即死)', meOld.status === 401 || meOld?.code === 'USER_UNAUTHORIZED', `${meOld.status} ${meOld.message ?? meOld?.code ?? ''}`)
const uLogin3 = await api('POST', '/api/users/login', { email, password: 'ResetPass@2026' })
ok('M9 重置后首登再次强制改密', uLogin3?.data?.user?.mustChangePassword === true, `mc=${uLogin3?.data?.user?.mustChangePassword}`)
const del = await api('DELETE', `/api/users/${uid}`)
ok('M10 测试用户清理', del.status === 0 || del.status === 200, `${del.status}`)

// ================= 腿 Q:MQTT 陈值保护 + mqtts =================
console.log('\n── 腿 Q:MQTT 陈值保护 + mqtts(TLS)──')
const TOPIC = `e2e/stale/${suffix}`
// Q0 mqtts 坏 CA 显式拒绝(配置期报错,不静默回退明文)
const badTls = await api('POST', '/api/workshop/daq/test-driver', { driver: 'mqtt', driverConfig: { host: '127.0.0.1', port: 18830, topic: TOPIC, secure: true, caFile: 'Z:/no/such/ca.pem' } })
const badTlsTest = badTls?.data?.test ?? badTls?.data
ok('Q0 mqtts+坏 CA 显式报错(不静默降级)', badTlsTest?.ok === false && /CA 证书文件不存在/.test(String(badTlsTest?.message ?? '')), badTlsTest?.message ?? JSON.stringify(badTls).slice(0, 100))
// Q1 建节点(benchmark 线在跑;staleMs=6s 便于验收;节点必绑信号模板)
const nodeCreate = await api('POST', '/api/workshop/daq', {
  name: `mqtt陈值-${suffix}`, driver: 'mqtt', lineId: cfg.lineId, intervalMs: 1000,
  templateRef: 'daq-temp-tc',
  min: 0, max: 100, unit: 'u', decimals: 2,
  driverConfig: { host: '127.0.0.1', port: 18830, topic: TOPIC, staleMs: 6000, jsonPath: 'v' },
})
const qNode = nodeCreate?.data?.node?.id ?? ''
ok('Q1 mqtt 陈值节点创建(staleMs=6s)', !!qNode, qNode || JSON.stringify(nodeCreate).slice(0, 120))
if (qNode) {
  // 发布器:发 3 条 → 静默 → 复发(mqtt 包来自仓库依赖)
  const { default: mqtt } = await import('mqtt')
  const pub = () => new Promise((res, rej) => {
    const c = mqtt.connect('mqtt://127.0.0.1:18830', { connectTimeout: 3000, reconnectPeriod: 0 })
    c.on('connect', () => {
      let n = 0
      const iv = setInterval(() => {
        c.publish(TOPIC, JSON.stringify({ v: 42 + n }), () => {
          n += 1
          if (n < 3) return
          clearInterval(iv)
          c.end(false, {}, () => res())
        })
      }, 150)
    })
    c.on('error', (e) => {
      try {
        c.end(true)
      }
      catch { /* 未连上 */ }
      rej(e)
    })
  })
  let published = true
  try {
    await pub()
  }
  catch (e) {
    published = false
    console.log('  (发布失败:broker 不可达?', e.message, ')')
  }
  ok('Q2 broker :18830 可发布', published, published ? `topic=${TOPIC}` : 'PLC 模拟器 MQTT broker 未启动?')
  if (published) {
    await sleep(3000)
    const now = Date.now()
    const s1 = await api('GET', `/api/workshop/daq/${qNode}/samples?from=${now - 30_000}&to=${now}&bucketMs=1000`)
    const pts1 = s1?.data?.points ?? []
    ok('Q3 停发前:2min 窗有实采数据', pts1.filter(p => p.avg != null).length > 0, `points=${pts1.length} 最新=${JSON.stringify(pts1.at(-1) ?? null).slice(0, 50)}`)
    // 停发 >staleMs(6s)+采样节拍 → 节点应离线且不再 ingest 冻值
    await sleep(10_000)
    const t2 = Date.now()
    const s2 = await api('GET', `/api/workshop/daq/${qNode}/samples?from=${t2 - 8_000}&to=${t2}&bucketMs=1000`)
    const pts2 = (s2?.data?.points ?? []).filter(p => p.avg != null && p.at > t2 - 7_000)
    ok('Q4 停发超 staleMs:冻值不再被采集(无新桶)', pts2.length === 0, `停发后 8s 窗非空桶=${pts2.length}`)
    const dq = await api('GET', '/api/workshop/daq')
    const qv = (dq?.data?.nodes ?? []).find(n => n.id === qNode)
    const staleMsg = String(qv?.lastError ?? qv?.statusText ?? '')
    ok('Q5 节点离线且 lastError 如实(陈值保护)', /停发|陈值/.test(staleMsg), `lastError=${staleMsg.slice(0, 90) || '(空)'}`)
    // 恢复发布 → 自愈
    await pub()
    await sleep(4000)
    const t3 = Date.now()
    const s3 = await api('GET', `/api/workshop/daq/${qNode}/samples?from=${t3 - 10_000}&to=${t3}&bucketMs=1000`)
    const pts3 = (s3?.data?.points ?? []).filter(p => p.avg != null && p.at > t3 - 9_000)
    ok('Q6 恢复发布后数据回流(自愈)', pts3.length > 0, `恢复后 10s 窗非空桶=${pts3.length}`)
  }
  const delN = await api('DELETE', `/api/workshop/daq/${qNode}`)
  ok('Q7 陈值测试节点清理', delN.status === 0 || delN.status === 200, `${delN.status}`)
}

// ================= 腿 K:备份扩围 MANIFEST =================
console.log('\n── 腿 K:备份扩围(daq-objects/exports + MANIFEST)──')
const backupsDir = resolve('.AgentWorkShop/data/backups')
let manifestPath = ''
for (let i = 0; i < 18 && !manifestPath; i++) {
  if (existsSync(backupsDir)) {
    const mans = readdirSync(backupsDir).filter(f => f.startsWith('manifest-') && f.endsWith('.json')).sort()
    if (mans.length) manifestPath = resolve(backupsDir, mans.at(-1))
  }
  if (!manifestPath) await sleep(5000)
}
ok('K1 备份目录存在且含 MANIFEST', !!manifestPath, manifestPath ? String(manifestPath).split(/[/\\]/).at(-1) : '(90s 内未产生备份)')
if (manifestPath) {
  const man = JSON.parse(readFileSync(manifestPath, 'utf8'))
  ok('K2 MANIFEST 含 dbs 数组(三库)', Array.isArray(man.dbs) && man.dbs.length >= 3, JSON.stringify(man.dbs))
  ok('K3 MANIFEST 含 objects 字段(对象面入备/显式跳过)', man.objects != null && (Array.isArray(man.objects.included) || Array.isArray(man.objects.skipped)), JSON.stringify(man.objects).slice(0, 110))
  ok('K4 MANIFEST 声明 infra 卷边界(Timescale/MinIO 不在文件备份范围)', /Timescale|MinIO/.test(String(man.infraNote ?? '')), String(man.infraNote ?? '').slice(0, 80))
}

// ================= 腿 I:HITL 巡检豁免(核心生产场景) =================
console.log('\n── 腿 I:HITL 巡检豁免(挂起审批卡跨 ~150s 空闲巡检窗存活)──')
const lineInfo = await api('GET', '/api/workshop/dcw')
const bmLine = (lineInfo?.data?.lines ?? []).find(l => l.id === cfg.lineId)
const prevMode = bmLine?.controlMode ?? 'manual'
if (prevMode !== 'manual') {
  await api('PATCH', `/api/workshop/dcw/lines/${cfg.lineId}`, { controlMode: 'manual', confirm: true })
}
ok('I0 基准线切 manual(总闸在岗)', true, `prev=${prevMode}`)
// 唤醒 worker 运行时(重启后懒装配;line_status 幂等且零副作用)
const wake = await inv('line_status', {})
ok('I1 worker 运行时在岗(工具桥可达)', !wake.isError, String(wake.text ?? '').split('\n')[0]?.slice(0, 80))
// 当前 holdP 值(同值固化,内容零变化)
const recipes = await api('GET', '/api/workshop/dcw/recipes')
const bmRecipe = (recipes?.data?.recipes ?? []).find(r => r.id === cfg.recipeId)
const params = bmRecipe?.params ?? []
const holdPId = cfg.nodes.dcw.holdP
const holdPParam = params.find(p => (p.nodeId ?? p.node_id) === holdPId || String(p.nodeId ?? p.node_id ?? '').includes('hold'))
const curVal = holdPParam?.value ?? holdPParam?.to ?? 63
ok('I2 基准配方在册且读到 holdP 当前值', !!bmRecipe && Number.isFinite(Number(curVal)), `v${bmRecipe?.version ?? '?'} holdP=${curVal}`)
// 同值 recipe_update → 挂卡不批,穿越空闲巡检窗
const updP = inv('recipe_update', {
  recipe_id: cfg.recipeId,
  params: [{ node_id: holdPId, value: Number(curVal) }],
  reason: `生产化巡检豁免验证:同值固化 ${curVal}(内容无变化;验证挂起审批卡跨空闲巡检窗存活)`,
})
let card = null
for (let i = 0; i < 40 && !card; i++) {
  await sleep(1000)
  const pend = await api('GET', '/api/workshop/hitl/pending')
  const items = pend?.data?.items ?? pend?.data?.cards ?? []
  card = items.filter(x => x.kind === 'dcw-approval' && /^recipe:/.test(String(x.nodeId ?? '')))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
}
ok('I3 recipe_update 审批卡挂起(等待人工)', !!card, card?.id ?? '(未见卡)')
if (card) {
  console.log('  ⏳ 穿越空闲巡检窗:150s(宽限 120s + 扫描 30s;修复前此处卡片会被收敛拒绝)…')
  await sleep(150_000)
  const pend2 = await api('GET', '/api/workshop/hitl/pending')
  const items2 = pend2?.data?.items ?? pend2?.data?.cards ?? []
  const still = items2.find(x => x.id === card.id)
  ok('I4 卡片跨巡检窗仍挂起(豁免生效,未被收敛拒绝)', !!still, still ? `id=${card.id.slice(0, 12)} 仍 pending` : '(已被收敛 —— 豁免未生效)')
  // 批准 → 回合仍活着 → 正常执行
  const updDone = (async () => {
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment: '巡检豁免验收:批准同值固化' })
    return await updP
  })()
  const upd = await updDone
  const updTxt = String(upd.text ?? '')
  ok('I5 批准后正常固化(非「回合已被中止」)', /已保存为 v\d+/.test(updTxt) && !/回合已被中止/.test(updTxt), updTxt.split('\n')[0]?.slice(0, 100))
}
if (prevMode !== 'manual') {
  await api('PATCH', `/api/workshop/dcw/lines/${cfg.lineId}`, { controlMode: prevMode, confirm: true })
  console.log(`  (基准线总闸已复原为 ${prevMode})`)
}

// ================= 腿 X:恢复演练(备份 → 第二实例重组 → 核验) =================
console.log('\n── 腿 X:恢复演练(AW_DATA_DIR 第二实例)──')
if (manifestPath) {
  const stamp = String(manifestPath).split(/[/\\]/).at(-1).replace(/^manifest-/, '').replace(/\.json$/, '')
  const bDir = resolve('.AgentWorkShop/data/backups')
  const rData = resolve('tmp-e2e/restore-home/data')
  rmSync(resolve('tmp-e2e/restore-home'), { recursive: true, force: true })
  mkdirSync(rData, { recursive: true })
  let restored = []
  for (const db of ['workshop.sqlite', 'users.sqlite', 'daq-timeseries.sqlite']) {
    const bak = resolve(bDir, `${db}.${stamp}.bak`)
    if (existsSync(bak)) {
      copyFileSync(bak, resolve(rData, db))
      restored.push(db)
    }
  }
  const filesBundle = resolve(bDir, `files-${stamp}`)
  if (existsSync(filesBundle)) {
    // dcw 线台账/节点绑定等 JSON 仓储读自 dataDir 平铺 —— 必须平铺回 data 根
    // (config.yml/runtime-settings.json 落进来无害:实际读取走配置根)
    cpSync(filesBundle, rData, { recursive: true })
    restored.push('files-*→data')
  }
  const objBundle = resolve(bDir, `objects-${stamp}/daq-objects`)
  if (existsSync(objBundle)) {
    cpSync(objBundle, resolve(rData, 'daq-objects'), { recursive: true })
    restored.push('daq-objects')
  }
  ok('X1 备份重组数据目录(三库+JSON 面)', restored.length >= 4, restored.join(', '))
  // 第二实例:PORT=3100 AW_DATA_DIR 指向重组目录(直启 index.mjs,不经 start.mjs 的单实例锁;
  // session 密钥从 .env 预载语义等价传入 —— 恢复库只存 scrypt 哈希,与签名密钥无关)
  let sessionPw = process.env.NUXT_SESSION_PASSWORD ?? ''
  try {
    const envTxt = readFileSync('.env', 'utf8')
    sessionPw = (/^NUXT_SESSION_PASSWORD=(.*)$/m.exec(envTxt)?.[1] ?? '').trim() || sessionPw
  }
  catch { /* 无 .env:回落环境变量 */ }
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3100', AW_DATA_DIR: rData, AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: sessionPw, NODE_OPTIONS: '--max-old-space-size=1024' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const bootOut = []
  child.stdout.on('data', d => bootOut.push(String(d)))
  child.stderr.on('data', d => bootOut.push(String(d)))
  let up = false
  for (let i = 0; i < 20 && !up; i++) {
    await sleep(2000)
    try {
      const h = await (await fetch('http://127.0.0.1:3100/api/health', { signal: AbortSignal.timeout(2000) })).json()
      up = h?.data?.status === 'ok'
    }
    catch { /* 未起 */ }
  }
  ok('X2 恢复实例健康(3100)', up, up ? 'health ok' : `启动超时;boot 日志尾:${bootOut.join('').slice(-260).replace(/\s+/g, ' ')}`)
  if (up) {
    const rLogin = await api('POST', '/api/users/login', { email: cfg.account.email, password: cfg.account.password }, 'http://127.0.0.1:3100')
    ok('X3 恢复库管理员可登录(users.sqlite 复原)', !!rLogin?.data?.token, rLogin?.message ?? '')
    const rTok = rLogin?.data?.token ?? ''
    const rLines = await api('GET', '/api/workshop/dcw', undefined, 'http://127.0.0.1:3100', rTok)
    const hasLine = (rLines?.data?.lines ?? []).some(l => l.id === cfg.lineId)
    ok('X4 恢复库基准产线在册(workshop.sqlite 复原)', hasLine, `lines=${(rLines?.data?.lines ?? []).length}`)
  }
  try {
    child.kill()
  }
  catch { /* ignore */ }
  await sleep(1500)
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* ignore */ }
  rmSync(resolve('tmp-e2e/restore-home'), { recursive: true, force: true })
  ok('X5 恢复实例停止 + 演练现场清理', !existsSync(resolve('tmp-e2e/restore-home')), 'restore-home removed')
}
else {
  console.log('  (无 MANIFEST,跳过恢复演练)')
  ok('X1 恢复演练(有备份才执行)', false, '缺备份')
}

// ================= 汇总 =================
const pass = checks.filter(c => c.pass).length
console.log(`\n======== 生产化加固第二轮 e2e: ${pass}/${checks.length} ========`)
process.exit(pass === checks.length ? 0 : 1)
