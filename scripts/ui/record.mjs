/**
 * 真实流程录屏 → GIF(README / 文档站用)。
 *
 * 为什么不用现成录屏工具:这些 GIF 要展示的是**系统的真实行为**
 * (Agent 真的在跑、DAQ 数值真的在变),所以必须是一段"操作剧本"驱动真实页面,
 * 再逐帧采集。所有帧都来自 127.0.0.1:3021 上跑着的真服务,没有任何摆拍。
 *
 * 管线: puppeteer 定频截图 → ffmpeg palettegen/paletteuse → 有界 GIF
 *
 * 用法: node scripts/ui/record.mjs <story> [--out docs/readme-assets] [--w 1440] [--h 900]
 *       node scripts/ui/record.mjs --list
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureVisualUser, api, launch, openPage, gotoReady, sleep } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const OUT = arg('out', 'docs/readme-assets')
const W = Number(arg('w', 1440))
const H = Number(arg('h', 900))
const FPS = Number(arg('fps', 12))
const GIF_W = Number(arg('gifw', 960))

const token = await ensureVisualUser()

/** 找到示范产线的频道(seed-demo.mjs 建的) */
async function demoChannels() {
  const r = await api('GET', '/api/workshop/channels', { token })
  const list = r.data?.channels ?? r.data ?? []
  return Array.isArray(list) ? list : []
}

/* ─────────────────────────── 剧本 ─────────────────────────── */

