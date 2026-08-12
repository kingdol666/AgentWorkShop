/**
 * Tuxemon Town RPG demo — 端到端验证脚本(puppeteer-core 驱动 Edge)
 *
 * 验证项:
 *  1. 页面加载,Phaser canvas 出现,加载遮罩消失
 *  2. WASD 移动 -> HUD 坐标变化(相机跟随)
 *  3. 持续移动 -> 撞墙后坐标不再变化(碰撞检测)
 *  4. 寻路收集金币 -> coins 计数增加(overlap 收集)
 *  5. 靠近 NPC -> 交互提示 -> 空格对话 -> 打字机推进 -> 关闭(交互系统)
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = '.game-verify'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 从本地 Tiled JSON 构建 walkable 网格(World 层 + tileset collides 属性) */
function buildGrid() {
  const map = JSON.parse(readFileSync('public/assets/game/tuxemon-town.json', 'utf8'))
  const world = map.layers.find(l => l.name === 'World').data
  const collides = new Set(
    map.tilesets[0].tiles
      .filter(t => t.properties.some(p => p.name === 'collides' && p.value === true))
      .map(t => +t.id + 1),
  )
  const W = map.width
  const H = map.height
  const grid = Array.from({ length: H }, () => Array(W).fill(false))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      grid[y][x] = !collides.has(world[y * W + x])
    }
  }
  // NPC 占位视为障碍(immovable collider 会挡路)
  for (const [nx, ny] of [[15, 18], [27, 18], [3, 27]]) {
    grid[ny][nx] = false
  }
  return { grid, W, H }
}

/** BFS 最短路径,target 可为单点或"到达附近"的目标点 */
function bfs(grid, W, H, start, goal, near = 0) {
  if (start[0] === goal[0] && start[1] === goal[1])
    return []
  const dist = Array.from({ length: H }, () => Array(W).fill(-1))
  const prev = Array.from({ length: H }, () => Array(W).fill(null))
  const q = [start]
  dist[start[1]][start[0]] = 0
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  while (q.length) {
    const [cx, cy] = q.shift()
    if (Math.abs(cx - goal[0]) + Math.abs(cy - goal[1]) <= near)
      return reconstruct(prev, [cx, cy], start)
    for (const [dx, dy] of dirs) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H)
        continue
      if (!grid[ny][nx] || dist[ny][nx] !== -1)
        continue
      dist[ny][nx] = dist[cy][cx] + 1
      prev[ny][nx] = [cx, cy]
      q.push([nx, ny])
    }
  }
  return null
}

function reconstruct(prev, end, start) {
  const path = []
  let cur = end
  while (cur && !(cur[0] === start[0] && cur[1] === start[1])) {
    path.push(cur)
    cur = prev[cur[1]][cur[0]]
  }
  return path.reverse()
}

/** 从 HUD 读取坐标 [tileX, tileY] */
async function readPos(page) {
  const t = await page.$eval('[data-hud="pos"]', el => el.textContent.trim())
  return t.split(',').map(s => Number.parseInt(s, 10))
}
async function readCoins(page) {
  const t = await page.$eval('[data-hud="coins"]', el => el.textContent.trim())
  return Number.parseInt(t, 10)
}

