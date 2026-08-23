/**
 * 鸣潮-系(Resonance Dusk)小镇素材生成器 —— 原创绘制,仅借鉴其视觉语言(黄昏天空 / 层叠山脊 /
 * 流转水面 / 辉光共鸣 / 飘逸精魂),不引用任何游戏原图。
 *
 * 产出(public/assets/game/wuwa/):
 *   scene-map.png   1600x1200 场景地图(黄昏海岸台地)
 *   wu-aura.png     128x128   白色径向辉光(运行时按频道色 tint)
 *   wu-ring.png     128x128   细辉光圆环(频道领地/共鸣场)
 *   wu-lead.png     192x88    领队精魂(4 帧悬停 bob)
 *   wu-worker-0/1/2.png  192x88   worker 精魂(4 帧)
 *   wu-slash.png    48x48     飘带粒子(尾迹点缀)
 *
 * 依赖:pngjs(已安装)。运行:node scripts/build-wuwa-assets.mjs
 */
import { PNG } from 'pngjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../public/assets/game/wuwa')
fs.mkdirSync(OUT_DIR, { recursive: true })

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

/** 可绘画面:RGBA buffer + 软混合/渐变/辉光工具 */
class Surface {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.png = new PNG({ width: w, height: h })
    this.png.data.fill(0)
  }

  idx(x, y) { return (Math.round(y) * this.w + Math.round(x)) * 4 }
  /** 直接写入(alpha 覆盖) */
  set(x, y, [r, g, b], a = 255) {
    const i = this.idx(x, y)
    if (i < 0 || i + 3 >= this.png.data.length) return
    this.png.data[i] = r
    this.png.data[i + 1] = g
    this.png.data[i + 2] = b
    this.png.data[i + 3] = a
  }

  /** alpha 混合叠加 */
  blend(x, y, [r, g, b], a) {
    const i = this.idx(x, y)
    if (i < 0 || i + 3 >= this.png.data.length) return
    const da = this.png.data[i + 3] / 255
    const sa = clamp(a, 0, 1)
    const outA = sa + da * (1 - sa)
    if (outA <= 0) return
    this.png.data[i] = Math.round((r * sa + this.png.data[i] * da * (1 - sa)) / outA)
    this.png.data[i + 1] = Math.round((g * sa + this.png.data[i + 1] * da * (1 - sa)) / outA)
    this.png.data[i + 2] = Math.round((b * sa + this.png.data[i + 2] * da * (1 - sa)) / outA)
    this.png.data[i + 3] = Math.round(outA * 255)
  }

  /** 整行水平渐变 1D(按 y)或整列垂直渐变 2D */
  vGrad(x0, x1, y0, y1, cA, cB, ease = t => t) {
    for (let y = y0; y <= y1; y++) {
      const t = ease(clamp((y - y0) / (y1 - y0 || 1), 0, 1))
      const c = mix(cA, cB, t)
      for (let x = x0; x <= x1; x++) this.set(x, y, c)
    }
  }

  hGrad(x0, x1, y0, y1, cA, cB) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) this.set(x, y, mix(cA, cB, clamp((x - x0) / (x1 - x0 || 1), 0, 1)))
  }

  /** 软圆(实心 + 边缘羽化) */
  softCircle(cx, cy, r, c, alpha = 1, feather = 0.4) {
    const r0 = Math.round(r)
    for (let y = cy - r0; y <= cy + r0; y++)
      for (let x = cx - r0; x <= cx + r0; x++) {
        const d = Math.hypot(x - cx, y - cy)
        const edge = (r - d) / (r * feather)
        if (edge > 0) this.blend(x, y, c, clamp(edge, 0, 1) * alpha)
      }
  }

  /** 径向辉光(中心亮 → 边缘透明) */
  radialGlow(cx, cy, r, c, intensity = 1) {
    const r0 = Math.round(r)
    for (let y = cy - r0; y <= cy + r0; y++)
      for (let x = cx - r0; x <= cx + r0; x++) {
        const d = Math.hypot(x - cx, y - cy)
        const t = clamp(1 - d / r, 0, 1)
        const a = Math.pow(t, 1.9) * intensity
        if (a > 0.004) this.blend(x, y, c, a)
      }
  }

  /** 带轻微抖动的锯齿轮廓填充(山脊/台地) */
  ridge(yBase, amp, color, alpha, seed = 0, step = 8) {
    for (let x = step; x <= this.w; x += step) {
      const h = amp * (0.4 + 0.6 * Math.abs(Math.sin((x + seed) * 0.012 + seed)))
      const yy = yBase - h
      // 填到该折线的竖条
      for (let y = yy; y < yBase; y++) this.blend(x, y, color, alpha)
    }
  }

  save(name) { fs.writeFileSync(path.join(OUT_DIR, name), PNG.sync.write(this.png)) }
}

