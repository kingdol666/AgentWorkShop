/**
 * 最小 GIF89a 编码器(逐帧 LZW;无外部依赖,配合 sharp 降采样后的 RAW 像素)。
 * 用法: node scripts/_dbg-gif-encode.mjs
 * 输入: data/gif-frames/frame-XX.png (sharp 转 800x450 RAW)
 * 输出: docs/readme-assets/town-demo.gif
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
const require2 = createRequire('C:/Users/87287/AppData/Local/Programs/DSH Desktop/resources/app/node_modules/pngjs/package.json')
const sharp = require2('sharp')

const W = 640, H = 360, DELAY_MS = 600
// 全局色板:从首帧量化 256 色(中位切分简化:均匀 RGB 5x5x5 立方体 + 灰阶)
function buildPalette() {
  const colors = []
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 5; b++) {
    colors.push([Math.round(r * 51), Math.round(g * 51), Math.round(b * 63.75)])
  }
  while (colors.length < 256) colors.push([0, 0, 0])
  return colors
}
const PALETTE = buildPalette()
const PAL_INDEX = new Map(PALETTE.map((c, i) => [c.join(','), i]))
function quantize(r, g, b) {
  const key = [Math.round(r / 51) * 51, Math.round(g / 51) * 51, Math.round(b / 63.75) * 63.75].join(',')
  const hit = PAL_INDEX.get(key)
  if (hit !== undefined) return hit
  // 最近邻兜底
  let best = 0, bestD = Infinity
  for (let i = 0; i < 256; i++) {
    const [pr, pg, pb] = PALETTE[i]
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2
    if (d < bestD) { bestD = d; best = i }
  }
  PAL_INDEX.set(key, best)
  return best
}

// ---- LZW 编码(GIF 变体:可变码长,clear=256,EOI=257) ----
function lzwEncode(indices, minCodeSize) {
  const CLEAR = 1 << minCodeSize
  const EOI = CLEAR + 1
  let codeSize = minCodeSize + 1
  let dict = new Map()
  let nextCode = EOI + 1
  const resetDict = () => { dict = new Map(); nextCode = EOI + 1; codeSize = minCodeSize + 1 }
  const out = []
  let cur = 0, curBits = 0
  const emit = (code) => {
    cur |= code << curBits
    curBits += codeSize
    while (curBits >= 8) { out.push(cur & 0xFF); cur >>= 8; curBits -= 8 }
  }
  emit(CLEAR)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]
    const key = prefix * 4096 + c
    const found = dict.get(key)
    if (found !== undefined) { prefix = found; continue }
    emit(prefix)
    if (nextCode < 4096) {
      dict.set(key, nextCode++)
      if (nextCode - 1 === (1 << codeSize) && codeSize < 12) codeSize++
    }
    else { emit(CLEAR); resetDict() }
    prefix = c
  }
  emit(prefix)
  emit(EOI)
  if (curBits > 0) out.push(cur & 0xFF)
  return out
}

// ---- 字节流组装 ----
const bytes = []
const push = (...b) => bytes.push(...b)
const pushStr = (s) => { for (const ch of s) bytes.push(ch.charCodeAt(0)) }
const pushU16 = (v) => { bytes.push(v & 0xFF, (v >> 8) & 0xFF) }

// Header + LSD
pushStr('GIF89a'); pushU16(W); pushU16(H)
push(0xF7, 0, 0) // GCT flag(256 色)+ 背景色 0 + 宽高比 0
for (const [r, g, b] of PALETTE) push(r, g, b)
// Netscape 循环扩展
push(0x21, 0xFF, 11); pushStr('NETSCAPE2.0'); push(3, 1, 0, 0, 0)
// 每帧
const frameFiles = []
for (let i = 0; i < 12; i++) frameFiles.push('data/gif-frames/frame-' + String(i).padStart(2, '0') + '.png')
for (const file of frameFiles) {
  const buf = readFileSync(file)
  const raw = await sharp(buf).resize(W, H, { fit: 'cover' }).removeAlpha().raw().toBuffer()
  // GCE
  push(0x21, 0xF9, 4, 0x04, (DELAY_MS / 10) & 0xFF, ((DELAY_MS / 10) >> 8) & 0xFF, 0, 0)
  // Image Descriptor
  push(0x2C); pushU16(0); pushU16(0); pushU16(W); pushU16(H); push(0)
  // LZW
  const indices = new Uint8Array(W * H)
  for (let p = 0; p < W * H; p++) indices[p] = quantize(raw[p * 3], raw[p * 3 + 1], raw[p * 3 + 2])
  const lzw = lzwEncode([...indices], 8)
  // 子块化(每块 ≤255)
  push(8) // min code size
  for (let i = 0; i < lzw.length; i += 255) {
    const chunk = lzw.slice(i, i + 255)
    push(chunk.length, ...chunk)
  }
  push(0) // block terminator
}
push(0x3B) // trailer
writeFileSync('docs/readme-assets/town-demo.gif', Buffer.from(bytes))
console.log('GIF written:', bytes.length, 'bytes,', frameFiles.length, 'frames,', W + 'x' + H)
