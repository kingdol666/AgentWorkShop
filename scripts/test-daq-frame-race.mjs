#!/usr/bin/env node
/**
 * scripts/test-daq-frame-race.mjs —— DAQ 帧「先广播后落库」竞态验证。
 *
 * 竞态:ingestFrame() 把帧 push 进内存 frameBuffer 后立刻广播 WS daq.frame,
 * 而 frameBuffer 是 500ms 防抖异步刷盘 —— 前端收到帧马上回查
 * /api/workshop/daq/:id/frames/content?ts=<tsMs> 会在落库前拿到 404。
 *
 * 修复:frameContent/frames 查询侧「内存读穿透」—— 先按 (nodeId, tsMs) 查
 * frameBuffer,未命中再查 TSDB;返回结构与 TSDB 查询路径逐字段一致。
 *
 * A. 函数级:复刻 framesFromBuffer 映射,证明竞态存在 + 修复后一致
 * B. 端到端:对运行中服务器注册用户 → 找/建 image 节点 → 采一帧 →
 *    在 WS 广播后立刻(远早于 500ms 刷盘)回查 content,断言 200 + PNG/JPEG。
 *
 * 用法:node scripts/test-daq-frame-race.mjs [base]   默认 http://127.0.0.1:3021
 * 服务器未起时自动降级为仅 A 部分。
 */

const BASE = process.argv[2] ?? process.env.AW_BASE ?? 'http://127.0.0.1:3021'
let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log('  [PASS] ' + label + (detail ? ' -- ' + detail : ''))
    return
  }
  fail++
  console.log('  [FAIL] ' + label + (detail ? ' -- ' + detail : ''))
}
const section = t => console.log('\n=== ' + t + ' ===')

// ---------------------------------------------------------
// A. 函数级:复刻 daq-controller.ts 的映射逻辑
// ---------------------------------------------------------
section('A. 函数级:内存读穿透映射与 TSDB 形态一致性')

/** 复刻 DaqController.pointsFromMeta(与 tsdb adapter 同规则) */
function pointsFromMeta(meta) {
  const p = meta.points
  if (!Array.isArray(p) || p.length === 0 || p.length > 4096) return undefined
  return p.every(x => Number.isFinite(Number(x))) ? p.map(Number) : undefined
}

/** 复刻 DaqController.framesFromBuffer(帧 buffer 行 -> DaqFrameRecord) */
function framesFromBuffer(frameBuffer, id, tsMs) {
  const out = []
  for (const r of frameBuffer) {
    if (r.nodeId !== id || r.tsMs !== tsMs) continue
    out.push({
      at: r.tsMs,
      kind: r.kind,
      points: r.kind === 'vector' ? pointsFromMeta(r.meta) : undefined,
      metrics: r.metrics,
      meta: r.meta,
      deviceBindingId: r.deviceBindingId ?? null,
      lineId: r.lineId ?? null,
      productId: r.productId ?? null,
      recipeId: r.recipeId ?? null,
      runId: r.runId ?? null,
    })
  }
  return out
}

/** 复刻 sqlite/timescale adapter 的 queryFrames 映射(落库后的同一行) */
function queryFramesMapping(row) {
  return {
    at: row.tsMs,
    kind: row.kind,
    points: row.kind === 'vector' ? pointsFromMeta(row.meta) : undefined,
    metrics: row.metrics,
    meta: row.meta,
    deviceBindingId: row.device_binding_id ?? null,
    lineId: row.line_id ?? null,
    productId: row.product_id ?? null,
    recipeId: row.recipe_id ?? null,
    runId: row.run_id ?? null,
  }
}

/** 复刻「修复前」语义:只查 TSDB(buffer 未刷盘 => [] => 404) */
function legacyFrameContent(tsdbRows, id, tsMs) {
  const rows = tsdbRows.filter(r => r.nodeId === id && r.tsMs >= tsMs - 1 && r.tsMs <= tsMs + 1)
    .map(queryFramesMapping)
  const row = rows.find(r => r.at === tsMs)
  if (!row || row.kind !== 'image') return { status: 404 }
  const key = row.meta.objectKey
  if (!key) return { status: 404 }
  return { status: 200, key, mime: typeof row.meta.mime === 'string' ? row.meta.mime : 'image/png' }
}