const STORIES = {
  /** 01 · Agent 团队真实跑一次任务:派发 → 拆解 → 并行执行 → 三个视图收敛 */
  agents: {
    title: 'Agent 团队执行任务',
    async run(page, play) {
      const chs = await demoChannels()
      const ch = chs.find(c => c.name === '熔温优化') ?? chs[0]
      if (!ch) throw new Error('没有可用频道,先跑 scripts/ui/seed-demo.mjs')
      const cid = ch.channelId ?? ch.id
      // ⚠️ 路由参数是 **workspaceId**,不是 channelId(/workshop/w/:wsId 里
      //    channelId 由活动工作区推导)。传 channelId 会落到空壳上。
      const wsRes = await api('GET', '/api/workshop/workspaces', { token })
      const wsList = wsRes.data?.workspaces ?? wsRes.data ?? []
      const wid = (Array.isArray(wsList) ? wsList[0] : null)?.id
      if (!wid) throw new Error('没有工作区,先跑 scripts/ui/seed-demo.mjs')

      await gotoReady(page, `/workshop/w/${wid}`, { wait: 4500 })
      await play(1500)

      const goal = '分析 1 号挤出线的熔体温度趋势,给出把温控设定值下调 5°C 的依据与风险。'
      // 用**和界面同一个 REST 入口**派发任务,而不是往 composer 里模拟打字:
      // 富文本 composer 的首个 textarea 未必是它本体(踩过:录了 30 秒空时间线),
      // 而"事件真的在流"才是这段 GIF 要证明的东西。
      const sent = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
        token,
        body: { title: goal, mode: 'goal', fromLabel: 'visual' },
      })
      if (sent.code !== 0) console.log('  ⚠ 派发失败:', JSON.stringify(sent).slice(0, 160))
      await play(9000)

      // 依次切到 Agent lanes / 任务板,展示"同一批事件的不同切面"
      for (const tab of ['Agent lanes', '任务板', '时间线']) {
        await page.evaluate((label) => {
          const el = Array.from(document.querySelectorAll('button, .aw-seg button, [role="tab"]'))
            .find(b => (b.textContent || '').trim() === label)
          el?.click()
        }, tab)
        await play(tab === '任务板' ? 7000 : 6000)
      }
      await play(4000)
    },
  },

  /** 02 · 数采实时链路:节点在线、读数跳动、趋势成形 */
  daq: {
    title: 'DAQ 实时采集',
    async run(page, play) {
      await gotoReady(page, '/daq', { wait: 4500 })
      await play(6000)
      // 展开「实时事件」流,展示消息在滚动
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('*'))
        const t = els.find(e => e.children.length === 0 && (e.textContent || '').includes('实时事件'))
        t?.scrollIntoView({ block: 'center' })
      })
      await play(7000)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await play(3500)
    },
  },

  /** 03 · 产线作业:节点卡片 + 展开一条产线看工艺链 */
  dcw: {
    title: '产线作业与写控制',
    async run(page, play) {
      await gotoReady(page, '/dcw', { wait: 4500 })
      await play(4000)
      await page.evaluate(() => window.scrollBy({ top: 260, behavior: 'smooth' }))
      await play(4500)
      await page.evaluate(() => window.scrollBy({ top: -260, behavior: 'smooth' }))
      await play(3000)
    },
  },

  /** 04 · 数字孪生:真实遥测驱动的 3D 产线 */
  town: {
    title: '三维数字孪生',
    async run(page, play) {
      await gotoReady(page, '/town', { wait: 9000 })
      await play(9000)
      // 缓慢平移视角(鼠标拖拽画布中心)
      const box = await page.evaluate(() => {
        const c = document.querySelector('canvas')
        if (!c) return null
        const r = c.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      if (box) {
        await page.mouse.move(box.x, box.y)
        await page.mouse.down()
        for (let i = 0; i < 24; i++) {
          await page.mouse.move(box.x - i * 6, box.y - i * 1.2)
          await play(60)
        }
        await page.mouse.up()
      }
      await play(8000)
    },
  },

  /** 05 · 仪表盘:全局 KPI 与趋势 */
  dashboard: {
    title: '运行总览仪表盘',
    async run(page, play) {
      await gotoReady(page, '/', { wait: 5000 })
      await play(8000)
      await page.evaluate(() => window.scrollBy({ top: 420, behavior: 'smooth' }))
      await play(7000)
    },
  },

  /** 06 · 响应式:同一套界面在桌面 / 平板 / 手机上的形态 */
  responsive: {
    title: '自适应:桌面 / 平板 / 手机',
    async run(page, play) {
      await gotoReady(page, '/daq', { wait: 5000 })
      await play(2500)
      const steps = [
        { w: 1024, h: 768, wait: 2000 },
        { w: 768, h: 1024, wait: 2000 },
        { w: 390, h: 844, wait: 2400 },
      ]
      for (const s of steps) {
        await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 1 })
        await play(s.wait)
      }
      // 手机上拉开抽屉导航
      await page.evaluate(() => {
        document.querySelector('.collapse-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await play(3000)
    },
  },
}

// 剧本名 = 第一个**是已知剧本**的位置参数。
// (不能只判"前一个参数不是 --flag":首位参数的前一个参数是 undefined,
//  会被误判成"某个 flag 的值",于是永远解析不出剧本名 —— 实测踩过。)
const storyName = argv.find(a => !a.startsWith('--') && Object.hasOwn(STORIES, a))

if (argv.includes('--list') || !storyName || !STORIES[storyName]) {
  console.log('可用剧本:')
  for (const [k, v] of Object.entries(STORIES)) console.log(`  ${k.padEnd(12)} ${v.title}`)
  process.exit(0)
}

/* ─────────────────────── 采集 + 合成 ─────────────────────── */

const tmp = path.join('.e2e-shots', 'gif-frames', storyName)
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
// 输出目录必须显式建:ffmpeg 不会替你 mkdir,它会以 "Could not open file" 失败,
// 而 -loglevel error 下错误只出现在 stderr 末尾,很容易被误读成编码参数错误(实测踩过)。
fs.mkdirSync(OUT, { recursive: true })

const browser = await launch()
const page = await openPage(browser, { token, dark: true, width: W, height: H, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)))

let n = 0
let stopped = false
/** 播放一段"时间":按 FPS 定频采样,长度 = ms */
async function play(ms) {
  const frames = Math.max(1, Math.round((ms / 1000) * FPS))
  for (let i = 0; i < frames && !stopped; i++) {
    try {
      await page.screenshot({ path: path.join(tmp, `f${String(n++).padStart(5, '0')}.png`) })
    }
    catch { /* 过渡帧丢失可接受 */ }
    await sleep(Math.round(1000 / FPS))
  }
}

console.log(`▶ 录制「${STORIES[storyName].title}」…`)
await STORIES[storyName].run(page, play)
stopped = true
await browser.close()
console.log(`  帧数 ${n}`)

const gif = path.join(OUT, `${storyName}.gif`)
const vf = `fps=${FPS},scale=${GIF_W}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%05d.png'), '-vf', vf, '-loop', '0', gif], { stdio: 'inherit' })
const size = fs.statSync(gif).size
console.log(`✔ ${gif} (${(size / 1024 / 1024).toFixed(2)} MB, ${n} 帧)`)
if (errs.length) console.log('  ⚠ page errors:', errs.slice(0, 4))
