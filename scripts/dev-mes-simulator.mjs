#!/usr/bin/env node
/**
 * MES 工业模拟器(dev/demo)—— 五类数据格式的真实 REST MES 仿真,供 mes-rest 驱动
 * 格式全谱适配与数据下沉 hook 的端到端联调。
 *
 *   标量   GET /api/v1/params/:tag/current | /history   熔体压力/熔体温度/线速(1s 拍)
 *   向量   GET /api/v1/quality/thickness                膜厚断面 48 道/帧(2s 拍,边部 bead+卷次阶跃+异常窗)
 *   向量   GET /api/v1/quality/birefringence            双折射光谱 32 bin/帧(5s 拍)
 *   图像   GET /api/v1/vision/ccd                       CCD 表检帧 160x120 PNG base64(10s 拍,缺陷斑随工况)
 *   事件   GET /api/v1/events                           换卷/报警/恢复事件流(时间推导)
 *   表格   GET /api/v1/batches                          15min 批次汇总表(均值/CPK/缺陷数/判定)
 *
 * 数据是时间驱动确定性伪随机:任何 from/to 窗口都能拉到密集一致的历史(7 天内),
 * 每 15min 一个卷次(均值阶跃),每 90min 一个 9min 的「边部增厚异常窗」——给诊断/DOE
 * 场景留了可发现的真实结构。鉴权:x-api-token 头(与 mes-rest 驱动 secretRef 链路对齐)。
 *
 * 用法:node scripts/dev-mes-simulator.mjs [--port 15060]
 */
import http from 'node:http'
import { deflateSync } from 'node:zlib'

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.MES_SIM_PORT) || 15060
const TOKEN = process.env.MES_SIM_TOKEN || 'mes-demo-token-2026'

