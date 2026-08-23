/**
 * 大世界分层视差背景生成器 —— 3200×2400「共鸣城邦」世界。
 * 产出 public/assets/game/wuwa/world-{far,middle,near}.png(三张分层 + 一张全景合图)。
 *  - far:    远山天空(最远,移动最慢)
 *  - middle: 中景城市剪影 + 绿植带
 *  - near:   近景台地地面(可立足;街道/广场色调)
 *  - world-map.jpg: 全景合成(供迷你地图缩略图)
 * 依赖:pngjs。运行:node scripts/build-world-map.mjs
 */
import { PNG } from 'pngjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../public/assets/game/wuwa')
fs.mkdirSync(OUT, { recursive: true })

const W = 3200
const H = 2400
const HORIZON = 1120

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t]
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

class Surf {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.png = new PNG({ width: w, height: h })
    this.png.data.fill(0)
  }

  set(x, y, c, a) {
    const i = (Math.round(y) * this.w + Math.round(x)) * 4
    if (i < 0 || i + 3 >= this.png.data.length) return
    this.png.data[i] = c[0]
    this.png.data[i + 1] = c[1]
    this.png.data[i + 2] = c[2]
    this.png.data[i + 3] = a
  }

  blend(x, y, c, a) {
    const i = (Math.round(y) * this.w + Math.round(x)) * 4
    if (i < 0 || i + 3 >= this.png.data.length) return
    const da = this.png.data[i + 3] / 255
    const sa = clamp(a, 0, 1)
    const outA = sa + da * (1 - sa)
    if (outA <= 0) return
    this.png.data[i] = Math.round((c[0] * sa + this.png.data[i] * da * (1 - sa)) / outA)
    this.png.data[i + 1] = Math.round((c[1] * sa + this.png.data[i + 1] * da * (1 - sa)) / outA)
    this.png.data[i + 2] = Math.round((c[2] * sa + this.png.data[i + 2] * da * (1 - sa)) / outA)
    this.png.data[i + 3] = Math.round(outA * 255)
  }

  vg(y0, y1, cA, cB) {
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < this.w; x++) this.set(x, y, mix(cA, cB, clamp((y - y0) / (y1 - y0 || 1), 0, 1)), 255)
  }

  radial(cx, cy, r, c, intensity) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy)
        const a = Math.pow(clamp(1 - d / r, 0, 1), 1.9) * intensity
        if (a > 0.004) this.blend(x, y, c, a)
      }
  }

  softCircle(cx, cy, r, c, alpha, feather = 0.4) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy)
        const edge = (r - d) / (r * feather)
        if (edge > 0) this.blend(x, y, c, clamp(edge, 0, 1) * alpha)
      }
  }

  ridge(yBase, amp, color, alpha, seed, step) {
    for (let x = step; x <= this.w; x += step) {
      const h = amp * (0.4 + 0.6 * Math.abs(Math.sin((x + seed) * 0.006 + seed)))
      for (let y = yBase - h; y < yBase; y++) this.blend(x, y, color, alpha)
    }
  }

  fill(color) {
    for (let i = 0; i < this.png.data.length; i += 4) {
      this.png.data[i] = color[0]
      this.png.data[i + 1] = color[1]
      this.png.data[i + 2] = color[2]
      this.png.data[i + 3] = 255
    }
  }

  save(n) { fs.writeFileSync(path.join(OUT, n), PNG.sync.write(this.png)) }
}

// ---------- FAR: 远山天空 ----------
const far = new Surf(W, H)
far.fill(hex('#141a30'))
far.vg(0, 500, hex('#181e38'), hex('#5a4a78'))
far.vg(500, 900, hex('#5a4a78'), hex('#a06a8c'))
far.vg(900, 1120, hex('#a06a8c'), hex('#f0c398'))
// 星空
for (let i = 0; i < 320; i++) far.softCircle((i * 173 + 61) % W, (i * 97 + 23) % 480, 1.4, [235, 235, 245], 0.5 + 0.4 * Math.abs(Math.sin(i * 1.7)))
// 落日
far.radial(2360, 1100, 300, hex('#ffd69a'), 0.5)
far.radial(2360, 1100, 210, hex('#ffe6b8'), 0.55)
far.radial(2360, 1100, 150, hex('#fff0cf'), 0.8)
far.softCircle(2360, 1100, 90, hex('#fff4d8'), 0.95)
// 远山两层
far.ridge(HORIZON, 320, hex('#585f8c'), 0.9, 11, 10)
far.ridge(HORIZON, 200, hex('#3f4c6e'), 0.82, 47, 9)
// 山脚雾
for (let y = HORIZON - 70; y < HORIZON; y += 2) {
  const n = 0.05 + 0.05 * Math.abs(Math.sin(y * 0.02))
  for (let x = 0; x < W; x += 3) far.blend(x, y, hex('#ced2e2'), n)
}
far.save('world-far.png')

