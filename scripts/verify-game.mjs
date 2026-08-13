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

/** Agent 当前 tile 与像素位置(调试钩子) */
async function agentPos(page) {
  return page.evaluate(() => {
    const s = window.__game.scene.getDebugState()
    return { x: Math.round(s.agent.x / 32), y: Math.round(s.agent.y / 32), px: s.agent.x, py: s.agent.y }
  })
}

/** 追逐移动中的 Agent:多轮 BFS 追赶,直到触发后端对话;未果则传送兜底 */
async function chaseAgent(page) {
  let last = { ok: false, pos: null }
  for (let round = 0; round < 3; round++) {
    const a = await agentPos(page)
    if (process.env.DEBUG_CHASE) {
      console.log(`  [chase] round ${round} agent=(${a.x},${a.y}) px=(${a.px},${a.py}) player=${await readPos(page)}`)
    }
    last = await moveTo(page, [a.x, a.y], { timeoutMs: 20000, near: 1, dismissDialog: false })
    if (process.env.DEBUG_CHASE) {
      console.log(`  [chase] moveTo -> ${last.ok} ${last.reason ?? ''} pos=${last.pos}`)
    }
    // 玩家已贴近:等后端 tick 触发 dialog(agent 会自行迎上)
    for (let i = 0; i < 10; i++) {
      const dlg = await page.$('[data-hud="dialog"]') !== null
      if (dlg) {
        return { ok: true, pos: last.pos ?? [a.x, a.y] }
      }
      await sleep(400)
    }
    if (last.ok) {
      const now = await agentPos(page)
      const player = await readPos(page)
      const pdist = Math.hypot(player[0] - now.x, player[1] - now.y)
      if (pdist <= 3) {
        return { ok: true, pos: last.pos }
      }
    }
  }

  // ---- 传送兜底:玩家放到 Agent 旁 2 tiles,立即上行 player.pos ----
  // 走真实协议闭环:player.pos → 大脑感知(≤3 tiles) → dialog.open,绕开追移动目标的不确定性
  const a2 = await agentPos(page)
  const side = a2.x <= 36 ? 2 : -2
  const tpx = (a2.x + side) * 32 + 16
  const tpy = a2.y * 32 + 16
  console.log(`  [chase] teleport fallback: agent=(${a2.x},${a2.y}) -> player px=(${tpx},${tpy})`)
  await page.evaluate(({ x, y }) => window.__game.scene.setDebugPos(x, y), { x: tpx, y: tpy })
  for (let i = 0; i < 15; i++) {
    const dlg = await page.$('[data-hud="dialog"]') !== null
    if (dlg) {
      return { ok: true, pos: [a2.x, a2.y] }
    }
    await sleep(400)
  }
  return last
}

/** 全量释放所有移动键(headless 偶发 keyup 丢失,强制重置 Phaser 键状态) */
async function releaseAllKeys(page) {
  for (const k of ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    await page.keyboard.up(k)
  }
}

