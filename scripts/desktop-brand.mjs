#!/usr/bin/env node
/**
 * 从仓库内的 SVG 母版重建所有应用图标(不手导出二进制):
 *
 *   desktop/brand/badge.svg      → desktop/build/icon.png (512) + icon.ico (16–256)
 *                                → public/icon-180.png / icon-192.png / icon-512.png
 *   desktop/brand/tray-dark.svg  → desktop/build/tray-dark.png  (32, 深色任务栏用信号绿)
 *   desktop/brand/tray-light.svg → desktop/build/tray-light.png (32, 浅色任务栏用深玉绿)
 *
 * 位图由本机 Chrome 以目标尺寸直接光栅化(矢量按目标像素栅格化,不是先大后缩),
 * ICO 由本脚本按微软 ICO 容器规范封装:≤64 用 32bpp BITMAPINFOHEADER 条目(旧工具链
 * 兼容),128/256 用 PNG 压缩条目。改图标只需改 SVG 再跑:
 *
 *   node scripts/desktop-brand.mjs
 *
 * 需要本机 Chrome;路径可用 AW_CHROME 覆盖。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const puppeteer = require('puppeteer-core')

const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
/** ICO 条目格式分界:超过该边长的条目用 PNG 压缩,其余用 BMP(旧版 NSIS/资源管理器都认)。 */
const BMP_MAX_SIZE = 64

const brand = path => join(root, 'desktop', 'brand', path)
const build = path => join(root, 'desktop', 'build', path)
const pub = path => join(root, 'public', path)

/** 以 32bpp BMP 条目封装一张 RGBA 位图(底朝上、BGRA + 全零 AND 掩码)。 */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // 高度字段含 XOR 图与 AND 掩码两层
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const sourceRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const from = sourceRow + x * 4
      const to = (y * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)
  return Buffer.concat([header, pixels, mask])
}

/** 按 ICO 目录格式打包:6 字节头 + 每图 16 字节目录项 + 图像数据。 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const at = index * 16
    const dimension = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt8(dimension, at)
    directory.writeUInt8(dimension, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, directory, ...entries.map(entry => entry.data)])
}

/** 在渲染页里把 SVG 按目标尺寸画进 canvas,返回 PNG 字节与原始 RGBA。 */
async function rasterize(page, markup, sizes) {
  return page.evaluate(async (svg, list) => {
    const bytes = new TextEncoder().encode(svg)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    }
    const image = new Image()
    image.src = `data:image/svg+xml;base64,${btoa(binary)}`
    await image.decode()
    const result = {}
    for (const size of list) {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(image, 0, 0, size, size)
      const pixels = context.getImageData(0, 0, size, size).data
      let raw = ''
      for (let i = 0; i < pixels.length; i += 8192) {
        raw += String.fromCharCode(...pixels.subarray(i, i + 8192))
      }
      result[size] = {
        png: canvas.toDataURL('image/png').split(',')[1],
        rgba: raw,
      }
    }
    return result
  }, markup, sizes)
}

async function writePng(source, size, target) {
  const png = Buffer.from(source[size].png, 'base64')
  await writeFile(target, png)
  console.log(`  ${target.slice(root.length + 1)}  ${size}×${size}  ${png.length} B`)
}

async function run() {
  const [badge, trayDark, trayLight] = await Promise.all([
    readFile(brand('badge.svg'), 'utf8'),
    readFile(brand('tray-dark.svg'), 'utf8'),
    readFile(brand('tray-light.svg'), 'utf8'),
  ])
  await mkdir(build(''), { recursive: true })

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb'],
    protocolTimeout: 120_000,
  })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank')

    const badgeImages = await rasterize(page, badge, [...new Set([...ICO_SIZES, 180, 512])])
    const icoEntries = ICO_SIZES.map(size => ({
      size,
      data: size <= BMP_MAX_SIZE
        ? bmpEntry(size, Buffer.from(badgeImages[size].rgba, 'base64'))
        : Buffer.from(badgeImages[size].png, 'base64'),
    }))
    const ico = buildIco(icoEntries)
    await writeFile(build('icon.ico'), ico)
    console.log(`  desktop/build/icon.ico  ${ICO_SIZES.length} entries  ${ico.length} B`)
    await writePng(badgeImages, 512, build('icon.png'))
    await writePng(badgeImages, 180, pub('icon-180.png'))
    await writePng(badgeImages, 512, pub('icon-512.png'))

    const tray = await rasterize(page, trayDark, [32])
    await writePng(tray, 32, build('tray-dark.png'))
    const trayOnLight = await rasterize(page, trayLight, [32])
    await writePng(trayOnLight, 32, build('tray-light.png'))
  }
  finally {
    await browser.close()
  }
  console.log('brand assets rebuilt from desktop/brand/*.svg')
}

run().catch((error) => {
  console.error(`icon build failed: ${error.message}`)
  process.exitCode = 1
})
