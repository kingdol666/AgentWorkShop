/**
 * 下行指令渲染验证 — puppeteer-core 驱动 Edge + HTTP 注入 execDownlink
 *
 * 验证矩阵:
 *  1. 规范下行指令 → 前端正确渲染(HUD 文本/动画状态/对话框):
 *     - agent.say    → Agent 头顶气泡(截图可见)
 *     - dialog.open  → [data-hud="dialog"] 可见 + agentName/lines 正确
 *     - dialog.close → 对话框消失
 *     - agent.state  → [data-hud="agent-mode"] 文本变化(待机→游荡→靠近→对话→等待)
 *     - agent.face   → 精灵朝向(截图可见)
 *     - agent.move   → 精灵位移(__game 场景坐标变化)
 *  2. 不规范下行指令 → execDownlink 拒绝(FORBIDDEN/INVALID_PAYLOAD/UNKNOWN_COMMAND),
 *     前端无变化(对话框未异常打开、HUD 模式不跳变)
 *
 * 注入路径: POST /api/game/cmd { type, payload } → session.execDownlink → emit → WS → 前端
 *           即真实 Agent sendmsg 入口,全链路真实。
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = '.game-verify'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fail += 1
}
/** POST /api/game/cmd 注入下行指令,返回归一化结果 { ok, applied?, code?, message? }
 * defineApiHandler 成功时包成 { code:0, data:{applied,...} },失败时为 { code:ErrCode, message } */