// ---------- 确定性伪随机(mulberry32;时间桶播种,任何时刻拉同一窗口结果一致) ----------
function rng(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hashSeed = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
const gauss = r => (r() + r() + r() + r() - 2) * 1.732 // 近似正态(均值0,σ≈1)

// ---------- 工况结构(时间 → 状态) ----------
const ROLL_MS = 15 * 60_000 // 卷次周期
const UPSET_PERIOD_MS = 90 * 60_000 // 异常窗周期
const UPSET_LEN_MS = 9 * 60_000 // 异常窗时长(边部增厚)

/** 异常窗强度 0~1(窗内先升后降) */
function upsetLevel(t) {
  const ph = ((t % UPSET_PERIOD_MS) + UPSET_PERIOD_MS) % UPSET_PERIOD_MS
  if (ph >= UPSET_LEN_MS) return 0
  const x = ph / UPSET_LEN_MS
  return Math.sin(Math.PI * x)
}
const rollShift = (t) => {
  const roll = Math.floor(t / ROLL_MS)
  const r = rng(hashSeed(`roll:${roll}`))
  return (r() - 0.5) * 1.4 // 每卷 ±0.7µm 均值漂移
}

/** 膜厚断面(48 道;µm):基线 50 + 冠面 + 边部 bead + 卷次漂移 + 慢波 + 噪声 + 异常窗单侧增厚 */
function thicknessAt(t) {
  const r = rng(hashSeed(`thk:${Math.floor(t / 2000)}`))
  const upset = upsetLevel(t)
  const rs = rollShift(t)
  const slow = Math.sin(t / 1_800_000 * Math.PI * 2) * 0.5
  const profile = []
  for (let lane = 0; lane < 48; lane++) {
    const u = lane / 47
    const crown = 2.2 * (1 - Math.pow(2 * u - 1, 2)) // 抛物冠面
    const edge = (lane < 2 || lane > 45) ? 3.0 : (lane < 4 || lane > 43) ? 1.1 : 0 // 边部 bead
    const bias = upset > 0.25 && lane >= 42 ? 2.6 * upset : 0 // 异常:操作侧边部增厚
    profile.push(Number((50 + rs + slow + crown + edge + bias + gauss(r) * 0.35).toFixed(3)))
  }
  return profile
}

/** 双折射光谱(32 bin;nm):主峰位置随卷次微移,异常窗峰变宽 */
function birefAt(t) {
  const r = rng(hashSeed(`brf:${Math.floor(t / 5000)}`))
  const shift = rollShift(t) * 0.8
  const widen = 1 + upsetLevel(t) * 0.8
  const spectrum = []
  for (let bin = 0; bin < 32; bin++) {
    const x = (bin - 15.5) / 4
    const peak = 18 * Math.exp(-((x - shift) ** 2) / (2 * widen))
    spectrum.push(Number((peak + gauss(r) * 0.4).toFixed(4)))
  }
  return spectrum
}

/** 过程标量(1s 拍):异常窗内熔压升高、线速微降 —— 与膜厚异常同源,供关联诊断 */
const SCALARS = {
  melt_pressure: { unit: 'MPa', base: 8.4, amp: 0.25, upsetGain: 0.9 },
  melt_temp: { unit: '°C', base: 212, amp: 1.6, upsetGain: 0.3 },
  line_speed: { unit: 'm/min', base: 118, amp: 1.2, upsetGain: -2.2 },
}
function scalarAt(tag, t) {
  const meta = SCALARS[tag]
  if (!meta) return null
  const r = rng(hashSeed(`${tag}:${Math.floor(t / 1000)}`))
  const diurnal = Math.sin(t / 3_600_000 * Math.PI * 2) * meta.amp * 0.4
  const v = meta.base + diurnal + gauss(r) * meta.amp * 0.5 + upsetLevel(t) * meta.upsetGain
  return Number(v.toFixed(3))
}

/** 事件流(时间推导:换卷 + 异常窗报警/恢复) */
function eventsBetween(fromMs, toMs) {
  const rows = []
  const roll0 = Math.floor(fromMs / ROLL_MS)
  const roll1 = Math.ceil(toMs / ROLL_MS)
  for (let roll = roll0; roll <= roll1; roll++) {
    const at = roll * ROLL_MS
    if (at >= fromMs && at < toMs) {
      rows.push({ ts: new Date(at).toISOString(), kind: 'ROLL_CHANGE', severity: 'info', message: `卷次切换 → R${roll % 10000}(膜厚基线重标定)` })
    }
  }
  const per0 = Math.floor(fromMs / UPSET_PERIOD_MS)
  const per1 = Math.ceil(toMs / UPSET_PERIOD_MS)
  for (let p = per0; p <= per1; p++) {
    const start = p * UPSET_PERIOD_MS
    const end = start + UPSET_LEN_MS
    if (start >= fromMs && start < toMs) rows.push({ ts: new Date(start + 30_000).toISOString(), kind: 'ALARM', severity: 'warn', message: 'THK_EDGE_HIGH:操作侧边部膜厚趋势上升(>2σ)' })
    if (end >= fromMs && end < toMs) rows.push({ ts: new Date(end).toISOString(), kind: 'CLEAR', severity: 'info', message: 'THK_EDGE_HIGH 恢复:边部膜厚回落至带内' })
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts))
  return rows
}

