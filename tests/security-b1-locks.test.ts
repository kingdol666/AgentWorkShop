/**
 * B1 停机语义批验收(2026-10-30 安全审计 P0-3 / P0-4 / P1-5 / P1-9)。
 *
 * - P0-3:instance-guard 不得在信号处理器里 process.exit(抢在 nitro graceful shutdown 之前);
 * - P0-4:start.mjs 停子进程必须杀整棵树(Windows 上唯一可靠口径),且 POSIX 保留优雅窗口;
 * - P1-5:数据锁独占创建(flag:'wx'),存活者拒绝、死残留接管;
 * - P1-9:AML env.lock 崩溃残留可自愈(死 PID 接管 / 活 PID 仍 409)。
 *
 * 真机停机行为见 scripts/e2e-security-b1.mjs(SIGTERM → close 钩子执行 + 无孙进程残留)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-b1-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_SKIP_DATA_LOCK

const REPO = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

// ════════════════ P0-3:信号交还 nitro graceful shutdown ════════════════

test('P0-3 instance-guard 信号处理器不得直接 process.exit(会短路 close 钩子)', () => {
  const src = read('server/plugins/01-instance-guard.ts')
  // 取出两个信号注册块,断言其中没有立即退出
  const sigBlock = src.slice(src.indexOf('process.once(sig'), src.indexOf('process.once(sig') + 700)
  assert.ok(sigBlock.length > 0, '未找到信号注册')
  assert.ok(!/process\.exit\(0\)\s*\n\s*\}\)/.test(sigBlock.replace(/\s+/g, ' ')), '信号处理器内不得立即退出')
  assert.match(sigBlock, /setTimeout|FORCE_EXIT_MS/, '应有兜底强退定时器(防止 close 链卡死)')
  assert.match(src, /hooks\?\.hook\('close'/, 'close 钩子应再释放一次锁(双保险)')
})

test('P0-3 workshop close 钩子仍负责杀训练树/关库(未被删除)', () => {
  const src = read('server/plugins/workshop.ts')
  for (const fn of ['shutdownOrchestrator', 'manager.shutdown', 'db.close']) {
    assert.ok(src.includes(fn), `close 钩子缺失清理步骤:${fn}`)
  }
})

// ════════════════ P0-4:整树终止 ════════════════

test('P0-4 start.mjs 停止子进程用 taskkill /T(Windows 无信号语义,不 /T 会留孙进程)', () => {
  const src = read('scripts/start.mjs')
  const fn = src.slice(src.indexOf('function killChild'), src.indexOf('function spawnServiceChild'))
  assert.match(fn, /taskkill/, 'Windows 路径必须用 taskkill')
  assert.match(fn, /'\/T'/, '必须 /T 递归终止整棵进程树')
  assert.ok(!/c\.kill\(sig\)/.test(fn), '不得只对直接子进程发信号(孙进程成孤儿)')
})

test('P0-4 start.mjs 保留 POSIX 优雅窗口 + 超时强杀', () => {
  const src = read('scripts/start.mjs')
  assert.match(src, /GRACE_MS/, '应有优雅停机窗口常量')
  assert.match(src, /killChild\('graceful'\)/)
  assert.match(src, /killChild\('force'\)/, '超时/退出路径必须强杀整树')
})

// ════════════════ P1-5:数据锁独占创建 ════════════════

test('P1-5 数据锁用 flag:\'wx\' 独占创建(消除 read-then-write TOCTOU)', () => {
  const src = read('server/plugins/01-instance-guard.ts')
  assert.match(src, /flag: 'wx'/, '必须独占创建')
  assert.match(src, /lockSelf/, '应有独占获取函数')
  assert.ok(!/\{ flag: 'w' \}/.test(src.split('function lockSelf')[0] ?? ''), '获取路径不得用非独占覆盖写')
  assert.match(src, /pidAlive/, 'EEXIST 时必须探活再决定拒绝/接管')
})

test('P1-5 行为:活 PID 锁 → 子进程启动失败;死 PID 残留 → 接管成功', async () => {
  const guardPath = join(REPO, 'server/plugins/01-instance-guard.ts')
  const home = mkdtempSync(join(tmpdir(), 'aw-b1-guard-'))
  const runtimeDir = join(home, '.runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const lockFile = join(runtimeDir, 'data.lock')

  // ① 存活 PID:用当前进程 PID 冒充"别的实例"(pidAlive 为真)
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const alive = await runGuard(guardPath, home)
  assert.equal(alive.code, 1, `活锁应 fail-fast,实际 exit=${alive.code} out=${alive.out.slice(0, 200)}`)
  assert.match(alive.out, /数据目录已被进程/, '应给出明确的占用者提示')

  // ② 死 PID 残留:取一个确定不存在的 PID → 应接管成功并持锁
  const deadPid = 999999
  writeFileSync(lockFile, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }))
  const dead = await runGuard(guardPath, home, { hold: true })
  try {
    assert.equal(dead.code, null, `接管进程应持锁存活,实际已退出 out=${dead.out.slice(0, 300)}`)
    const after = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number }
    assert.equal(after.pid, dead.childPid, '锁文件应改写为接管者 PID')
    assert.match(dead.out, /接管崩溃残留/, '应记录接管日志(谁在写这个数据目录须可追溯)')
  }
  finally {
    dead.stop()
  }
  // Windows 上 kill() = TerminateProcess,exit 处理器不执行 → 锁会残留。
  // 这正是崩溃残留的真实形态:下次启动必须能自愈接管(而不是永久锁死)。
  await new Promise(r => setTimeout(r, 900))
  assert.equal(existsSync(lockFile), true, '硬杀后应留下残留锁(用于验证自愈)')
  const again = await runGuard(guardPath, home, { hold: true })
  try {
    assert.match(again.out, /接管崩溃残留/, '硬杀残留的锁必须被下一实例自愈接管')
    assert.equal((JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number }).pid, again.childPid)
  }
  finally {
    again.stop()
  }
})

/** 在独立进程里跑 instance-guard 插件(它用 process.exit,不能同进程测) */
function runGuard(guardPath: string, home: string, opts: { hold?: boolean } = {}): Promise<{ code: number | null, out: string, childPid?: number, stop: () => void }> {
  return new Promise((resolvePromise) => {
    const script = `
      const mod = await import(${JSON.stringify(pathToFileURL(guardPath).href)})
      await mod.default()
      // 插件不会退出时打印自身 PID 并退出(代表成功持锁)
      console.log('GUARD_OK pid=' + process.pid)
      ${opts.hold ? 'setTimeout(() => {}, 120000)' : 'process.exit(0)'}
    `
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: REPO,
      env: { ...process.env, AW_HOME: home, AW_MODE: 'home' },
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    // hold 模式下:等到 GUARD_OK 出现即视为已就绪(half-resolve),退出时才 finalize
    let settled = false
    const ready = () => {
      if (settled) return
      settled = true
      const pid = Number(/GUARD_OK pid=(\d+)/.exec(out)?.[1] ?? 0) || undefined
      resolvePromise({
        code: null,
        out,
        childPid: pid,
        stop: () => {
          try {
            child.kill()
          }
          catch { /* 已退出 */ }
        },
      })
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      const pid = Number(/GUARD_OK pid=(\d+)/.exec(out)?.[1] ?? 0) || undefined
      resolvePromise({ code, out, childPid: pid, stop: () => {} })
    }
    if (opts.hold) {
      // 等 stderr 落尽再快照(接管日志走 stderr,与 stdout 不同步)
      const iv = setInterval(() => {
        if (!/GUARD_OK/.test(out)) return
        clearInterval(iv)
        setTimeout(ready, 300)
      }, 50)
      child.on('exit', (code) => {
        clearInterval(iv)
        finish(code)
      })
    }
    else {
      child.on('exit', (code) => {
        finish(code)
      })
    }
  })
}

