/**
 * 审计实验 4:
 *  A. 队列信封未校验:NaN(坏 at)/字符串 value 落 SQLite 的后果(整批事务是否被毒化)
 *  B. mock ccd-image 帧的 PNG 体积(评估对象存储无删除策略的增长速率)
 * 运行:node scripts/_audit/exp-envelope-and-png.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { deflateSync } from 'node:zlib'

// ---------- A ----------
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE daq_samples (node_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, value REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'ok', line_id TEXT, product_id TEXT, recipe_id TEXT, run_id TEXT,
  PRIMARY KEY (node_id, ts_ms));`)
const ins = db.prepare('INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value, state, line_id, product_id, recipe_id, run_id) VALUES (?,?,?,?,?,?,?,?)')

console.log('--- A1: tsMs = NaN (Date.parse("garbage")) ---')
try {
  db.exec('BEGIN')
  ins.run('dn-a', Date.parse('garbage'), 1.5, 'ok', null, null, null, null)
  ins.run('dn-b', Date.now(), 2.5, 'ok', null, null, null, null)
  db.exec('COMMIT')
  console.log('  batch COMMITTED — rows:', db.prepare('SELECT COUNT(*) c FROM daq_samples').get().c)
}
catch (err) {
  console.log('  batch FAILED (whole transaction rolls back):', err.message)
  try { db.exec('ROLLBACK') }
  catch {}
  console.log('  rows after failure:', db.prepare('SELECT COUNT(*) c FROM daq_samples').get().c)
}

console.log('--- A2: value = "abc" (string) into REAL NOT NULL ---')
try {
  ins.run('dn-c', Date.now() + 1, 'abc', 'ok', null, null, null, null)
  const row = db.prepare('SELECT value, typeof(value) t FROM daq_samples WHERE node_id = ?').get('dn-c')
  console.log(`  stored value=${JSON.stringify(row.value)} sqlite typeof=${row.t}`)
}
catch (err) { console.log('  rejected:', err.message) }

console.log('--- A3: Date.parse(NaN 分支) 对乱序防御的影响 ---')
let lastIngestAt = 0
const ts = Date.parse('garbage')
if (ts && ts <= lastIngestAt) console.log('  late'); else { lastIngestAt = ts; console.log(`  accepted; lastIngestAt=${lastIngestAt}`) }
console.log(`  next frame compare (1000 <= NaN) = ${1000 <= lastIngestAt} → 永不判 late`)

// ---------- B:mock ccd-image 帧体积(png-enc.ts 同款编码) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]) }
function encodePng(width, height, pixels) {
  const stride = width
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; pixels.subarray(y * stride, (y + 1) * stride).forEach((v, i) => { raw[y * (stride + 1) + 1 + i] = v }) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}
// mockImageSample:320x240 灰度,纹理+噪声+暗斑
const w = 320, h = 240, px = new Uint8Array(w * h), baseGray = 128
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  let v = baseGray + Math.sin(x * 0.35) * 8 + Math.sin(y * 0.22 + 1.7) * 6 + (Math.random() - 0.5) * 10
  const dx = x - 160, dy = y - 120, d2 = dx * dx + dy * dy
  if (d2 < 400) v -= (1 - d2 / 400) * 90
  px[y * w + x] = Math.max(0, Math.min(255, Math.round(v)))
}
const t0 = performance.now()
const png = encodePng(w, h, px)
const enc = performance.now() - t0
// thumbnail(width=256) → 256x192
const tw = 256, th = Math.round(h * tw / w), small = new Uint8Array(tw * th)
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) small[y * tw + x] = px[Math.min(h - 1, Math.floor(y * h / th)) * w + Math.min(w - 1, Math.floor(x * w / tw))]
const t1 = performance.now()
const thumb = encodePng(tw, th, small)
const encT = performance.now() - t1
console.log(`\n--- B: ccd-image 帧体积(ccd-image 模板:thumbnail width=256)---`)
console.log(`  main  ${w}x${h} = ${(png.length / 1024).toFixed(1)} KB (encode ${enc.toFixed(1)}ms, deflateSync 同步阻塞)`)
console.log(`  thumb ${tw}x${th} = ${(thumb.length / 1024).toFixed(1)} KB (encode ${encT.toFixed(1)}ms)`)
console.log(`  合计 ${((png.length + thumb.length) / 1024).toFixed(1)} KB/帧 → @1fps/节点 = ${(((png.length + thumb.length) / 1048576) * 86400).toFixed(2)} GB/天/节点`)
db.close()