/** BFS 寻路 + 注入式导航:每 60ms 注入方向向量,由游戏物理/碰撞驱动(E2E 专用入口,绕开 headless 键盘缺陷) */
async function moveTo(page, target, opts = {}) {
  const { timeoutMs = 30000, near = 0, dismissDialog = true } = opts
  const dirTo = (from, to) => {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    if (Math.abs(dx) >= Math.abs(dy)) {
      return [dx >= 0 ? 1 : -1, 0]
    }
    return [0, dy >= 0 ? 1 : -1]
  }
  const start = Date.now()
  let stuckCount = 0
  while (Date.now() - start < timeoutMs) {
    // 自愈(仅非对话场景):玩家靠近 Agent 可能触发对话锁定移动,空格推进关闭
    if (dismissDialog) {
      for (let i = 0; i < 6; i++) {
        const dlg = await page.$('[data-hud="dialog"]') !== null
        if (!dlg)
          break
        await page.keyboard.up('Space')
        await page.keyboard.down('Space')
        await page.keyboard.up('Space')
        await sleep(500)
      }
    }
    const from = await readPos(page)
    if (!Number.isFinite(from[0]) || !Number.isFinite(from[1])) {
      const dbg = await page.evaluate(() => {
        const s = window.__game.scene
        const p = s?.player
        const b = p?.body
        const hudPos = document.querySelector('[data-hud="pos"]')?.textContent
        return {
          hudPos,
          frameCount: s?.frameCount,
          ticks: window.__updTicks ?? null,
          playerX: p?.x,
          playerY: p?.y,
          playerHasOwn: p ? Object.prototype.hasOwnProperty.call(p, 'x') : null,
          body: b ? { x: b.x, y: b.y, vx: b.velocity?.x, vy: b.velocity?.y, enable: b.enable } : null,
          vis: document.visibilityState,
          game: window.__game.game ? { paused: window.__game.game.isPaused, running: window.__game.game.isRunning, hidden: window.__game.game.isHidden } : null,
          keys: s ? { w: s.keyW?.isDown, a: s.keyA?.isDown, s: s.keyS?.isDown, d: s.keyD?.isDown } : null,
          agent: (() => {
            try {
              return s?.getDebugState()?.agent
            }
            catch {
              return null
            }
          })(),
        }
      })
      console.log(`  [move] NaN pos! ${JSON.stringify(dbg)}`)
      await page.evaluate(() => window.__game.scene?.setDebugMove?.(null))
      return { ok: false, pos: from, reason: 'nan' }
    }
    if (from[0] === 0 && from[1] === 0) {
      await sleep(200)
      continue
    }
    if (process.env.DEBUG_MOVE) {
      console.log(`  [move] from ${from} target ${target}`)
    }
    await releaseAllKeys(page)
    const dx = target[0] - from[0]
    const dy = target[1] - from[1]
    if (Math.abs(dx) + Math.abs(dy) <= Math.max(1, near)) {
      await page.evaluate(() => window.__game.scene.setDebugMove(null))
      return { ok: true, pos: from }
    }
    // 每轮重建 grid:避免上一轮卡死标记污染路径
    // (Agent 与玩家无碰撞,物理上可穿过,不作为障碍标记)
    const { grid: g, W: gw, H: gh } = buildGrid()
    const path = bfs(g, gw, gh, from, target, Math.max(1, near))
    if (!path || path.length === 0) {
      await page.evaluate(() => window.__game.scene.setDebugMove(null))
      return { ok: false, pos: from, reason: 'no path' }
    }
    // 沿路径前 3 步注入方向,每步到达目标 tile 即换向
    let movedAny = false
    for (const [gx, gy] of path.slice(0, 3)) {
      const [vx, vy] = dirTo(from, [gx, gy])
      await page.evaluate(d => window.__game.scene.setDebugMove({ dx: d[0], dy: d[1] }), [vx, vy])
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
      await page.evaluate(() => window.__game.scene.setDebugMove(null))
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
      // 未移动(顶墙/被挡):反向退一步再重算
      const [bvx, bvy] = dirTo(from, [gx, gy]).map(v => -v)
      await page.evaluate(d => window.__game.scene.setDebugMove({ dx: d[0], dy: d[1] }), [bvx, bvy])
      await sleep(250)
      await page.evaluate(() => window.__game.scene.setDebugMove(null))
      await sleep(60)
      if (++stuckCount >= 5) {
        console.log(`  [stuck] pos ${await readPos(page)}`)
        return { ok: false, pos: await readPos(page), reason: 'stuck' }
      }
    }
    if (!movedAny && ++stuckCount >= 5) {
      console.log(`  [stuck] pos ${await readPos(page)}`)
      return { ok: false, pos: await readPos(page), reason: 'stuck' }
    }
  }
  await page.evaluate(() => window.__game.scene.setDebugMove(null))
  return { ok: false, pos: await readPos(page), reason: 'timeout' }
}

async function waitPageReady(page) {
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('canvas', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('[data-hud="loading"]'), { timeout: 20000 })
  await page.waitForFunction(() => document.querySelector('[data-hud="pos"]')?.textContent.trim() !== '0,0', { timeout: 15000 })
}

