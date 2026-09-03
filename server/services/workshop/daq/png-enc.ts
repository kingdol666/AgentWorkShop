/**
 * 最小 PNG 编码器(zlib 内建,零外部依赖)—— mock CCD 驱动与 thumbnail 处理器共用。
 *
 * 支持 8-bit 灰度(color type 0)与 8-bit RGB(color type 2);scanline filter 0
 * (None)—— 压缩率略逊于 Paeth,但编码零卷积开销,采集管线内可忽略。
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 灰度/RGB 原始像素 → PNG Buffer。gray 模式 pixels.length === w*h;rgb === w*h*3(RGB 交错)。 */
export function encodePng(width: number, height: number, pixels: Uint8Array, rgb = false): Buffer {
  const colorType = rgb ? 2 : 0
  const bpp = rgb ? 3 : 1
  const stride = width * bpp
  // 每行前置 filter byte 0(None)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v
    })
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 最近邻缩放(灰度;thumbnail 处理器用;像素抽点,零插值开销) */
export function resizeGray(src: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / th))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / tw))
      out[y * tw + x] = src[sy * w + sx]!
    }
  }
  return out
}