/** BFS 寻路 + 按键沿路径逐 tile 移动(目标 tile 判定 + 卡死保护) */
async function moveTo(page, target, opts = {}) {
  const { timeoutMs = 30000, near = 0 } = opts
  const keyFor = (dx, dy) => (dx > 0 ? 'd' : dx < 0 ? 'a' : dy > 0 ? 's' : 'w')
  const start = Date.now()
  let stuckCount = 0
  while (Date.now() - start < timeoutMs) {
    const from = await readPos(page)
    if (from[0] === 0 && from[1] === 0) {
      await sleep(200)
      continue
    }
    const dx = target[0] - from[0]
    const dy = target[1] - from[1]
    if (Math.abs(dx) + Math.abs(dy) <= Math.max(1, near))
      return { ok: true, pos: from }
    // 每轮重建 grid:避免上一轮卡死标记污染路径
    const { grid: g, W: gw, H: gh } = buildGrid()
    const path = bfs(g, gw, gh, from, target, Math.max(1, near))
    if (!path || path.length === 0)
      return { ok: false, pos: from, reason: 'no path' }
    // 沿路径移动,每步走到目标 tile 即松开按键
    let movedAny = false
    for (const [gx, gy] of path.slice(0, 3)) {
      const key = keyFor(gx - from[0], gy - from[1])
      await page.keyboard.down(key)
      const stepStart = Date.now()
      let reached = false
      while (Date.now() - stepStart < 2500) {
        await sleep(60)
        const [cx, cy] = await readPos(page)
        if (cx === gx && cy === gy) {
          reached = true
          break
        }
      }
      await page.keyboard.up(key)
      await sleep(60)
      if (reached) {
        movedAny = true
        break
      }
      const now = await readPos(page)
      if (now[0] !== from[0] || now[1] !== from[1]) {
        movedAny = true
        break // 移动了但没到目标 tile,重算路径
      }
      // 未移动:反向退一步再重算(绕过意外障碍)
      const back = keyFor(from[0] - gx, from[1] - gy)
      if (back !== key) {
        await page.keyboard.down(back)
        await sleep(250)
        await page.keyboard.up(back)
        await sleep(60)
      }
      if (++stuckCount >= 5)
        return { ok: false, pos: await readPos(page), reason: 'stuck' }
    }
    if (!movedAny && ++stuckCount >= 5)
      return { ok: false, pos: await readPos(page), reason: 'stuck' }
  }
  return { ok: false, pos: await readPos(page), reason: 'timeout' }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
    defaultViewport: { width: 1400, height: 900 },
  })
  const page = await browser.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error')
      console.log('  [page console.error]', m.text().slice(0, 200))
  })

  // 1. 加载
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('canvas', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('[data-hud="loading"]'), { timeout: 20000 })
  // 场景就绪 = 坐标从占位 0,0 变为出生点
  await page.waitForFunction(() => document.querySelector('[data-hud="pos"]')?.textContent.trim() !== '0,0', { timeout: 15000 })
  const hasCanvas = await page.$('canvas') !== null
  check('页面加载 + Phaser canvas 创建', hasCanvas)
  check('加载遮罩消失(场景就绪)', true)

  const [sx, sy] = await readPos(page)
  check('HUD 坐标渲染', sx >= 0 && sy >= 0, `spawn tile ${sx},${sy}`)

  await page.screenshot({ path: `${SHOT_DIR}/01-spawn.png` })
  // 等待 FPS 自计数累计窗口(1s)后读取
  await sleep(1800)
  const fpsText = await page.$eval('[data-hud="fps"]', el => el.textContent)
  check('FPS 显示', /FPS/.test(fpsText), fpsText.trim())

  // 2. 移动 + 相机跟随
  await page.keyboard.down('d')
  await sleep(700)
  await page.keyboard.up('d')
  const [mx, my] = await readPos(page)
  check('WASD 移动生效', mx !== sx, `tile ${sx},${sy} -> ${mx},${my}`)

  // 3. 碰撞检测:朝出生点上方(sy 减小)持续移动,应撞到墙/边界后停住
  const [w0x, w0y] = await readPos(page)
  let last = [w0x, w0y]
  let stoppedAt = null
  for (let i = 0; i < 25; i++) {
    await page.keyboard.down('w')
    await sleep(200)
    await page.keyboard.up('w')
    await sleep(60)
    const [cx, cy] = await readPos(page)
    if (cx === last[0] && cy === last[1]) {
      stoppedAt = [cx, cy]
      break
    }
    last = [cx, cy]
  }
  check('碰撞检测:持续移动被阻挡', stoppedAt !== null, `blocked at ${stoppedAt}`)

  // 4. 金币收集:回出生点附近取 3 枚已知金币
  const coinTiles = [[32, 4], [3, 10], [36, 9]] // 与场景 COIN_SPOTS 对应的 tile
  const coinsBefore = await readCoins(page)
  for (const ct of coinTiles) {
    const r = await moveTo(page, ct, { timeoutMs: 30000 })
    if (!r.ok)
      continue
    await sleep(500) // overlap 触发
    const c = await readCoins(page)
    if (c > coinsBefore) {
      console.log(`  collected coin at ${ct}: total ${c}`)
    }
    await page.screenshot({ path: `${SHOT_DIR}/02-coin-${c}.png` })
  }
  const coinsFinal = await readCoins(page)
  check('金币 overlap 收集', coinsFinal - coinsBefore >= 2, `+${coinsFinal - coinsBefore} coins (${coinsBefore} -> ${coinsFinal})`)

  // 5. NPC 对话:靠近 tux (tile 15,18)
  const npcTile = [15, 18]
  const r = await moveTo(page, npcTile, { timeoutMs: 30000, near: 1 })
  check('寻路抵达 NPC 附近', r.ok, `pos ${r.pos}`)
  await sleep(500)
  const npcHint = await page.$('[data-hud="npc-near"]') !== null
  check('NPC 近身交互提示出现', npcHint)
  await page.screenshot({ path: `${SHOT_DIR}/03-npc-near.png` })

  await page.keyboard.press('Space')
  await sleep(400)
  const dialogOpen = await page.$('[data-hud="dialog"]') !== null
  check('空格触发对话框', dialogOpen)
  await page.screenshot({ path: `${SHOT_DIR}/04-dialog.png` })

  // 打字机推进:等第一句打完,空格 -> 下一句
  await sleep(2500)
  const lineText1 = await page.$eval('[data-hud="dialog"]', el => el.textContent)
  await page.keyboard.press('Space')
  await sleep(600)
  const lineText2 = await page.$eval('[data-hud="dialog"]', el => el.textContent)
  check('台词推进(下一句)', lineText2 !== lineText1, 'dialog content changed')
  await page.screenshot({ path: `${SHOT_DIR}/05-dialog-next.png` })

  // 关闭对话
  await page.keyboard.press('Space')
  await sleep(400)
  await page.keyboard.press('Space')
  await sleep(400)
  const dialogClosed = await page.$('[data-hud="dialog"]') === null
  check('对话框关闭', dialogClosed)

  // 关闭后玩家可继续移动
  const [p1, p2] = await readPos(page)
  await page.keyboard.down('a')
  await sleep(400)
  await page.keyboard.up('a')
  const [q1, q2] = await readPos(page)
  check('对话后恢复移动', p1 !== q1 || p2 !== q2, `tile ${p1},${p2} -> ${q1},${q2}`)

  await page.screenshot({ path: `${SHOT_DIR}/06-final.png` })

  await browser.close()

  const failed = results.filter(x => !x.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('VERIFY CRASH:', e)
  process.exit(2)
})
