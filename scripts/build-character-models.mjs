/**
 * 角色模型库素材生成器(可拖拽加载到小镇的"自定义模型")。
 * 产出 public/assets/game/character/ 下的多张 4 帧精灵表(48x88→192x88),
 * 帧布局与内置 wu-* 员工一致,运行时走同一套 wu-bob-<key> 动画。
 * 依赖:pngjs。运行:node scripts/build-character-models.mjs
 */
import { PNG } from 'pngjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../public/assets/game/character')
fs.mkdirSync(OUT_DIR, { recursive: true })

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t]

class Surface {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.png = new PNG({ width: w, height: h })
    this.png.data.fill(0)
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

  radialGlow(cx, cy, r, c, intensity) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy)
        const a = Math.pow(clamp(1 - d / r, 0, 1), 1.9) * intensity
        if (a > 0.004) this.blend(x, y, c, a)
      }
  }

  save(name) { fs.writeFileSync(path.join(OUT_DIR, name), PNG.sync.write(this.png)) }
}

const FW = 48, FH = 88, FRAMES = 4

/** 画一帧角色:主体根据 type 采用不同轮廓(骑士/法师/机甲),共用飘带裙摆+发光核心 */
function drawFrame(img, frame, p, type) {
  const fx = frame * FW
  const bobY = frame === 0 ? 3 : frame === 2 ? -3 : 0
  const cx = fx + FW / 2
  const top = 8 + bobY
  const hy = top + 8

  // 底部消散飘带(通用)
  for (let t = 0; t < 3; t++) {
    const sway = (t - 1) * 7 + Math.sin(frame * 1.1 + t) * 2
    for (let y = 46 + t * 3; y < FH - 4; y += 1) {
      const prog = (y - 46) / (FH - 4)
      const x = cx + sway * prog * (1 + prog * 0.6)
      img.blend(x, y, mix(p.robe, p.robeDeep, prog), (1 - prog) * 0.85)
      if (prog > 0.6) img.blend(x + 1.5, y, mix(p.robe, p.glow, prog), (1 - prog) * 0.4)
    }
  }

  // 躯干(差异:骑士更宽、机甲方形、法师渐窄)
  let taper = 0.55
  let shoulder = 11
  if (type === 'knight') {
    taper = 0.48
    shoulder = 13
  }
  if (type === 'bot') {
    shoulder = 12
    taper = 0.35
  }
  for (let y = 30; y < 52; y++) {
    const prog = (y - 30) / 22
    const half = shoulder * (1 - prog * taper)
    const c = mix(p.robe, p.robeDeep, prog)
    for (let x = cx - half; x <= cx + half; x++) {
      const edge = 1 - Math.abs(x - cx) / half
      img.blend(x, y, c, 0.5 + edge * 0.35)
    }
  }

  // 胸口发光核心
  for (let y = 34; y < 50; y++)
    for (let x = cx - 6; x <= cx + 6; x++) {
      const d = Math.hypot(x - cx, y - 41)
      if (d < 6) img.blend(x, y, p.glow, clamp((6 - d) / 6, 0, 1) * 0.8)
    }

  // 肩部披帛飘带
  for (let s = -1; s <= 1; s += 2) {
    for (let t = 0; t < 22; t++) {
      const x = cx + s * (8 + t * 1.15) + Math.sin(frame * 0.8 + t * 0.2) * 1.5
      const y = 31 + t * 0.45
      img.blend(x, y, s < 0 ? p.ribbon : p.ribbon2, (1 - t / 24) * 0.9)
    }
  }

  // 头部 + 发丝(差异:法师戴尖帽,骑士戴羽盔,机甲方形头+天线)
  for (let y = hy - 6; y < hy + 20; y++)
    for (let x = cx - 9; x <= cx + 9; x++) {
      const d = Math.hypot((x - cx) * 1.0, (y - hy) * 0.85)
      if (d < 9) img.blend(x, y, p.hair, 0.92)
    }
  // 马尾/披发(机甲则改为脑后天线)
  if (type === 'bot') {
    for (let t = 0; t < 15; t++) img.blend(cx + 9, hy - 8 - t * 0.9, p.trim, (1 - t / 16) * 0.9)
    img.radialGlow(cx + 9, hy - 22, 5, p.glow, 0.7)
  }
  else {
    for (let t = 0; t < 24; t++) img.blend(cx + 7 + t * 0.9 + Math.sin(frame * 1.0 + t * 0.15) * 1.5, hy - 2 + t * 0.55, p.hair, (1 - t / 26) * 0.9)
  }
  // 脸庞
  for (let y = hy - 2; y < hy + 8; y++)
    for (let x = cx - 4; x <= cx + 4; x++) {
      const d = Math.hypot(x - cx, y - (hy + 3))
      if (d < 4.5) img.blend(x, y, [240, 224, 214], 0.95)
    }
  // 眼部
  img.blend(cx - 2, hy + 2, [80, 60, 80], 0.7)
  img.blend(cx + 2, hy + 2, [80, 60, 80], 0.7)

  // 头顶饰物(差异)
  if (type === 'mage') {
    // 尖帽
    for (let t = 0; t < 14; t++) {
      const hw = 9 * (1 - t / 14)
      const yy = hy - 12 - t * 0.5
      for (let x = cx - hw; x <= cx + hw; x++) img.blend(x, yy, mix(p.trim, p.robeDeep, t / 14), 0.9)
    }
    img.radialGlow(cx, hy - 22, 6, p.glow, 0.5)
  }
  else if (type === 'knight') {
    // 羽盔(两侧对称拨羽)
    for (let s = -1; s <= 1; s += 2) {
      for (let t = 0; t < 8; t++) img.blend(cx + s * (3 + t * 1.1), hy - 11 + t * 0.7, p.trim, (1 - t / 9) * 0.95)
    }
    for (let y = hy - 12; y < hy - 4; y++) img.blend(cx, y, p.hair, 0.95)
  }
  else {
    // 机甲方形头 + 双侧饰条
    for (let y = hy - 5; y < hy + 9; y++)
      for (let x = cx - 6; x <= cx + 6; x++) img.blend(x, y, p.hair, 0.85)
    for (let s = -1; s <= 1; s += 2) for (let t = 0; t < 6; t++) img.blend(cx + s * (6 + t * 0.5), hy, p.trim, (1 - t / 7) * 0.8)
  }

  // 全身外发光 + 落点辉光
  img.radialGlow(cx, 40, 26, p.glow, 0.35)
  img.radialGlow(cx, 80, 13, p.glow, 0.5)
}

const models = {
  knight: { robe: [210, 222, 240], robeDeep: [120, 140, 178], hair: [60, 70, 110], ribbon: [150, 168, 214], ribbon2: [110, 128, 178], trim: [230, 240, 255], glow: [150, 190, 255] },
  mage: { robe: [226, 200, 246], robeDeep: [140, 100, 180], hair: [110, 70, 160], ribbon: [200, 170, 240], ribbon2: [150, 110, 200], trim: [236, 214, 250], glow: [205, 160, 255] },
  bot: { robe: [196, 226, 218], robeDeep: [90, 150, 150], hair: [70, 120, 128], ribbon: [150, 200, 196], ribbon2: [100, 160, 160], trim: [170, 240, 214], glow: [150, 240, 206] },
}

for (const [key, p] of Object.entries(models)) {
  const s = new Surface(FW * FRAMES, FH)
  for (let f = 0; f < FRAMES; f++) drawFrame(s, f, p, key)
  s.save(`${key}.png`)
}

console.log('Character models written to', OUT_DIR, '->', ['knight.png', 'mage.png', 'bot.png'].join(', '))