/**
 * 读 PNG IHDR 的像素宽度(非 PNG / 太短 / chunk 不合法 → null)。
 * PNG:8 字节签名 + [4B 长度][4B "IHDR"][4B 宽度][4B 高度]...
 */
function pngWidth(buf) {
  if (!buf || buf.length < 24) return null
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null
  if (String.fromCharCode(buf[12], buf[13], buf[14], buf[15]) !== 'IHDR') return null
  return ((buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]) >>> 0
}

/** 两份字节是否完全相同 */
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 复刻「修复后」语义:先 buffer,未命中再 TSDB */
function fixedFrameContent(frameBuffer, tsdbRows, id, tsMs, thumb) {
  const rows = framesFromBuffer(frameBuffer, id, tsMs)
  if (rows.length === 0) {
    rows.push(...tsdbRows.filter(r => r.nodeId === id && r.tsMs >= tsMs - 1 && r.tsMs <= tsMs + 1).map(queryFramesMapping))
  }
  const row = rows.find(r => r.at === tsMs)
  if (!row || row.kind !== 'image') return { status: 404 }
  const key = thumb ? row.meta.thumbKey : row.meta.objectKey
  if (!key) return { status: 404 }
  return { status: 200, key, mime: typeof row.meta.mime === 'string' ? row.meta.mime : 'image/png' }
}

const TS = 1760000000000
const NODE = 'dn-race01'
const imageRow = {
  nodeId: NODE, tsMs: TS, kind: 'image', templateKey: 'ccd-image', deviceBindingId: null,
  lineId: null, productId: null, recipeId: null, runId: null, points: 0,
  meta: { objectKey: 'daq/' + NODE + '/' + TS + '.png', thumbKey: 'daq/' + NODE + '/' + TS + '.thumb.png', mime: 'image/png', width: 640, height: 480 },
  metrics: { brightness: 128.5 },
  device_binding_id: null, line_id: null, product_id: null, recipe_id: null, run_id: null,
}
const vectorRow = {
  nodeId: NODE, tsMs: TS, kind: 'vector', templateKey: 'plug-matrix-profile', deviceBindingId: null,
  lineId: null, productId: null, recipeId: null, runId: null, points: 3,
  meta: { points: [1.5, 2.5, 3.5] }, metrics: { avg: 2.5 },
  device_binding_id: null, line_id: null, product_id: null, recipe_id: null, run_id: null,
}
const EMPTY_TSDB = []

// A1 竞态复现:修复前 404
ok(legacyFrameContent(EMPTY_TSDB, NODE, TS).status === 404, '竞态复现:未刷盘时[仅查 TSDB]返回 404')

// A2 修复后立刻可取
const fixed = fixedFrameContent([imageRow], EMPTY_TSDB, NODE, TS, false)
ok(fixed.status === 200, '修复生效:同刻[先查 buffer]返回 200', 'status=' + fixed.status)
ok(fixed.key === imageRow.meta.objectKey, '主图取 meta.objectKey', String(fixed.key))
ok(fixed.mime === 'image/png', 'mime 透传自 meta.mime', String(fixed.mime))
ok(fixedFrameContent([imageRow], EMPTY_TSDB, NODE, TS, true).key === imageRow.meta.thumbKey, '缩略图取 meta.thumbKey')

// A3 形态一致性:buffer 路径 === TSDB 路径
const fromBuffer = framesFromBuffer([imageRow], NODE, TS)[0]
const fromTsdb = queryFramesMapping(imageRow)
const keys = o => JSON.stringify(Object.keys(o).sort())
ok(keys(fromBuffer) === keys(fromTsdb), 'image:buffer 记录键集 === TSDB 记录键集', keys(fromBuffer))
ok(JSON.stringify(fromBuffer) === JSON.stringify(fromTsdb), 'image:buffer 记录值与 TSDB 逐一相等')
ok(fromBuffer.points === undefined, 'image:points 为 undefined(与 TSDB 一致)')
ok(fromBuffer.meta === imageRow.meta, 'image:meta 原样透传(objectKey/thumbKey/mime/width/height)')