// ---------- MIDDLE: 中景城市剪影 + 绿植带 ----------
const mid = new Surf(W, H)
mid.fill(hex('#0e1524'))
// 城市剪影(几何楼块,错落)
for (let i = 0; i < 90; i++) {
  const bw = 40 + (i * 37) % 90
  const bh = 120 + (i * 53) % 220
  const x = (i * 211 + 83) % W
  const y = HORIZON
  const c = mix(hex('#2a3350'), hex('#3f4c6e'), (i % 5) / 5)
  for (let yy = y - bh; yy < y; yy++)
    for (let xx = x; xx < Math.min(W, x + bw); xx++) mid.blend(xx, yy, c, 0.9)
}
// 楼宇窗户微光(随机暖点)
for (let i = 0; i < 500; i++) {
  const x = (i * 149 + 31) % W
  const y = HORIZON - 40 - (i * 89) % 260
  mid.blend(x, y, [235, 200, 150], 0.5 + 0.5 * Math.abs(Math.sin(i * 0.7)))
}
// 绿植带(城市与地面之间)
for (let y = HORIZON; y < HORIZON + 90; y += 3) {
  for (let x = 0; x < W; x += 4) {
    const n = Math.abs(Math.sin(x * 0.01 + y * 0.02))
    if (n > 0.5) mid.blend(x, y, mix(hex('#3a5a4a'), hex('#2a4a3c'), n), 0.7)
  }
}
mid.save('world-middle.png')

// ---------- NEAR: 近景台地地面(可立足) ----------
const near = new Surf(W, H)
near.vg(0, H, hex('#6d9a88'), hex('#3f6a5f'))
// 台地亮斑
for (let i = 0; i < 220; i++) {
  const x = (i * 211 + 97) % W
  const y = HORIZON + 90 + (i * 37 + 13) % (H - HORIZON - 120)
  near.softCircle(x, y, 26 + (i * 7) % 30, hex('#a5ccb8'), 0.12)
}
// 苔藓/石面
for (let i = 0; i < 2600; i++) {
  const x = (i * 149 + 31) % W
  const y = HORIZON + 80 + (i * 89 + 17) % (H - HORIZON - 100)
  near.blend(x, y, hex('#4f7d72'), 0.25)
  if (i % 3 === 0) near.blend(x + 2, y + 1, hex('#93c0aa'), 0.18)
}
// 共鸣光点
for (let i = 0; i < 60; i++) {
  const x = (i * 163 + 53) % W
  const y = HORIZON + 120 + (i * 41 + 29) % (H - HORIZON - 180)
  near.radial(x, y, 22, hex('#8fe8d4'), 0.5)
  near.softCircle(x, y, 2.4, hex('#d8fff2'), 0.9)
}
// 四条环形大道(同心椭圆,暗示街区环绕核心)
for (let ring = 0; ring < 4; ring++) {
  const rx = 260 + ring * 260
  const ry = 180 + ring * 200
  for (let a = 0; a < 360; a += 0.5) {
    const rad = a * Math.PI / 180
    for (let w = -8; w <= 8; w += 2) {
      const x = W / 2 + Math.cos(rad) * (rx + w)
      const y = H + 160 + Math.sin(rad) * (ry + w * 0.6)
      if (x > 0 && x < W && y > 0 && y < H) near.blend(x, y, hex('#b8d0bc'), 0.18)
    }
  }
}
near.save('world-near.png')

console.log('World parallax layers written to', OUT, '->', ['world-far.png', 'world-middle.png', 'world-near.png'].join(', '))
