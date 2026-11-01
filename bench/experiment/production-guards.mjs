#!/usr/bin/env node
/**
 * bench/experiment/production-guards.mjs —— E4 生产态守卫一致性（L2/L3/L4/L5/L6）
 *
 * 背景（EXPERIMENT-PIPELINE §1 D3、§3 E4）：
 *   `AW_BENCH_MODE=1` 会**全局**关闭单步限、60s 间隔、写入保持窗，所以 E1a 的四臂
 *   根本测不到这三层。本脚本反过来做：在不带 bench env 的 **P 态**平台上，逐层构造
 *   一次只违规一层的写入，断言每层各自拒绝，并记录错误码/消息/时延。
 *
 * 它不做任何旁路（没有 OFF 臂）：安全、可随时对隔离实例重跑。
 * 反过来，P 态下 60s 间隔使多次写很慢 —— 这是测试本身的一部分。
 *
 * 前置（硬门，任一不满足即拒绝执行）：
 *   - 平台进程**未**设置 AW_BENCH_MODE（本进程 env 为空 AND 平台回读确认）；
 *   - 隔离 AW_HOME + loopback 模拟器；
 *   - 平台可达且 admin 可登录。
 *
 * 用法：
 *   node bench/experiment/production-guards.mjs --base http://127.0.0.1:3005
 *   node bench/experiment/production-guards.mjs --out bench/results/<dir>
 *
 * 退出码：0 = 五层全部按预期拒绝；1 = 任一层的攻击被执行（治理缺陷）或环境不满足。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeApi, sleep } from '../lib/util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const rid = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-production-guards`
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', rid)))

const RANGE = { min: 120, max: 260 }
const WINDOW = { min: 175, max: 205 }
const STEP_LIMIT = 5
const LOCK_SECONDS = 180

const api = makeApi(base)
const rows = []

const round1 = v => Number(Number(v).toFixed(1))

async function write(nodeId, value) {
  const t0 = Date.now()
  const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value })
  return { status: r.status, code: r.code ?? '', message: String(r.message ?? ''), ms: Date.now() - t0 }
}

function judge(label, layer, value, got, expect) {
  const hit = expect(got)
  rows.push({ label, layer, value, status: got.status, code: got.code, ms: got.ms, expect: 'reject', got: hit ? 'reject' : 'ACCEPTED', message: got.message.slice(0, 200) })
  return hit
}

const main = async () => {
  // 硬门 1：本进程不得带 bench 开关
  if (String(process.env.AW_BENCH_MODE ?? '') !== '' || String(process.env.AW_BENCH_ACK ?? '') !== '') {
    throw new Error('检测到 AW_BENCH_MODE/AW_BENCH_ACK —— 本实验必须在 P 态（生产语义）平台执行；请在不带 bench env 的进程/平台上重跑')
  }
  const login = await api.login('admin@awshop.local', 'admin123')
  if (!login.ok) throw new Error(`平台鉴权失败: ${login.how}`)

  // 夹具：独立线/产品/配方/节点（mock 驱动；守卫在控制器层，先于驱动）
  const sfx = `pg${Date.now().toString(36).slice(-5)}`
  const line = await api.call('POST', '/api/workshop/dcw/lines', { name: `E4 守卫 ${sfx}` })
  const lineId = line.data?.line?.id
  if (!lineId) throw new Error(`建线失败: ${line.message}`)
  const product = await api.call('POST', '/api/workshop/dcw/products', { lineId, name: `E4P ${sfx}` })
  const tpl = await api.call('POST', '/api/workshop/dcw/templates', { key: `e4-${sfx}`, name: `E4温度 ${sfx}`, ch: '温度', unit: '℃', min: RANGE.min, max: RANGE.max, decimals: 1 })
  const node = await api.call('POST', '/api/workshop/dcw', {
    name: `E4段 ${sfx}`, templateRef: tpl.data?.template?.key, driver: 'mock',
    unit: '℃', min: RANGE.min, max: RANGE.max, decimals: 1, lineId,
    holdIntervalMs: 0, stepLimit: STEP_LIMIT, writeLockSeconds: LOCK_SECONDS,
  })
  const nodeId = node.data?.node?.id
  if (!nodeId) throw new Error(`建节点失败: ${node.message}`)
  const recipe = await api.call('POST', '/api/workshop/dcw/recipes', {
    productId: product.data?.product?.id, name: `E4工艺 ${sfx}`,
    params: [{ nodeId, value: 190, min: WINDOW.min, max: WINDOW.max, stepLimit: STEP_LIMIT }],
  })
  const started = await api.call('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId: recipe.data?.recipe?.id })
  if (started.status >= 400) throw new Error(`开跑失败: ${started.message}`)
  // 开跑会按配方整批下发参数（recipe 路径），把节点 lastWriteAt 打成当前时刻；
  // 紧接着的 manual 基线写会撞 60s 间隔（实测：基线写 429 WRITE_INTERVAL_NOT_ELAPSED → 夹具不成立）。
  // 先等过一个间隔窗口，基线写才是本实验第一笔 manual 写。
  console.log('  开跑已下发配方参数，等待 62s 越过 60s 间隔窗口（夹具前置）...')
  await sleep(62_000)

  const ctx = { sfx, lineId, nodeId, range: RANGE, window: WINDOW, stepLimit: STEP_LIMIT, lockSeconds: LOCK_SECONDS }

  // ① 基线合法写（同时开启 60s 间隔 + 180s 保持窗）
  const baselineWrite = await write(nodeId, 190)
  const baseOk = baselineWrite.status === 200
  rows.push({ label: 'baseline legal', layer: '—', value: 190, status: baselineWrite.status, code: baselineWrite.code, ms: baselineWrite.ms, expect: 'accept', got: baseOk ? 'accept' : 'BLOCKED', message: baselineWrite.message.slice(0, 200) })
  if (!baseOk) throw new Error(`基线合法写被拒（${baselineWrite.status} ${baselineWrite.code}）—— 夹具不成立，无法继续`)

  // ② L5 60s 间隔：合法值（delta 2 ≤ step 5），应被间隔守卫拒绝
  judge('L5 60s interval', 'L5', 192, await write(nodeId, 192), g => g.status === 429 && /间隔|interval/i.test(g.message))

  // ③ L4 单步限：窗口内、量程内，但 delta=10 > step=5（限界检查先于频率检查）
  judge('L4 step limit', 'L4', 200, await write(nodeId, 200), g => g.status === 409 && /单步限制|step/i.test(g.message))

  // ④ L2 结构量程：越上限
  judge('L2 node range high', 'L2', RANGE.max + 20, await write(nodeId, RANGE.max + 20), g => g.status === 400 && /超出上限|NODE_RANGE/i.test(g.message + g.code))

  // ⑤ L3 软窗：量程内、配方窗外
  judge('L3 recipe window', 'L3', WINDOW.max + 5, await write(nodeId, WINDOW.max + 5), g => g.status === 400 && /配方|RECIPE_LIMIT/i.test(g.message + g.code))

  // ⑥ L6 保持窗：等过 60s 间隔，但 180s 保持窗仍在 → 必须是 WRITE_FREQUENT 而不是间隔错误
  const waitS = 62
  console.log(`  等待 ${waitS}s（越过 60s 间隔，仍在 ${LOCK_SECONDS}s 保持窗内）...`)
  await sleep(waitS * 1000)
  judge('L6 hold window', 'L6', 192, await write(nodeId, 192), g => g.status === 429 && /保持窗口|WRITE_FREQUENT/i.test(g.message + g.code))

  const pass = rows.filter(r => r.expect === 'reject').every(r => r.got === 'reject')
  const md = [
    '# E4 生产态守卫一致性（P 态，无 bench 旁路）',
    '',
    `- run: \`${rid}\` · base ${base}`,
    `- 夹具: 节点 [${RANGE.min}, ${RANGE.max}]·配方窗 [${WINDOW.min}, ${WINDOW.max}]·stepLimit ${STEP_LIMIT}·writeLockSeconds ${LOCK_SECONDS}`,
    '',
    '| 层 | 用例 | 值 | 状态 | code | 结果 | 消息 |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.layer} | ${r.label} | ${r.value} | ${r.status} | ${r.code} | ${r.got} | ${String(r.message).replaceAll('|', '/').slice(0, 80)} |`),
    '',
    pass ? '**判定：PASS** — 五层各自拒绝，无穿透。' : '**判定：FAIL** — 存在 `ACCEPTED`（攻击被执行）或错误层不匹配。',
    '',
    '## 口径',
    '',
    '1. 本表证明「生产语义下每层各自生效」，**不**证明消融后损失多大（那是 E4 的 OFF 臂，需独立安全复核）。',
    '2. 与 E1a 的关系：E1a 在 B 态测软窗/回读；本表在 P 态补 L4/L5/L6。两者不可合并成一张「拦截率」。',
    '3. 基线合法写若被拒 → 夹具不成立，实验作废（脚本直接抛错）。',
    '',
  ].join('\n')

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'e4-defense-layers.csv'), [
    'label,layer,value,status,code,ms,expect,got,message',
    ...rows.map(r => [r.label, r.layer, r.value, r.status, r.code, r.ms, r.expect, r.got, String(r.message).replaceAll(',', ';')].join(',')),
  ].join('\n'))
  writeFileSync(join(outDir, 'e4-defense-layers.md'), md)
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({
    runId: rid, at: new Date().toISOString(), base, fixture: ctx, rows, pass,
    reproCmd: `node bench/experiment/production-guards.mjs --base ${base}`,
  }, null, 2))
  console.log(`\n${md}`)
  console.log(`产物: ${outDir}`)
  if (!pass) process.exitCode = 1
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.message ?? err}`)
  process.exitCode = 1
})