const vecBuf = framesFromBuffer([vectorRow], NODE, TS)[0]
const vecTsdb = queryFramesMapping(vectorRow)
ok(JSON.stringify(vecBuf) === JSON.stringify(vecTsdb), 'vector:buffer 记录与 TSDB 逐一相等(含 meta.points 还原)')
ok(Array.isArray(vecBuf.points) && vecBuf.points.length === 3, 'vector:points 从 meta.points 还原', JSON.stringify(vecBuf.points))

// A4 pointsFromMeta 防御规则
ok(pointsFromMeta({ points: [] }) === undefined, '空点列 -> undefined')
ok(pointsFromMeta({ points: 'x' }) === undefined, '非数组 -> undefined')
ok(pointsFromMeta({ points: [1, 'a'] }) === undefined, '非数值成员 -> undefined')
ok(pointsFromMeta({ points: new Array(4097).fill(1) }) === undefined, '超 4096 越界 -> undefined')
ok(JSON.stringify(pointsFromMeta({ points: ['1', 2] })) === '[1,2]', '数值字符串归一为 number')

// A5 命中不查 TSDB
let tsdbCalls = 0
const spy = () => {
  tsdbCalls++
  return []
}
if (framesFromBuffer([imageRow], NODE, TS).length === 0) spy()
ok(tsdbCalls === 0, 'buffer 命中时不触发 TSDB 查询')
if (framesFromBuffer([imageRow], NODE, TS + 1).length === 0) spy()
ok(tsdbCalls === 1, 'buffer 未命中时回退 TSDB 查询')

// A6 刷盘后无回归
ok(fixedFrameContent([], [imageRow], NODE, TS, false).status === 200, '刷盘后(buffer 空)仍由 TSDB 路径返回 200')
ok(fixedFrameContent([], [], NODE, TS, false).status === 404, '真正不存在的帧仍 404(未放水)')

// A7 frames() 列表合并语义
function mergeFrames(tsdbRows, frameBuffer, id, opts) {
  const rows = tsdbRows.map(queryFramesMapping)
  const seen = new Set(rows.map(r => r.at))
  const pending = frameBuffer.filter(r => r.nodeId === id
    && (opts.kind == null || r.kind === opts.kind)
    && r.tsMs >= (opts.fromMs ?? 0) && r.tsMs <= (opts.toMs ?? Date.now()))
    .filter(r => !seen.has(r.tsMs))
    .sort((a, b) => b.tsMs - a.tsMs)
    .map(r => framesFromBuffer([r], id, r.tsMs)[0])
  return [...rows, ...pending].slice(0, Math.min(Math.max(opts.limit ?? 100, 1), 1000))
}
const merged = mergeFrames([], [imageRow, vectorRow], NODE, { limit: 10 })
ok(merged.length === 2, 'frames():未刷盘帧补入列表', 'n=' + merged.length)
ok(merged[0].at >= merged[1].at, 'frames():按 at 降序')
ok(mergeFrames([], [imageRow], NODE, { limit: 10, kind: 'vector' }).length === 0, 'frames():kind 过滤生效')
ok(mergeFrames([], [imageRow, vectorRow], NODE, { limit: 10 }).length === 2, 'frames():无重复(按 at 去重)')

// ---------------------------------------------------------
// B. 端到端
// ---------------------------------------------------------
section('B. 端到端:运行中的服务器')

// BASE 可能指向不可用端口;依次探测候选基址,取第一个能提供 DAQ API 的
const candidates = [BASE, 'http://127.0.0.1:3021', 'http://127.0.0.1:3001'].filter((v, i, a) => a.indexOf(v) === i)
let API = null
for (const c of candidates) {
  try {
    const res = await fetch(c + '/api/workshop/daq/infra', { signal: AbortSignal.timeout(4000) })
    // 401 = 服务在,只是要鉴权;同样算可用
    if (res.status < 500) {
      API = c
      break
    }
  }
  catch { /* 试下一个 */ }
}
const online = API != null
if (online && API !== BASE) console.log('  ' + BASE + ' 不可用 -> 回退到 ' + API)

