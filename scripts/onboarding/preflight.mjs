#!/usr/bin/env node
/**
 * scripts/onboarding/preflight.mjs —— 协议接入前的生产安全预检(只读)。
 *
 * 目的:在“按文档建节点 / 模拟通信 / 插件热加载”之前,先回答三个问题:
 *   1) 当前是否已有实例在跑?在哪个 home / 端口 / PID?
 *   2) 这个实例能不能被当成可丢弃的测试实例?
 *   3) 如果要启动影子实例,哪些端口/home 已经被占用?
 *
 * 安全语义:
 *   - 只读:读锁文件、探 PID、探 TCP 端口;--probe 时才发一次 GET /api/health。
 *   - 绝不停止、重启、删除、改写任何进程/锁/数据。
 *   - 默认把“已运行实例”一律按生产对待(treatAsProduction=true);
 *     只有显式 --test-instance 才允许把它标记为可丢弃测试实例。
 *
 * 用法:
 *   node scripts/onboarding/preflight.mjs [--json] [--port 3300] [--home <dir>]
 *     [--test-instance] [--probe] [--require-idle]
 *
 * 退出码:0=信息输出;2=--require-idle 且发现运行中实例。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const json = flag('json')
const testInstance = flag('test-instance')
const probe = flag('probe')
const requireIdle = flag('require-idle')

const homes = new Set()
if (process.env.AW_HOME) homes.add(resolve(process.env.AW_HOME))
const argHome = valueOf('home')
if (argHome) homes.add(resolve(argHome))
homes.add(resolve(REPO, '.AgentWorkShop'))
homes.add(join(homedir(), '.AgentWorkShop'))
// 直接 `node .output/server/index.mjs` 的 data.lock 落在 <cwd>/.runtime;补扫包根与当前 cwd
homes.add(resolve(REPO))
homes.add(resolve(process.cwd()))

const ports = new Set([3300, 3001])
const argPort = Number(valueOf('port'))
if (Number.isInteger(argPort) && argPort > 0) ports.add(argPort)

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return null
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return err?.code === 'EPERM'
  }
}

function portListening(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port })
    const done = (v) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(v)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function probeHealth(port) {
  try {
    // 仅本机诊断:只允许 http,不跟随重定向,不携带凭据。
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    })
    const body = await res.json().catch(() => null)
    return res.ok ? body?.data ?? body : { status: res.status }
  }
  catch (err) {
    return { error: err?.message ?? String(err) }
  }
}

const instances = []
const seen = new Set()

for (const home of homes) {
  const runtime = join(home, '.runtime')
  const awLockPath = join(runtime, 'aw.lock')
  const dataLockPath = join(runtime, 'data.lock')
  const awLock = readJsonFile(awLockPath)
  const dataLock = readJsonFile(dataLockPath)
  if (!awLock && !dataLock) continue

  const pid = Number(awLock?.pid ?? dataLock?.pid ?? 0)
  const port = Number(awLock?.port ?? 0)
  if (port > 0) ports.add(port)
  const alive = pidAlive(pid)
  const listening = port > 0 ? await portListening(port) : false
  const key = `${home}|${pid}|${port}`
  if (seen.has(key)) continue
  seen.add(key)
  instances.push({
    home,
    mode: awLock?.mode ?? null,
    port: port || null,
    pid: pid || null,
    startedAt: awLock?.startedAt ?? dataLock?.at ?? null,
    awLock: existsSync(awLockPath) ? awLock : null,
    dataLock: existsSync(dataLockPath) ? dataLock : null,
    pidAlive: alive,
    portListening: listening,
    stale: Boolean((pid && !alive) || (port && !listening)),
    note: !alive && listening
      ? '锁指向的 PID 已退出,但端口仍在监听:实际写者未知,不要据此杀任何进程;先查端口对应的进程'
      : (!listening && pid
          ? '锁存在但端口未监听:可能是崩溃残留;让应用启动时自行接管,不要手动删锁'
          : undefined),
  })
}

// 端口占用但无锁文件的实例(例如别的 home / 手工启动)
for (const port of ports) {
  if (instances.some(i => i.port === port && i.portListening)) continue
  const listening = await portListening(port)
  if (!listening) continue
  const key = `port|${port}`
  if (seen.has(key)) continue
  seen.add(key)
  instances.push({
    home: null,
    mode: null,
    port,
    pid: null,
    startedAt: null,
    pidAlive: false,
    portListening: true,
    stale: false,
    note: '端口有监听但未找到对应 aw.lock;可能是其它 home 或容器',
  })
}

if (probe) {
  for (const inst of instances) {
    if (inst.port && inst.portListening) inst.health = await probeHealth(inst.port)
  }
}

const running = instances.some(i => i.pidAlive || i.portListening)
const liveInstances = instances.filter(i => i.pidAlive || i.portListening)
const treatAsProduction = running && !testInstance
const safeToStart = !running

const forbiddenActions = treatAsProduction
  ? [
      'aw start / node bin/aw.mjs start(会读 aw.lock 并自动停止既有实例,不是“启动失败”)',
      'aw stop / node bin/aw.mjs stop',
      'taskkill / Stop-Process / kill / pkill',
      'docker compose down / docker stop awshop-*',
      '在同一个 AW_HOME 或同一端口再启动一个实例(直接启动会被 data.lock 拒绝)',
      '停止/重启 DAQ 采集总控(POST /api/workshop/daq/controller action=stop)',
      '修改或删除既有的线/节点/配方/频道',
      '重启进程来让插件生效(builtin 除外,需先验证 helper 缓存)',
    ]
  : []

const out = {
  at: new Date().toISOString(),
  repo: REPO,
  homes: [...homes],
  ports: [...ports],
  running,
  liveInstances,
  instances,
  treatAsProduction,
  testInstance,
  safeToStart,
  forbiddenActions,
  next: running
    ? [
        '附加到已运行实例:export AW_BASE=http://127.0.0.1:<port>;然后 aw_status / aw_login',
        '不要运行 aw start(它会自动停止既有实例)',
        '只创建本次作业资源(PROTO/E2E 前缀 + 专用测试线),不改不删既有资源',
        '插件优先 project/user 级热加载;需要重启的改动移交维护窗口',
        '收尾只清理本次创建的 id',
      ]
    : [
        '无运行实例:可用不同端口 + 不同 AW_HOME 启动影子实例',
        '启动后先 aw_status 确认 mcpEnabled=true,再进入配置作业',
      ],
}

if (json) {
  console.log(JSON.stringify(out, null, 2))
}
else {
  console.log('═══ AgentWorkShop 协议接入预检(只读)═══')
  console.log(`运行中: ${running ? '是' : '否'}  |  按生产对待: ${treatAsProduction ? '是' : '否'}  |  可安全启动: ${safeToStart ? '是' : '否'}`)
  for (const inst of instances) {
    console.log(`- home=${inst.home ?? '(未知)'} mode=${inst.mode ?? '-'} port=${inst.port ?? '-'} pid=${inst.pid ?? '-'} pidAlive=${inst.pidAlive} listening=${inst.portListening}${inst.stale ? ' stale' : ''}`)
    if (inst.health) console.log(`  health=${JSON.stringify(inst.health).slice(0, 220)}`)
    if (inst.note) console.log(`  note=${inst.note}`)
  }
  if (forbiddenActions.length) {
    console.log('\n禁止动作:')
    for (const a of forbiddenActions) console.log(`  ✖ ${a}`)
  }
  console.log('\n下一步:')
  for (const n of out.next) console.log(`  › ${n}`)
}

if (requireIdle && running) process.exitCode = 2 // 不用 process.exit:避免 --probe 的 undici socket 关闭中触发 libuv 断言