/** 批次汇总表(15min=1 批;时间推导聚合) */
function batchesBetween(fromMs, toMs) {
  const rows = []
  const b0 = Math.ceil(fromMs / ROLL_MS)
  const b1 = Math.floor(toMs / ROLL_MS)
  for (let b = b0; b < b1; b++) {
    const start = b * ROLL_MS
    // 批内抽样 60 帧膜厚做汇总
    let sum = 0, n = 0, mn = Infinity, mx = -Infinity
    for (let i = 0; i < 60; i++) {
      const prof = thicknessAt(start + i * (ROLL_MS / 60))
      for (const v of prof) {
        sum += v
        n++
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
    }
    const mean = sum / n
    let m2 = 0
    for (let i = 0; i < 60; i++) for (const v of thicknessAt(start + i * (ROLL_MS / 60))) m2 += (v - mean) ** 2
    const sd = Math.sqrt(m2 / (n - 1))
    const cpk = sd > 0 ? Math.min((52 - mean) / (3 * sd), (mean - 47.5) / (3 * sd)) : 0
    let defects = 0
    for (let i = 0; i < 90; i++) defects += ccdDefectCount(start + i * 10_000)
    const upset = upsetLevel(start + ROLL_MS / 2) > 0.25
    rows.push({
      batch_id: `B${String(b % 100000).padStart(5, '0')}`,
      start: new Date(start).toISOString(),
      end: new Date(start + ROLL_MS).toISOString(),
      mean_thickness: Number(mean.toFixed(3)),
      thickness_sigma: Number(sd.toFixed(3)),
      cpk: Number(Math.max(cpk, 0).toFixed(3)),
      defect_count: defects,
      verdict: cpk >= 1.0 && defects < 12 ? 'PASS' : cpk >= 0.8 ? 'MARGINAL' : 'FAIL',
      note: upset ? '含边部增厚异常窗' : '',
    })
  }
  return rows
}

// ---------- 纯 JS PNG(CCD 帧:160x120 灰度;底纹+带纹+缺陷暗斑) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodeGrayPng(pixels, w, h) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0 // filter: none
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = pixels[y * w + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 帧缺陷数(异常窗内升高;确定性) */
function ccdDefectCount(t) {
  const r = rng(hashSeed(`defc:${Math.floor(t / 10_000)}`))
  const base = r() < 0.55 ? 0 : 1 + Math.floor(r() * 2)
  return base + (upsetLevel(t) > 0.3 ? 1 + Math.floor(r() * 3) : 0)
}

/** CCD 帧:检测算法同源的合成表检图(缺陷暗斑位置与 ccdDefectCount 一致) */
function ccdFrameAt(t) {
  const W = 160, H = 120
  const px = new Uint8Array(W * H)
  const r = rng(hashSeed(`ccd:${Math.floor(t / 10_000)}`))
  for (let y = 0; y < H; y++) {
    const band = Math.sin(y / 9) * 6 + Math.sin(y / 31) * 4
    for (let x = 0; x < W; x++) {
      const shade = 138 + band + (x / W) * 14 + gauss(r) * 3.5
      px[y * W + x] = Math.max(0, Math.min(255, Math.round(shade)))
    }
  }
  // 缺陷暗斑(seed 与缺陷数同帧,位置随机)
  const count = ccdDefectCount(t)
  for (let i = 0; i < count; i++) {
    const cr = rng(hashSeed(`blob:${Math.floor(t / 10_000)}:${i}`))
    const cx = Math.floor(cr() * W), cy = Math.floor(cr() * H)
    const rad = 2 + Math.floor(cr() * 4)
    const depth = 40 + Math.floor(cr() * 50)
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const d2 = dx * dx + dy * dy
        if (d2 > rad * rad) continue
        const x = cx + dx, y = cy + dy
        if (x < 0 || x >= W || y < 0 || y >= H) continue
        const k = 1 - Math.sqrt(d2) / rad
        px[y * W + x] = Math.max(0, Math.round(px[y * W + x] * (1 - k * depth / 160)))
      }
    }
  }
  return { png: encodeGrayPng(px, W, H).toString('base64'), defects: count }
}

// ---------- HTTP 服务 ----------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}
const parseTime = (v, dft) => {
  if (!v) return dft
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : dft
}
/** 分页切片:cursor=数值偏移;返回 {rows, nextCursor} */
const pageSlice = (all, cursor, pageSize) => {
  const off = Math.max(0, Number(cursor) || 0)
  const rows = all.slice(off, off + pageSize)
  const next = off + rows.length < all.length ? String(off + rows.length) : null
  return { rows, nextCursor: next }
}

const beats = {
  thickness: 2000, biref: 5000, ccd: 10_000, scalar: 1000,
}
/** 按格式 beat 枚举窗口内时间点(封顶 20000 点,防天文窗口打爆内存) */
function timePoints(fromMs, toMs, beat) {
  const out = []
  const first = Math.ceil(fromMs / beat) * beat
  for (let t = first; t <= toMs && out.length < 20000; t += beat) out.push(t)
  return out
}