// =====================================================================
// 1) 场景地图 —— 黄昏海岸台地
// =====================================================================
const MW = 1600
const MH = 1200
const map = new Surface(MW, MH)
const HORIZON = 560 // 地平线:上空为黄昏景,下方为可立足台地

// --- 天空:整幅连续垂直渐变(暗蓝紫 → 紫 → 桃 → 金),全程不透明 ---
map.vGrad(0, MW, 0, 180, hex('#141a30'), hex('#4a3d6b')) // 天顶
map.vGrad(0, MW, 180, 330, hex('#4a3d6b'), hex('#8f5a84')) // 紫
map.vGrad(0, MW, 330, 460, hex('#8f5a84'), hex('#cf807f')) // 桃
map.vGrad(0, MW, 460, HORIZON, hex('#cf807f'), hex('#f0c398')) // 金(近地平线)

// --- 星光(上部稀疏) ---
for (let i = 0; i < 90; i++) {
  const x = (i * 173 + 61) % MW
  const y = (i * 97 + 23) % 260
  const tw = 0.25 + 0.7 * Math.abs(Math.sin(i * 1.7))
  map.softCircle(x, y, 1.2, [235, 235, 245], tw)
}

// --- 落日:光晕 + 亮盘(坐在地平线) ---
const sunX = 1180, sunY = HORIZON - 8
map.radialGlow(sunX, sunY, 200, hex('#ffd69a'), 0.5)
map.radialGlow(sunX, sunY, 140, hex('#ffe6b8'), 0.55)
map.radialGlow(sunX, sunY, 90, hex('#fff0cf'), 0.8)
map.softCircle(sunX, sunY, 52, hex('#fff4d8'), 0.95)

// --- 远山剪影(坐在地平线,雾霾淡化) ---
map.ridge(HORIZON, 160, hex('#585f8c'), 0.9, 11, 8)
map.ridge(HORIZON + 4, 104, hex('#3f4c6e'), 0.82, 47, 7)
// 山脚横雾
for (let y = HORIZON - 40; y < HORIZON + 8; y += 2) {
  const n = 0.05 + 0.05 * Math.abs(Math.sin(y * 0.05))
  for (let x = 0; x < MW; x += 3) map.blend(x, y, hex('#ced2e2'), n * (1 - (y - (HORIZON - 40)) / 48))
}

// --- 地平线亮带(山脚与地台之间的辉光) ---
map.hGrad(0, MW, HORIZON, HORIZON + 26, hex('#f7dbb4'), hex('#e0c39a'))

// --- 前景台地(可立足的"小镇地面"):海水过渡 → 岸 → 阶地 → 草坡 ---
map.vGrad(0, MW, HORIZON + 26, HORIZON + 70, hex('#8fb0a0'), hex('#6d9a88')) // 岸线过渡
map.vGrad(0, MW, HORIZON + 70, HORIZON + 150, hex('#6d9a88'), hex('#5c8a76')) // 下岸
map.vGrad(0, MW, HORIZON + 150, MH, hex('#5c8a76'), hex('#3f6a5f')) // 主台地(深草)