async function injectCmd(page, type, payload) {
  const res = await page.evaluate(async ({ type, payload }) => {
    const r = await fetch('/api/game/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    })
    return r.json()
  }, { type, payload })
  if (res.code === 0) {
    return { ok: true, applied: res.data?.applied === true, type: res.data?.type }
  }
  return { ok: false, code: res.code, message: res.message }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 读 Agent 模式 HUD 文本 */
async function agentMode(page) {
  return page.$eval('[data-hud="agent-mode"]', el => el.textContent.trim())
}

/** 对话框是否可见 */
async function dialogVisible(page) {
  // 用 evaluate 而非 page.$:避免 Transition leave 动画期残留 ElementHandle 的竞态
  return page.evaluate(() => document.querySelector('[data-hud="dialog"]') !== null)
}

/** Agent 精灵像素坐标(经调试钩子) */
async function agentPx(page) {
  return page.evaluate(() => {
    const s = window.__game.scene
    return { x: Math.round(s.agent.x), y: Math.round(s.agent.y), flipX: s.agent.flipX }
  })
}

async function waitPageReady(page) {
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('canvas', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('[data-hud="loading"]'), { timeout: 25000 })
  await sleep(1500) // 等 session.ready + agent 放置
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
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)))

  console.log('\n=== 下行指令渲染验证 ===')
  await waitPageReady(page)
  // 暂停自主 brain:让下行指令渲染验证不受模拟 Agent 自发对话/移动干扰
  await page.evaluate(async () => {
    await fetch('/api/game/brain?pause=true', { method: 'POST' })
  })
  await sleep(300)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-01-baseline.png` })

  // ---------------- 1. 规范下行指令渲染 ----------------
  console.log('\n--- 1. 规范下行指令 → 渲染 ---')

  // agent.say: 气泡(截图 + applied)
  const say = await injectCmd(page, 'agent.say', { text: '协议测试气泡', ttlMs: 3000 })
  check('agent.say 注入 applied=true', say.applied === true, JSON.stringify(say))
  await sleep(500)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-02-say-bubble.png` })

  // dialog.open: 先确保对话框关闭(轮询稳定基线),排除模拟 Agent 残留对话
  await injectCmd(page, 'dialog.close', {})
  let beforeDlg = true
  for (let i = 0; i < 20 && beforeDlg; i++) {
    await sleep(150)
    beforeDlg = await dialogVisible(page)
  }
  const dlg = await injectCmd(page, 'dialog.open', { agentName: 'cmd-injector', lines: ['第一句台词', '第二句台词'] })
  check('dialog.open 注入 applied=true', dlg.applied === true, JSON.stringify(dlg))
  // 轮询等待对话框出现(WS 下行 + Vue 过渡)
  let opened = false
  for (let i = 0; i < 20 && !opened; i++) {
    await sleep(150)
    opened = await dialogVisible(page)
  }
  check('dialog.open → 对话框出现', opened === true && beforeDlg === false, `before=${beforeDlg} after=${opened}`)
  const dlgAgentName = await page.$eval('[data-hud="dialog"] .text-xs.font-bold', el => el.textContent.trim())
  check('dialog.open → agentName 正确', dlgAgentName === 'cmd-injector', `got="${dlgAgentName}"`)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-03-dialog-open.png` })

  // dialog.close: 轮询等待消失
  const close = await injectCmd(page, 'dialog.close', {})
  check('dialog.close 注入 applied=true', close.applied === true)
  let closed = true
  for (let i = 0; i < 20 && closed; i++) {
    await sleep(150)
    closed = await dialogVisible(page)
  }
  check('dialog.close → 对话框消失', closed === false)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-04-dialog-close.png` })

  // agent.state: HUD 模式文本变化(取一个稳定值)
  const stateBefore = await agentMode(page)
  const state = await injectCmd(page, 'agent.state', { mode: 'wait', speed: 100 })
  check('agent.state 注入 applied=true', state.applied === true, JSON.stringify(state))
  await sleep(400)
  const stateAfter = await agentMode(page)
  check('agent.state → HUD 模式变化为"等待"', stateAfter.includes('等待'), `${stateBefore} → ${stateAfter}`)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-05-agent-state.png` })

  // agent.face: 朝向(截图 + flipX)
  const faceBefore = await agentPx(page)
  await injectCmd(page, 'agent.face', { dir: 'left' })
  await sleep(300)
  const faceAfter = await agentPx(page)
  check('agent.face → flipX 变为 true', faceAfter.flipX === true, `flipX: ${faceBefore.flipX}→${faceAfter.flipX}`)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-06-agent-face.png` })

  // agent.move: 精灵位移
  const moveBefore = await agentPx(page)
  await injectCmd(page, 'agent.move', { dir: 'right', durationMs: 800 })
  await sleep(900)
  const moveAfter = await agentPx(page)
  const moved = Math.abs(moveAfter.x - moveBefore.x) > 5
  check('agent.move → 精灵 X 位移', moved, `x: ${moveBefore.x}→${moveAfter.x}`)
  await page.screenshot({ path: `${SHOT_DIR}/cmd-07-agent-move.png` })

  // ---------------- 2. 不规范下行指令 → 拒绝,前端无变化 ----------------
  console.log('\n--- 2. 不规范下行指令 → 拒绝(execDownlink 守卫) ---')

  // 先确保对话框关闭(轮询稳定基线)
  await injectCmd(page, 'dialog.close', {})
  let dlgClosedBefore = true
  for (let i = 0; i < 20 && dlgClosedBefore; i++) {
    await sleep(150)
    dlgClosedBefore = await dialogVisible(page)
  }

  // 非 agentCallable 指令: session.ready
  const forbid = await injectCmd(page, 'session.ready', { agentName: 'x', spawn: { x: 0, y: 0 } })
  check('session.ready → FORBIDDEN', forbid.code === 'FORBIDDEN', JSON.stringify(forbid))

  // 未知指令
  const unknown = await injectCmd(page, 'totally.unknown', {})
  check('未知指令 → UNKNOWN_COMMAND', unknown.code === 'UNKNOWN_COMMAND' || unknown.code === 'BAD_MESSAGE', JSON.stringify(unknown))

  // 无效 payload: agent.move dir 非法
  const invalidMove = await injectCmd(page, 'agent.move', { dir: 'sideways', durationMs: 100 })
  check('agent.move 非法 dir → INVALID_PAYLOAD', invalidMove.code === 'INVALID_PAYLOAD', JSON.stringify(invalidMove))

  // 无效 payload: dialog.open 缺 lines
  const invalidDlg = await injectCmd(page, 'dialog.open', { agentName: 'x' })
  check('dialog.open 缺 lines → INVALID_PAYLOAD', invalidDlg.code === 'INVALID_PAYLOAD', JSON.stringify(invalidDlg))

  // 闭合 schema: agent.say 多余字段
  const extra = await injectCmd(page, 'agent.say', { text: 'x', ttlMs: 100, rogue: 1 })
  check('agent.say 多余字段 → INVALID_PAYLOAD', extra.code === 'INVALID_PAYLOAD', JSON.stringify(extra))

  // 确认前端无异常变化:对话框仍关闭
  const dlgClosedAfter = await dialogVisible(page)
  check('不规范指令 → 前端对话框未异常打开', dlgClosedBefore === false && dlgClosedAfter === false)

  await page.screenshot({ path: `${SHOT_DIR}/cmd-08-after-rejects.png` })
  await browser.close()

  console.log(`\n=== ${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} (${pass}/${pass + fail}) ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('RENDER VERIFY CRASH:', e)
  process.exit(2)
})