// ════════════════ P1-9:AML env.lock 自愈 ════════════════

const { withEnvExclusiveLock } = await import('../server/services/workshop/aml/env-lease')

test('P1-9 行为:死 PID 残留 env.lock → 自动接管,维护不再永久阻塞', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-b1-env-'))
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'env.lock'), JSON.stringify({ owner: 'crashed', pid: 999999, heartbeatAt: Date.now() }))
  let ran = false
  await withEnvExclusiveLock('test-holder', root, () => {
    ran = true
  })
  assert.equal(ran, true, '死锁残留下维护体应执行')
})

test('P1-9 行为:活 PID(另一进程)env.lock → 仍拒绝(ENV_BUSY),不误接管', async () => {
  // 必须用"别的存活进程"而非 process.pid:同 PID 被视为本进程残留锁(自愈语义)
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  try {
    const root = mkdtempSync(join(tmpdir(), 'aw-b1-env2-'))
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'env.lock'), JSON.stringify({ owner: 'alive', pid: holder.pid, heartbeatAt: Date.now(), token: 'x' }))
    await assert.rejects(
      () => withEnvExclusiveLock('test-holder', root, () => {}),
      (err: { status?: number, code?: string }) => err.status === 409 && err.code === 'ENV_BUSY',
    )
  }
  finally {
    holder.kill()
  }
})

test('P1-9 行为:锁内容损坏 → 视为残留并接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-b1-env3-'))
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'env.lock'), '{not-json')
  let ran = false
  await withEnvExclusiveLock('test-holder', root, () => {
    ran = true
  })
  assert.equal(ran, true, '损坏锁应被接管')
})