// 台地暖光侧(近落日一侧偏暖)
map.hGrad(sunX - 400, MW, HORIZON + 150, MH, hex('#86b3a0'), hex('#6f9a92'))
// 阶地(横向柔和色带,暗示梯田/平台)
for (let i = 0; i < 9; i++) {
  const y0 = HORIZON + 70 + i * 62
  const c = hex('#7fae9c')
  const c2 = hex('#4f7d72')
  for (let x = 0; x < MW; x++)
    for (let y = y0; y < Math.min(MH, y0 + 22); y++) map.blend(x, y, i % 2 ? c : c2, 0.16)
}
// 台地亮斑(草地/苔面高光)
for (let i = 0; i < 90; i++) {
  const x = (i * 211 + 97) % MW
  const y = HORIZON + 60 + (i * 37 + 13) % (MH - HORIZON - 80)
  map.softCircle(x, y, 24 + (i * 7) % 26, hex('#a5ccb8'), 0.12)
}
// 苔藓/石面细点
for (let i = 0; i < 1400; i++) {
  const x = (i * 149 + 31) % MW
  const y = HORIZON + 50 + (i * 89 + 17) % (MH - HORIZON - 70)
  map.blend(x, y, hex('#4f7d72'), 0.25)
  if (i % 3 === 0) map.blend(x + 2, y + 1, hex('#93c0aa'), 0.18)
}
// 水底柔光(呼应共鸣的海面呼吸)
for (let i = 0; i < 26; i++) {
  const x = (i * 163 + 53) % MW
  const y = HORIZON + 34 + (i * 41 + 29) % 40
  map.radialGlow(x, y, 14, hex('#bfe6e2'), 0.35)
}
// 共鸣光点(散落景观)
for (let i = 0; i < 26; i++) {
  const x = (i * 163 + 53) % MW
  const y = HORIZON + 120 + (i * 41 + 29) % (MH - HORIZON - 160)
  map.radialGlow(x, y, 18, hex('#8fe8d4'), 0.5)
  map.softCircle(x, y, 2.2, hex('#d8fff2'), 0.9)
}

// --- 柔和暗角 ---
for (let y = 0; y < MH; y++)
  for (let x = 0; x < MW; x++) {
    const dx = (x - MW / 2) / (MW / 2)
    const dy = (y - MH / 2) / (MH / 2)
    const v = Math.max(0, Math.hypot(dx * 0.95, dy) - 0.82) * 0.5
    if (v > 0.01) map.blend(x, y, hex('#0e1524'), v)
  }

map.save('scene-map.png')

// =====================================================================
// 2) 白色径向辉光(运行时 tint 成频道共鸣色)
// =====================================================================
{
  const a = new Surface(128, 128)
  a.radialGlow(64, 64, 64, [255, 255, 255], 1)
  a.save('wu-aura.png')
}
// 3) 细辉光圆环(领地/共鸣场)
{
  const a = new Surface(256, 256)
  const cx = 128, cy = 128, R = 116
  for (let ang = 0; ang < 360; ang += 1) {
    const rad = ang * Math.PI / 180
    for (let r = R - 12; r <= R + 4; r++) {
      const x = cx + Math.cos(rad) * r, y = cy + Math.sin(rad) * r
      const edge = r > R ? (R + 4 - r) / 8 : (r - (R - 12)) / 12
      if (edge > 0) a.blend(x, y, [255, 255, 255], 0.5 * clamp(edge, 0, 1))
    }
  }
  a.radialGlow(cx, cy, R, [255, 255, 255], 0.18)
  a.save('wu-ring.png')
}
// 4) 飘带/粒子(尾迹点缀)
{
  const a = new Surface(16, 16)
  a.radialGlow(8, 8, 8, [255, 255, 255], 1)
  a.save('wu-slash.png')
}

// =====================================================================
// 角色精魂 sheet:4 帧悬停 bob(向下→中→上→中),每帧 48x88 → 192x88
// =====================================================================
const FRAME_W = 48, FRAME_H = 88, FRAMES = 4