// 多字段写状态(tem/vol/rot;E2E 断言用:验证只写了声明字段)
let multiState = { tem: 55, vol: 1200, rot: 80, at: Date.now() }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path === '/health') return json(res, 200, { ok: true, sim: 'mes', ts: new Date().toISOString() })

  // 鉴权:除 /health 外全部要求 x-api-token
  if (req.headers['x-api-token'] !== TOKEN) {
    return json(res, 401, { error: 'unauthorized: 缺少或错误的 x-api-token 头' })
  }

  const fromMs = parseTime(url.searchParams.get('from'), Date.now() - 30 * 60_000)
  const toMs = parseTime(url.searchParams.get('to'), Date.now())
  const pageSize = Math.max(1, Math.min(Number(url.searchParams.get('pageSize')) || 200, 500))
  const cursor = url.searchParams.get('cursor')

  try {
    // 标量:当前值
    const mCur = path.match(/^\/api\/v1\/params\/([\w-]+)\/current$/)
    if (mCur) {
      const tag = mCur[1]
      // multi 字段组当前值(writeHook 节点的回读映射读这里)
      if (tag === 'multi') {
        return json(res, 200, { data: { value: multiState.tem ?? 55, fields: multiState, ts: multiState.at ?? Date.now() } })
      }
      const v = scalarAt(tag, Date.now())
      if (v === null) return json(res, 404, { error: `unknown tag: ${tag}` })
      return json(res, 200, { data: { value: v, ts: Date.now() } })
    }
    // 标量:历史(cursor 分页)
    const mHis = path.match(/^\/api\/v1\/params\/([\w-]+)\/history$/)
    if (mHis) {
      const tag = mHis[1]
      if (!SCALARS[tag]) return json(res, 404, { error: `unknown tag: ${tag}` })
      const pts = timePoints(fromMs, toMs, beats.scalar)
      const all = pts.map(t => ({ ts: new Date(t).toISOString(), value: scalarAt(tag, t) }))
      const { rows, nextCursor } = pageSlice(all, cursor, pageSize)
      return json(res, 200, { data: { rows, nextCursor } })
    }
    // 向量:膜厚断面
    if (path === '/api/v1/quality/thickness') {
      const pts = timePoints(fromMs, toMs, beats.thickness)
      const all = pts.map((t) => {
        const profile = thicknessAt(t)
        return { ts: new Date(t).toISOString(), profile, mean: Number((profile.reduce((a, b) => a + b, 0) / profile.length).toFixed(4)), lane_unit: 'um' }
      })
      const { rows, nextCursor } = pageSlice(all, cursor, pageSize)
      return json(res, 200, { data: { rows, nextCursor, lanes: 48 } })
    }
    // 向量:双折射光谱
    if (path === '/api/v1/quality/birefringence') {
      const pts = timePoints(fromMs, toMs, beats.biref)
      const rows = pts.slice(0, pageSize).map((t) => {
        const spectrum = birefAt(t)
        return { ts: new Date(t).toISOString(), spectrum, peak_nm: Number(Math.max(...spectrum).toFixed(3)) }
      })
      return json(res, 200, { data: { rows, bins: 32, nextCursor: null } })
    }
    // 图像:CCD 表检帧
    if (path === '/api/v1/vision/ccd') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, 120))
      const pts = timePoints(fromMs, toMs, beats.ccd).slice(-limit)
      const frames = pts.map((t) => {
        const f = ccdFrameAt(t)
        return { ts: new Date(t).toISOString(), mime: 'image/png', width: 160, height: 120, data: f.png, defects: f.defects }
      })
      return json(res, 200, { data: { frames } })
    }
    // 多字段设定写入(POST JSON {tem?,vol?,rot?}):只受理提供的字段 —— 配合 mes-rest
    // writeHook 的「一个节点只写一个字段」语义;记录 applied 供二次校验与 E2E 断言
    if (path === '/api/v1/params/multi/set' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let payload
        try {
          payload = JSON.parse(body || '{}')
        }
        catch { return json(res, 400, { error: 'bad json' }) }
        const allowed = ['tem', 'vol', 'rot']
        const applied = {}
        for (const k of allowed) {
          if (payload[k] !== undefined) {
            const v = Number(payload[k])
            if (!Number.isFinite(v)) return json(res, 400, { error: `field ${k} must be number` })
            if (k === 'tem' && (v < 20 || v > 260)) return json(res, 400, { error: `tem out of range [20,260]`, limit: [20, 260] })
            applied[k] = v
          }
        }
        if (Object.keys(applied).length === 0) return json(res, 400, { error: 'no writable field provided (tem/vol/rot)' })
        multiState = { ...multiState, ...applied, at: Date.now() }
        json(res, 201, { ack: true, applied })
      })
      return
    }
    // 字段目录:多字段区间查询的元数据面(fields 选项/单位/raw beat)
    if (path === '/api/v1/fields') {
      return json(res, 200, {
        data: {
          fields: Object.entries(SCALARS).map(([tag, m]) => ({ field: tag, unit: m.unit, base: m.base, raw_beat_ms: beats.scalar })),
          range_api: '/api/v1/series?fields=a,b&from=ISO&to=ISO&interval=<seconds>',
        },
      })
    }
    // 多字段区间查询(典型 MES 历史库形态):fields=逗号分隔字段;interval=聚合秒数
    // (缺省/0=raw 1s 拍);聚合=桶内 raw 均值,ts=桶对齐点。cursor 分页与 /history 同款。
    if (path === '/api/v1/series') {
      const fields = String(url.searchParams.get('fields') ?? '').split(',').map(s => s.trim()).filter(Boolean)
      const unknown = fields.filter(f => !SCALARS[f])
      if (fields.length === 0) return json(res, 400, { error: `fields 必填(逗号分隔,可选:${Object.keys(SCALARS).join('/')})` })
      if (unknown.length > 0) return json(res, 400, { error: `unknown fields: ${unknown.join(',')}(可选:${Object.keys(SCALARS).join('/')})` })
      const rawInterval = Number(url.searchParams.get('interval'))
      const intervalS = Number.isFinite(rawInterval) && rawInterval > 0 ? Math.floor(rawInterval) : 0
      const stepMs = intervalS > 0 ? intervalS * 1000 : beats.scalar
      // raw 采样点全集(1s 拍,封顶 20000)→ 聚合桶(均值);桶 ts 对齐到 step 网格
      const rawPts = timePoints(fromMs, toMs, beats.scalar)
      const buckets = new Map()
      for (const t of rawPts) {
        const b = intervalS > 0 ? Math.floor(t / stepMs) * stepMs : t
        let acc = buckets.get(b)
        if (!acc) {
          acc = {}
          buckets.set(b, acc)
        }
        for (const f of fields) {
          const v = scalarAt(f, t)
          acc[f] = acc[f] || { sum: 0, n: 0 }
          acc[f].sum += v
          acc[f].n += 1
        }
      }
      const all = [...buckets.keys()].sort((a, b) => a - b).map((b) => {
        const acc = buckets.get(b)
        const values = {}
        for (const f of fields) values[f] = Number((acc[f].sum / acc[f].n).toFixed(4))
        return { ts: new Date(b).toISOString(), values }
      })
      const { rows, nextCursor } = pageSlice(all, cursor, pageSize)
      return json(res, 200, {
        data: {
          rows, nextCursor,
          fields, interval_s: intervalS,
          raw_points: rawPts.length,
          aggregated: intervalS > 0,
          note: intervalS > 0 ? `raw 1s 拍已按 ${intervalS}s 桶均值聚合(${rawPts.length} raw → ${all.length} 行)` : 'raw 1s 拍(未聚合)',
        },
      })
    }
    // 事件
    if (path === '/api/v1/events') {
      return json(res, 200, { data: { rows: eventsBetween(fromMs, toMs).slice(0, pageSize) } })
    }
    // 表格:批次汇总
    if (path === '/api/v1/batches') {
      return json(res, 200, { data: { rows: batchesBetween(fromMs, toMs).slice(0, pageSize) } })
    }
    return json(res, 404, { error: `no route: ${path}` })
  }
  catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mes-sim] MES 工业模拟器 http://127.0.0.1:${PORT} (token 头 x-api-token;卷次 ${ROLL_MS / 60000}min,异常窗每 ${UPSET_PERIOD_MS / 60000}min 持续 ${UPSET_LEN_MS / 60000}min)`)
})
