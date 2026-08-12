/**
 * 将 public/assets/game/player/ 下的单帧 PNG 拼合为一张 4 方向 RPG spritesheet。
 *
 * 布局(帧尺寸 16x32):
 *   行: down / left / right / up
 *   列: idle + 4 帧行走循环
 *
 * 输出: public/assets/game/player-sheet.png (80x128)
 * 用法: node scripts/build-player-sheet.mjs
 */
import { PNG } from 'pngjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(root, 'public/assets/game/player')
const outFile = resolve(root, 'public/assets/game/player-sheet.png')

// 行序 -> 方向前缀,列序 -> 帧名
const ROWS = [
  { dir: 'front', frames: ['misa-front', 'misa-front-walk.000', 'misa-front-walk.001', 'misa-front-walk.002', 'misa-front-walk.003'] },
  { dir: 'left', frames: ['misa-left', 'misa-left-walk.000', 'misa-left-walk.001', 'misa-left-walk.002', 'misa-left-walk.003'] },
  { dir: 'right', frames: ['misa-right', 'misa-right-walk.000', 'misa-right-walk.001', 'misa-right-walk.002', 'misa-right-walk.003'] },
  { dir: 'back', frames: ['misa-back', 'misa-back-walk.000', 'misa-back-walk.001', 'misa-back-walk.002', 'misa-back-walk.003'] },
]

const FW = 16
const FH = 32
const COLS = ROWS[0].frames.length
const sheet = new PNG({ width: FW * COLS, height: FH * ROWS.length })

for (let r = 0; r < ROWS.length; r++) {
  for (let c = 0; c < COLS; c++) {
    const name = ROWS[r].frames[c]
    const file = resolve(srcDir, `${name}.png`)
    if (!existsSync(file)) {
      throw new Error(`缺少帧文件: ${file}`)
    }
    const png = PNG.sync.read(readFileSync(file))
    if (png.width !== FW || png.height !== FH) {
      throw new Error(`帧尺寸不符 ${name}: ${png.width}x${png.height}`)
    }
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const si = (y * png.width + x) * 4
        const di = ((r * FH + y) * sheet.width + (c * FW + x)) * 4
        sheet.data[di] = png.data[si]
        sheet.data[di + 1] = png.data[si + 1]
        sheet.data[di + 2] = png.data[si + 2]
        sheet.data[di + 3] = png.data[si + 3]
      }
    }
  }
}

writeFileSync(outFile, PNG.sync.write(sheet))
console.log(`已生成 ${outFile} (${sheet.width}x${sheet.height})`)