/** 画一帧精魂(飘带裙摆 + 发光核心 + 发丝)。palette 决定主色。 */
function drawSpirit(img, frame, p) {
  const fx = frame * FRAME_W
  const bobY = frame === 0 ? 3 : frame === 2 ? -3 : 0
  const bx = fx + FRAME_W / 2
  const top = 8 + bobY
  const cx = bx

  // —— 底部消散飘带(3 条弯曲柔尾) ——
  for (let t = 0; t < 3; t++) {
    const sway = (t - 1) * 7 + Math.sin(frame * 1.1 + t) * 2
    for (let y = 46 + t * 3; y < FRAME_H - 4; y += 1) {
      const prog = (y - 46) / (FRAME_H - 4)
      const x = cx + sway * prog * (1 + prog * 0.6)
      const a = (1 - prog) * 0.9
      img.blend(x, y, mix(p.robe, p.robeDeep, prog), a * 0.85)
      if (prog > 0.6) img.blend(x + 1.5, y, mix(p.robe, p.glow, prog), a * 0.4)
    }
  }

  // —— 长袍主体(左右对称的渐窄身形) ——
  for (let y = 30; y < 52; y++) {
    const prog = (y - 30) / 22
    const half = 11 * (1 - prog * 0.55)
    const c = mix(p.robe, p.robeDeep, prog)
    for (let x = cx - half; x <= cx + half; x++) {
      const edge = 1 - Math.abs(x - cx) / half
      img.blend(x, y, c, 0.5 + edge * 0.35)
    }
  }

  // —— 胸口发光核心 ——
  for (let y = 34; y < 50; y++)
    for (let x = cx - 6; x <= cx + 6; x++) {
      const d = Math.hypot(x - cx, y - 41)
      if (d < 6) img.blend(x, y, p.glow, clamp((6 - d) / 6, 0, 1) * 0.8)
    }

  // —— 肩部披帛(两条飘带向两侧展开) ——
  for (let s = -1; s <= 1; s += 2) {
    for (let t = 0; t < 22; t++) {
      const x = cx + s * (8 + t * 1.15) + Math.sin(frame * 0.8 + t * 0.2) * 1.5
      const y = 31 + t * 0.45
      img.blend(x, y, s < 0 ? p.ribbon : p.ribbon2, (1 - t / 24) * 0.9)
    }
  }

  // —— 头部 + 发丝(飘逸长发/高马尾) ——
  const hy = top + 8
  // 后发
  for (let y = hy - 6; y < hy + 20; y++)
    for (let x = cx - 9; x <= cx + 9; x++) {
      const d = Math.hypot((x - cx) * 1.0, (y - hy) * 0.85)
      if (d < 9) img.blend(x, y, p.hair, 0.92)
    }
  // 马尾(斜向飘)
  for (let t = 0; t < 24; t++) {
    const x = cx + 7 + t * 0.9 + Math.sin(frame * 1.0 + t * 0.15) * 1.5
    const y = hy - 2 + t * 0.55
    img.blend(x, y, p.hair, (1 - t / 26) * 0.9)
  }
  // 脸庞(暖肤)
  for (let y = hy - 2; y < hy + 8; y++)
    for (let x = cx - 4; x <= cx + 4; x++) {
      const d = Math.hypot(x - cx, y - (hy + 3))
      if (d < 4.5) img.blend(x, y, [240, 224, 214], 0.95)
    }
  // 眼部(细线 + 高光)
  img.blend(cx - 2, hy + 2, [80, 60, 80], 0.7)
  img.blend(cx + 2, hy + 2, [80, 60, 80], 0.7)
  img.blend(cx - 2.3, hy + 1.6, [255, 255, 255], 0.8)
  img.blend(cx + 1.7, hy + 1.6, [255, 255, 255], 0.8)

  // —— 头顶饰品(发光发饰/角) ——
  for (let s = -1; s <= 1; s += 2) {
    for (let t = 0; t < 8; t++) {
      const x = cx + s * (3 + t * 1.0)
      const y = hy - 12 + t * 0.8
      img.blend(x, y, p.trim, (1 - t / 9) * 0.95)
    }
  }
  img.radialGlow(cx, hy - 8, 8, p.glow, 0.4)

  // —— 全身外发光(柔) ——
  img.radialGlow(cx, 40, 26, p.glow, 0.35)
  // 脚下落点辉光
  img.radialGlow(cx, 80, 13, p.glow, 0.5)
}

const palettes = {
  lead: { robe: [226, 244, 244], robeDeep: [150, 206, 214], hair: [228, 244, 250], ribbon: [146, 210, 218], ribbon2: [120, 178, 200], trim: [255, 224, 150], glow: [150, 235, 226] },
  w0: { robe: [238, 226, 248], robeDeep: [166, 138, 208], hair: [144, 120, 176], ribbon: [206, 174, 234], ribbon2: [158, 128, 196], trim: [236, 214, 250], glow: [210, 178, 255] },
  w1: { robe: [250, 226, 224], robeDeep: [206, 142, 150], hair: [150, 96, 110], ribbon: [236, 172, 178], ribbon2: [196, 128, 144], trim: [255, 200, 200], glow: [255, 184, 194] },
  w2: { robe: [222, 244, 232], robeDeep: [132, 200, 176], hair: [108, 158, 142], ribbon: [176, 226, 204], ribbon2: [128, 190, 168], trim: [170, 240, 214], glow: [150, 240, 206] },
}

for (const [key, p] of Object.entries(palettes)) {
  const s = new Surface(FRAME_W * FRAMES, FRAME_H)
  for (let f = 0; f < FRAMES; f++) drawSpirit(s, f, p)
  // 每帧底部轻描一圈(避免整片连读成竖条)
  s.save(key === 'lead' ? 'wu-lead.png' : `wu-worker-${key.slice(1)}.png`)
}

console.log('Wuthering-Dusk assets written to', OUT_DIR)
