/**
 * 审计实验 5:frames.ts decodeGrayPng 对「非本仓编码器」PNG 的解码正确性。
 * 复刻 decodeGrayPng(frames.ts:144-166)与 quality-gate/thumbnail 的调用方式,
 * 用标准 PNG(filter 类型 2 = Up,真实相机/编码器常见)验证像素是否被正确还原。
 * 运行:node scripts/_audit/exp-png-decode.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib'

const W = 8, H = 4
// 真实像素:每行一个常量阶跃(便于肉眼比对)
const truth = new Uint8Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) truth[y * W + x] = 50 + y * 40

/** 按 PNG 规范生成「filter type 2 (Up)」灰度 8bit PNG */
function encodePngFilterUp(w, h, px) {
  const raw = Buffer.alloc((w + 1) * h)
  let prev = new Uint8Array(w)
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * w, (y + 1) * w)
    raw[y * (w + 1)] = 2 // filter type 2 = Up
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (row[x] - prev[x]) & 0xff // up-filtered
    prev = row
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body)); return Buffer.concat([l, body, c]) }
  chunks.push(chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

// —— frames.ts:144-166 的逐行复刻(只跳过 filter 字节,不做反滤波) ——
function decodeGrayPng(blob, w, h) {
  try {
    let off = 8
    const idat = []
    while (off + 8 <= blob.length) {
      const len = blob.readUInt32BE(off)
      const type = blob.subarray(off + 4, off + 8).toString('ascii')
      if (type === 'IDAT') idat.push(blob.subarray(off + 8, off + 8 + len))
      off += 12 + len
    }
    if (idat.length === 0) return null
    const raw = inflateSync(Buffer.concat(idat))
    const stride = w + 1
    if (raw.length < stride * h) return null
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) out.set(raw.subarray(y * stride + 1, y * stride + 1 + w), y * w)
    return out
  }
  catch { return null }
}

const png = encodePngFilterUp(W, H, truth)
const decoded = decodeGrayPng(png, W, H)
console.log('PNG bytes:', png.length, '| decodeGrayPng returned:', decoded ? 'pixels (non-null)' : 'null')
console.log('truth   :', Array.from(truth).join(','))
console.log('decoded :', decoded ? Array.from(decoded).join(',') : 'null')
if (decoded) {
  let maxErr = 0, sum = 0
  for (let i = 0; i < truth.length; i++) { maxErr = Math.max(maxErr, Math.abs(truth[i] - decoded[i])); sum += decoded[i] }
  console.log(`maxErr=${maxErr}  truthBrightness=${(Array.from(truth).reduce((a, b) => a + b, 0) / truth.length).toFixed(1)}  decodedBrightness=${(sum / decoded.length).toFixed(1)}`)
}
// JPEG 情形:无 IDAT → null
console.log('JPEG-like (no IDAT) →', decodeGrayPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), W, H))