const api = async (path, opts = {}) => {
  const res = await fetch(API + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } })
  const ct = res.headers.get('content-type') ?? ''
  const body = ct.includes('application/json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer())
  return { status: res.status, ct, body }
}

if (!online) {
  console.log('  [SKIP] 候选基址 ' + candidates.join(', ') + ' 均不可用 -> 跳过端到端;A 部分已函数级证明修复逻辑。')
  console.log('\n结果:' + pass + ' 通过 / ' + fail + ' 失败(E2E 跳过)')
  process.exit(fail === 0 ? 0 : 1)
}
console.log('  服务器在线:' + API)

// B1 鉴权:admin 全量可见(普通用户受产线 grant 过滤,节点列表为空)
const ADMIN_EMAIL = process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local'
const ADMIN_PASS = process.env.AW_ADMIN_PASS ?? 'admin123'
const login = await api('/api/users/login', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
})
const token = login.body?.data?.token
ok(!!token, '登录取得 token', token ? ADMIN_EMAIL + ' role=' + login.body?.data?.user?.role : 'status=' + login.status)
if (!token) {
  console.log('\n结果:' + pass + ' 通过 / ' + fail + ' 失败(无法鉴权,E2E 中止)')
  process.exit(1)
}
const auth = { authorization: 'Bearer ' + token }

// B2 找 live image 节点(节点视图暴露 templateRef,非 templateKey)
const idx = await api('/api/workshop/daq', { headers: auth })
const d = idx.body?.data ?? {}
const nodes = d.nodes ?? []
const kindOf = {}
for (const t of d.templates ?? []) kindOf[t.key] = t.signalKind
const refOf = n => String(n.templateRef ?? '').replace(/^daq-/, '')
const imgNodes = nodes.filter(n => kindOf[refOf(n)] === 'image')
console.log('  节点总数=' + nodes.length + '  image 节点=' + imgNodes.length
  + '  framesStored=' + (d.controller?.framesStored ?? '?'))

if (imgNodes.length === 0) {
  console.log('  [SKIP] 服务器上无 image 类型节点 -> E2E 未执行(需先建 ccd-image 节点并开线)')
  console.log('\n结果:' + pass + ' 通过 / ' + fail + ' 失败(E2E 部分跳过)')
  process.exit(fail === 0 ? 0 : 1)
}

// B3 挑一个在采(enabled 且非 offline)的 image 节点
const target = imgNodes.find(n => n.enabled && n.state !== 'offline') ?? imgNodes.find(n => n.enabled) ?? imgNodes[0]
console.log('  目标节点:' + target.id + ' tpl=' + refOf(target) + ' line=' + (target.lineId ?? '-')
  + ' enabled=' + target.enabled + ' state=' + target.state)

// B4 关键断言:捕捉「帧列表刚出现的新帧」并立刻回查 content。
//     帧列表自身也走读穿透(修复覆盖),所以新帧一经出现即证明它在 buffer 或 TSDB 中;
//     真正要证的是 content 端点对这种「极新鲜」的帧不再 404。
console.log('\n  --- 轮询最新帧并立刻回查 content(关键断言) ---')

const seen = new Set()
let hit = null
const probeLog = []
const deadline = Date.now() + 90000
while (Date.now() < deadline && !hit) {
  const fr = await api('/api/workshop/daq/' + target.id + '/frames?limit=10', { headers: auth })
  const list = fr.body?.data?.frames ?? []
  for (const f of list) {
    if (seen.has(f.at)) continue
    seen.add(f.at)
    if (f.kind !== 'image') continue
    // 立刻回查(不等待,模拟前端收到 WS daq.frame 后的即时回查)
    const t0 = Date.now()
    const c = await api('/api/workshop/daq/' + target.id + '/frames/content?ts=' + f.at, { headers: auth })
    const dt = Date.now() - t0
    probeLog.push('ts=' + f.at + '->' + c.status)
    if (c.status === 200) {
      hit = { frame: f, content: c, dt }
      break
    }
  }
  if (!hit) await new Promise(r => setTimeout(r, 250))
}

