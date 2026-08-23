/**
 * 休眠/进程存活探活冒烟测试(node + tsx 直跑,真实子进程)。
 *
 * 覆盖(对应「休眠鲁棒性」修复):
 *  1. isProcessAlive:OS 级 signal-0 探针 —— 存活 true / 死亡 false
 *  2. OmpRpcClient.reconcile:活客户端不误判;子进程死后 alive 收敛为 false(幂等)
 *  3. 收敛后 send 失败立即暴露(不死等 60s 命令超时)
 */
import { spawn } from 'node:child_process'
import { isProcessAlive } from '../server/services/workshop/agents/harness-process'
import { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 假 harness:启动即输出 ready 帧,然后挂起等待被杀 */
function spawnFakeHarness(): ReturnType<typeof spawn> {
  // windowsHide 保证 Windows 下不弹子窗口
  return spawn(process.execPath, ['-e', `process.stdout.write(JSON.stringify({type:'ready'})+'\\n'); setInterval(()=>{},1000)`], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function testIsProcessAlive(): Promise<void> {
  console.log('\n--- 1. isProcessAlive:OS 级存活探针 ---')
  const child = spawnFakeHarness()
  await sleep(300)
  const pid = child.pid!
  check('存活子进程 → 探针 true', isProcessAlive(pid) === true, `pid=${pid}`)
  check('非法 pid → false', isProcessAlive(0) === false && isProcessAlive(NaN) === false)

  child.kill('SIGKILL')
  // 等 OS 回收(window 下短暂存在 zombie 窗口,最多重试 3s)
  let dead = false
  for (let i = 0; i < 30 && !dead; i++) {
    await sleep(100)
    dead = !isProcessAlive(pid)
  }
  check('击杀后探针收敛为 false(≤3s)', dead, `pid=${pid}`)
}

async function testClientReconcile(): Promise<void> {
  console.log('\n--- 2. OmpRpcClient.reconcile:死后 alive 收敛 + 幂等 ---')
  // 注入真实子进程(绕过 start() 的 --mode rpc ready 握手;reconcile 只依赖 child.pid 与 OS 探针)
  const real = spawnFakeHarness()
  const client = new OmpRpcClient({}) as unknown as { reconcile(): boolean, alive: boolean, send(c: { type: string, message: string }): Promise<unknown>, [k: string]: unknown }
  ;(client as unknown as { child: ReturnType<typeof spawn> }).child = real
  await sleep(300)

  // 活进程:reconcile 不误判
  check('活客户端 reconcile → true 且 alive 保持', client.reconcile() === true && client.alive === true)

  // 杀进程 → 经 reconcile 探活兜底收敛(自然 exit 事件未被监听,alive 失真 → 探针校准)
  real.kill('SIGKILL')
  let converged = false
  for (let i = 0; i < 30 && !converged; i++) {
    await sleep(100)
    converged = !client.reconcile()
  }
  check('子进程死后 reconcile 收敛 alive=false(≤3s)', converged)

  // 幂等:再次 reconcile 不抛、状态保持
  let threw = false
  try {
    client.reconcile()
  }
  catch {
    threw = true
  }
  check('死后 reconcile 幂等不抛', !threw && client.alive === false)

  // 死客户端上 send 应快速失败(写即错,而非挂 60s 等响应)
  check('死后 send 立即失败(不死等超时)', await sendFailsFast(client as unknown as OmpRpcClient))
}

/** 死客户端上 send 应快速失败(写即错,而非挂 60s 等响应) */
async function sendFailsFast(client: OmpRpcClient): Promise<boolean> {
  const started = Date.now()
  try {
    await client.send({ type: 'prompt', message: 'x' })
    return false // 不应成功
  }
  catch {
    return Date.now() - started < 10_000
  }
}

async function main(): Promise<void> {
  await testIsProcessAlive()
  await testClientReconcile()

  console.log('')
  if (failures === 0) {
    console.log('ALL PASS')
    process.exit(0)
  }
  else {
    console.log(`${failures} FAILED`)
    process.exit(1)
  }
}

main()