/** 单轮完整流程;headless 渲染环境偶发冻结时返回 completed:false 触发重试 */
async function runOnce(page) {
  await waitPageReady(page)
  const hasCanvas = await page.$('canvas') !== null
  check('页面加载 + Phaser canvas 创建', hasCanvas)

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
  {
    const dbg = await page.evaluate(() => {
      const s = window.__game.scene
      const p = s.player
      return {
        ok: !!p && Number.isFinite(p.x),
        player: { x: p?.x, y: p?.y },
        body: p?.body ? { x: p.body.x, y: p.body.y, enable: p.body.enable } : null,
      }
    })
    console.log(`  [pre-coin] ${JSON.stringify(dbg)}`)
  }
  const coinTiles = [[3, 10], [23, 10], [11, 18]] // 与场景 COIN_SPOTS 对应(BFS 连通性验证过的可达点)
  const coinsBefore = await readCoins(page)
  for (const ct of coinTiles) {
    const r = await moveTo(page, ct, { timeoutMs: 30000 })
    if (!r.ok) {
      console.log(`  coin ${ct} moveTo failed: ${r.reason ?? 'unknown'} @ ${r.pos}`)
      if (r.reason === 'nan') {
        console.log('  → 游戏环境冻结,终止本轮')
        return { completed: false }
      }
      continue
    }
    await sleep(500) // overlap 触发
    const c = await readCoins(page)
    if (c > coinsBefore) {
      console.log(`  collected coin at ${ct}: total ${c}`)
    }
    await page.screenshot({ path: `${SHOT_DIR}/02-coin-${c}.png` })
  }
  const coinsFinal = await readCoins(page)
  check('金币 overlap 收集', coinsFinal - coinsBefore >= 2, `+${coinsFinal - coinsBefore} coins (${coinsBefore} -> ${coinsFinal})`)

  // 5. 后端 Agent 链路:WS 连接 → 指令驱动 → 对话
  await page.waitForFunction(() => (window.__game?.client?.connected) === true, { timeout: 15000 })
  check('WS 连接建立', true)
  const modeText = await page.$eval('[data-hud="agent-mode"]', el => el.textContent)
  check('Agent 状态徽标渲染', /Agent/.test(modeText), modeText.trim())

  // Agent 被指令驱动:位置变化 或 收到新的 move 指令(approach 顶墙时位置不动但指令持续下发)
  const ap1 = await agentPos(page)
  let agentDriven = false
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const now = await agentPos(page)
    if (now.px !== ap1.px || now.py !== ap1.py || now.moveCount > ap1.moveCount) {
      agentDriven = true
      break
    }
  }
  check('Agent 被后端指令驱动移动', agentDriven,
    `(${ap1.px},${ap1.py}) moveCount ${ap1.moveCount} -> ${(await agentPos(page)).moveCount}`)
  await page.screenshot({ path: `${SHOT_DIR}/03-agent-wander.png` })

  // agent.say 气泡(等待出现,最多 8s)
  let bubble = null
  for (let i = 0; i < 16; i++) {
    bubble = await page.evaluate(() => window.__game.scene.getDebugState().lastBubble)
    if (bubble && Date.now() - bubble.at < 4000)
      break
    await sleep(500)
  }
  check('Agent 气泡下发(agent.say)', bubble !== null && bubble.text.length > 0, bubble?.text ?? 'none')
  await page.screenshot({ path: `${SHOT_DIR}/04-agent-say.png` })

  // 追逐 Agent,触发后端对话
  const chased = await chaseAgent(page)
  if (!chased.ok && String(chased.reason) === 'nan') {
    console.log('  → 游戏环境冻结,终止本轮')
    return { completed: false }
  }
  check('玩家靠近 Agent', chased.ok, `pos ${chased.pos ?? 'failed'}`)
  await sleep(800)
  const dialogOpen = await page.$('[data-hud="dialog"]') !== null
  check('后端 dialog.open 下发', dialogOpen)
  await page.screenshot({ path: `${SHOT_DIR}/05-agent-dialog.png` })

  // 空格 → input.interact 上行 → dialog.advance 下行(3 句后 close)
  const lineText1 = await page.$eval('[data-hud="dialog"]', el => el.textContent)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Space')
    await sleep(900)
  }
  const dialogClosed = await page.$('[data-hud="dialog"]') === null
  check('对话推进并关闭', dialogClosed, `before: ${lineText1.slice(0, 24)}…`)
  await page.screenshot({ path: `${SHOT_DIR}/06-agent-dialog-closed.png` })

  // Agent 进入等待模式(对话关闭事件驱动)
  await sleep(500)
  const modeAfter = await page.$eval('[data-hud="agent-mode"]', el => el.textContent)
  check('Agent 进入等待模式', /等待/.test(modeAfter), modeAfter.trim())

  // 关闭后玩家可继续移动
  const [p1, p2] = await readPos(page)
  await page.keyboard.down('a')
  await sleep(400)
  await page.keyboard.up('a')
  const [q1, q2] = await readPos(page)
  check('对话后恢复移动', p1 !== q1 || p2 !== q2, `tile ${p1},${p2} -> ${q1},${q2}`)

  await page.screenshot({ path: `${SHOT_DIR}/07-final.png` })
  return { completed: true }
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
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || (m.type() === 'log' && /\[game\]|\[rpg\]/.test(m.text()))) {
      console.log(`  [page ${m.type()}]`, m.text().slice(0, 400))
    }
  })

  // headless 渲染/截图组合偶发冻结:健康失败自动重载重试(最多 3 轮)
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`\n===== E2E attempt ${attempt}/3 =====`)
    const r = await runOnce(page, attempt)
    if (r.completed) {
      break
    }
    if (attempt < 3) {
      console.log('  → 环境冻结,重载页面重试')
    }
  }

  await browser.close()

  const failed = results.filter(x => !x.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('VERIFY CRASH:', e)
  process.exit(2)
})