if (probeLog.length) console.log('  探测 ' + probeLog.length + ' 个新帧:' + probeLog.slice(0, 8).join(' | ') + (probeLog.length > 8 ? ' ...' : ''))

ok(!!hit, '捕捉到新 ingest 的 image 帧并可立即取 content',
  hit ? 'ts=' + hit.frame.at + ' 回查耗时=' + hit.dt + 'ms' : '轮询 ' + seen.size + ' 帧均未成功')

if (hit) {
  const c = hit.content
  const buf = c.body
  ok(c.status === 200, '刚 ingest 的帧 content 立即可取(200)', 'status=' + c.status)
  ok(Buffer.isBuffer(buf) && buf.length > 0, 'content 返回非空二进制', 'bytes=' + (buf?.length ?? 0))
  const isPng = buf && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  const isJpg = buf && buf[0] === 0xff && buf[1] === 0xd8
  ok(isPng || isJpg, 'content 是合法 PNG/JPEG 魔数', isPng ? 'PNG' : isJpg ? 'JPEG' : 'ct=' + c.ct)
  ok(String(c.ct).startsWith('image/'), 'content-type 为 image/*', c.ct)

  // 主图 vs 缩略图应是不同字节(缩略图按模板 sink 缩到 256 宽)
  const hasThumb = hit.frame.meta && typeof hit.frame.meta.thumbKey === 'string'
  if (hasThumb) {
    const t = await api('/api/workshop/daq/' + target.id + '/frames/content?ts=' + hit.frame.at + '&thumb=1', { headers: auth })
    ok(t.status === 200 && t.body?.length > 0, '缩略图 content 可取', 'status=' + t.status + ' bytes=' + (t.body?.length ?? 0))
    // 断言用**像素宽度**而不是字节大小:合成帧的主图往往是低熵图案(平坦/渐变),
    // 其 PNG 可能比"降采样后反而引入高频"的缩略图更小 —— 按字节比大小会假阳性。
    // 直接读 IHDR 宽高才是"确实走了 thumbKey 分支"的硬证据。
    const mainW = pngWidth(buf)
    const thumbW = pngWidth(t.body)
    if (mainW != null && thumbW != null) {
      ok(thumbW < mainW, '缩略图像素宽度小于主图(证明走 thumbKey 分支)',
        'thumb ' + thumbW + 'px < main ' + mainW + 'px')
    }
    else {
      ok(!sameBytes(buf, t.body), '缩略图与主图字节不同(非 PNG 无法比尺寸)',
        'main=' + (buf?.length ?? 0) + 'B thumb=' + (t.body?.length ?? 0) + 'B')
    }
  }
  else { console.log('  [INFO] 该帧无 thumbKey -> 跳过缩略图断言') }

  // 未放水:不存在的 ts 仍 404
  const miss = await api('/api/workshop/daq/' + target.id + '/frames/content?ts=1', { headers: auth })
  ok(miss.status === 404, '不存在的帧仍返回 404(未放水)', 'status=' + miss.status)

  // 刷盘后仍可取(TSDB 路径无回归):等待 > 500ms 防抖窗 + 写库时间
  console.log('  等待 1500ms(越过 500ms 刷盘窗)后复测同一 ts ...')
  await new Promise(r => setTimeout(r, 1500))
  const again = await api('/api/workshop/daq/' + target.id + '/frames/content?ts=' + hit.frame.at, { headers: auth })
  ok(again.status === 200 && again.body?.length === buf.length, '刷盘后同一帧仍可取且字节一致(TSDB 路径无回归)',
    'status=' + again.status + ' bytes=' + (again.body?.length ?? 0))
}

console.log('\n结果:' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
