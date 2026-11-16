/**
 * 2026-10-30 回归(真 Timescale 契约测试,独立临时容器和库):
 *  运行期新建的产线(实例启动后才产生样本)必须被 rollup/sweep 发现 ——
 *  修复前 knownLines 只在 init() backfill 一次,新线不产 1m/1h 聚合,
 *  且有任一保留期覆写时不进逐线裁剪名单(旧 raw 永不回收)。
 *  修复后 runRollup()/sweepNow() 每轮 refreshKnownLines()。
 *
 * 判据:
 *  A. init 后插入「新线」样本 → 不重启,直接 runRollup() → 新线出现 1m 聚合行且水位推进;
 *  B. 给既有线设保留期覆写(hasOverride=true)→ 新线 30 天前样本在新一轮 sweep 后被裁,
 *     长保留覆写线的同窗样本保留(互不误删)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Explicit integration opt-in only. Requires a local Docker daemon and the locally
// available timescale/timescaledb:latest-pg16 image; no image is pulled. Example:
// AW_TSDB_ROLLUP_INTEGRATION=1 pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/tsdb-rollup-runtime-lines.test.ts
const integration = process.env.AW_TSDB_ROLLUP_INTEGRATION === '1'

type DockerCommand = (args: string[], timeout?: number) => string

function ownedContainerId(docker: DockerCommand, reference: string, name: string, owner: string, timeout?: number): string {
  const result = JSON.parse(docker(['inspect', '--type', 'container', reference], timeout)) as Array<{
    Id?: string
    Name?: string
    Config?: { Labels?: Record<string, string> }
  }>
  assert.equal(result.length, 1, '容器所有权无法验证')
  const container = result[0]
  assert.match(container?.Id ?? '', /^[a-f0-9]{64}$/, '容器 ID 无效')
  assert.equal(container?.Name, `/${name}`, '容器名称不匹配')
  assert.equal(container?.Config?.Labels?.['aw.rollup-test.owner'], owner, '容器所有权标签不匹配')
  if (/^[a-f0-9]{64}$/.test(reference)) assert.equal(container.Id, reference, '容器 ID 不匹配')
  return container.Id!
}

function removeOwnedContainer(docker: DockerCommand, reference: string, name: string, owner: string): void {
  const id = ownedContainerId(docker, reference, name, owner)
  docker(['rm', '-f', '-v', id])
}

// A daemon may finish a timed-out create after these bounded retries. In that case
// the uniquely named container can remain and must be verified manually; never rm by name.
async function cleanupContainer(docker: DockerCommand, reference: string, name: string, owner: string, host: string, uncertainCreate: boolean): Promise<void> {
  const deadline = performance.now() + 20_000
  let lastError: unknown
  for (let attempt = 0; attempt < (uncertainCreate ? 4 : 1); attempt++) {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) break
    let id: string
    try {
      id = ownedContainerId(docker, reference, name, owner, Math.min(3_000, remaining))
    }
    catch (error) {
      lastError = error
      if (uncertainCreate && attempt < 3 && deadline - performance.now() > 500) await delay(500)
      continue
    }
    try {
      const remainingForRemoval = Math.floor(deadline - performance.now())
      if (remainingForRemoval <= 0) throw new Error('清理期限已到')
      docker(['rm', '-f', '-v', id], Math.min(5_000, remainingForRemoval))
      return
    }
    catch (error) {
      lastError = error
      break
    }
  }
  throw new Error(`无法确认或安全清理测试容器 ${name}; 请检查本地 Docker 端点 ${host}，超时后仍可能晚建孤儿`, { cause: lastError })
}

function combineErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, '测试和清理发生多个错误')
}

async function waitUntilReady(docker: DockerCommand, container: string, db: string, budgetMs: number): Promise<void> {
  const deadline = performance.now() + budgetMs
  while (true) {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) throw new Error('隔离的 Timescale 容器未在期限内就绪')
    try {
      docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', db], Math.min(5_000, remaining))
      return
    }
    catch {
      const wait = Math.min(1_000, Math.floor(deadline - performance.now()))
      if (wait <= 0) throw new Error('隔离的 Timescale 容器未在期限内就绪')
      await delay(wait)
    }
  }
}

test('rollup container cleanup requires matching identity and owner', async () => {
  const id = 'a'.repeat(64)
  const calls: string[][] = []
  const docker: DockerCommand = (args) => {
    calls.push(args)
    return JSON.stringify([{ Id: id, Name: '/test-owned', Config: { Labels: { 'aw.rollup-test.owner': 'owner' } } }])
  }
  removeOwnedContainer(docker, 'test-owned', 'test-owned', 'owner')
  assert.deepEqual(calls, [['inspect', '--type', 'container', 'test-owned'], ['rm', '-f', '-v', id]])
  calls.length = 0
  assert.throws(() => removeOwnedContainer(docker, 'test-owned', 'test-owned', 'wrong-owner'))
  assert.deepEqual(calls, [['inspect', '--type', 'container', 'test-owned']])
  calls.length = 0
  assert.throws(() => removeOwnedContainer(docker, 'b'.repeat(64), 'test-owned', 'owner'))
  assert.equal(calls.length, 1)
  const unavailable: DockerCommand = (args) => {
    assert.equal(args[0], 'inspect')
    throw new Error('container not found or inspect timed out')
  }
  await assert.rejects(cleanupContainer(unavailable, 'test-owned', 'test-owned', 'owner', 'local', false))
  let attempts = 0
  const delayed: DockerCommand = (args) => {
    calls.push(args)
    if (args[0] === 'inspect' && ++attempts === 1) throw new Error('not found yet')
    return JSON.stringify([{ Id: id, Name: '/test-owned', Config: { Labels: { 'aw.rollup-test.owner': 'owner' } } }])
  }
  calls.length = 0
  await cleanupContainer(delayed, 'test-owned', 'test-owned', 'owner', 'local', true)
  assert.equal(attempts, 2)
  assert.deepEqual(calls.map(args => args[0]), ['inspect', 'inspect', 'rm'])
  calls.length = 0
  await assert.rejects(cleanupContainer(docker, 'test-owned', 'test-owned', 'wrong-owner', 'local', false))
  assert.deepEqual(calls, [['inspect', '--type', 'container', 'test-owned']])
  const original = new Error('test failure')
  const cleanup = new Error('cleanup failure')
  assert.throws(() => combineErrors([original, cleanup]), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [original, cleanup])
    return true
  })
})

test('rollup readiness respects its overall deadline', async () => {
  const timeouts: number[] = []
  const docker: DockerCommand = (_args, timeout) => {
    timeouts.push(timeout!)
    throw new Error('not ready')
  }
  await assert.rejects(waitUntilReady(docker, 'test-owned', 'test-db', 20), /期限内就绪/)
  assert.ok(timeouts.length > 0 && timeouts.every(timeout => timeout > 0 && timeout <= 20))
})

test('运行期新建产线:无需重启即进入聚合与逐线裁剪', {
  skip: integration ? false : '设置 AW_TSDB_ROLLUP_INTEGRATION=1 才运行隔离的 Timescale 集成测试',
  timeout: 240_000,
}, async () => {
  const setupDeadline = performance.now() + 110_000
  const setupTimeout = (maximum: number): number => {
    const remaining = Math.floor(setupDeadline - performance.now())
    if (remaining <= 0) throw new Error('Timescale 测试准备期限已到')
    return Math.min(maximum, remaining)
  }
  assert.ok(!process.env.DOCKER_HOST, '请取消 DOCKER_HOST 覆写并使用本地 Docker context')
  const contexts = JSON.parse(execFileSync('docker', ['context', 'inspect'], { encoding: 'utf8', timeout: setupTimeout(10_000), killSignal: 'SIGKILL' })) as Array<{
    Endpoints?: { docker?: { Host?: string } }
  }>
  const host = contexts[0]?.Endpoints?.docker?.Host ?? ''
  assert.ok(contexts.length === 1 && (host.startsWith('unix:///') || host.startsWith('npipe:////./pipe/')),
    `需要本地 Docker socket 或 named pipe,实际为 ${host}`)
  // --host pins the inspected endpoint even if the active context changes later.
  const dockerEnv = { ...process.env, DOCKER_HOST: host }
  delete dockerEnv.DOCKER_CONTEXT
  const docker: DockerCommand = (args, timeout = 30_000) => execFileSync('docker', ['--host', host, ...args], {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: dockerEnv,
  }).trim()
  const suffix = randomUUID().replaceAll('-', '')
  const name = `aw-rollup-test-${suffix}`
  const owner = randomBytes(32).toString('hex')
  const db = `aw_rollup_${suffix}`
  const password = randomBytes(24).toString('hex')
  let container: string | undefined
  let creationAttempted = false
  const errors: unknown[] = []
  const sh = (sql: string): string => docker([
    'exec', container!, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-tAc', sql,
  ])
  let store: InstanceType<typeof import('../server/services/workshop/daq/storage/timescale-rollup').TimescaleRollupStore> | undefined
  try {
    creationAttempted = true
    container = docker([
      'create', '--pull=never', '--name', name, '--label', `aw.rollup-test.owner=${owner}`,
      '--network', 'bridge', '-p', '127.0.0.1::5432', '--shm-size', '512m',
      '--tmpfs', '/var/lib/postgresql/data:rw',
      '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db}`,
      'timescale/timescaledb:latest-pg16', 'postgres', '-c', 'timescaledb.license=timescale',
    ], setupTimeout(30_000))
    assert.match(container, /^[a-f0-9]{64}$/, 'Docker 必须返回新建容器的完整 ID')
    ownedContainerId(docker, container, name, owner, setupTimeout(10_000))
    docker(['start', container], setupTimeout(30_000))
    await waitUntilReady(docker, container, db, setupTimeout(60_000))
    const portOutput = docker(['port', container, '5432/tcp'], setupTimeout(10_000))
    const port = /^127\.0\.0\.1:(\d+)$/.exec(portOutput)?.[1]
    assert.ok(port, `容器端口未绑定到本机: ${portOutput}`)
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/${db}`
    const { TimescaleRollupStore } = await import('../server/services/workshop/daq/storage/timescale-rollup')
    sh('CREATE EXTENSION IF NOT EXISTS timescaledb')
    // daq_samples 由主 TimescaleAdapter 建表;契约测试自建最小形态(rollup store 只读它)
    sh(`CREATE TABLE IF NOT EXISTS daq_samples (
         node_id text NOT NULL, ts timestamptz NOT NULL, value double precision NOT NULL,
         state text NOT NULL DEFAULT 'ok', line_id text, product_id text, recipe_id text, run_id text,
         ingested_at bigint)`)
    sh(`SELECT create_hypertable('daq_samples', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`)
    store = new TimescaleRollupStore(url, {
      retentionH: 720, frameRetentionH: 720,
      minuteRetentionH: 8760, hourRetentionH: 0,
      enabled: true, lagMs: 60_000, windowMs: 3_600_000, maxWindowsPerRun: 24, poolMax: 2,
    })
    await store.init()

    // 模拟「启动后运行期才开线」:init 时库里没有 LN-NEW,现在注入 40 分钟前样本
    const t40m = Date.now() - 40 * 60_000
    sh(`INSERT INTO daq_samples (node_id, ts, value, state, line_id)
        SELECT 'dn-new', to_timestamp(${Math.floor(t40m / 1000)}) + (i * interval '30 seconds'), 100 + i, 'ok', 'ln-new'
        FROM generate_series(0, 40) AS i`)
    sh(`INSERT INTO daq_samples (node_id, ts, value, state, line_id)
        SELECT 'dn-keep', now() - interval '35 days' + (i * interval '1 minute'), 200 + i, 'ok', 'ln-keep'
        FROM generate_series(0, 8) AS i`)

    // A: 不重启 → 直接 rollup,新线必须被聚合
    const r = await store.runRollup()
    const newMin = Number(sh(`SELECT count(*) FROM daq_rollup WHERE line_id='ln-new' AND res_ms=60000`))
    const wm = sh(`SELECT watermark_ms FROM daq_rollup_watermark WHERE line_id='ln-new' AND res_ms=60000`)
    assert.ok(newMin > 0, `新线 1m 聚合行应 >0,实得 ${newMin}(notes=${r.notes.join(';')})`)
    assert.ok(Number(wm) > 0, `新线水位应推进,实得 ${wm}`)

    // B: 逐线覆写(长保留线)→ sweep 后新线按全局 30 天裁、长保留线保留
    await store.setLineRetention('ln-keep', { rawRetentionH: 1000 })
    await store.sweepNow()
    const keepOld = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-keep'`))
    const newRows = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-new'`))
    assert.equal(keepOld, 9, `长保留线 35 天前样本应保留 9 行,实得 ${keepOld}`)
    assert.equal(newRows, 41, `新线近期样本(40 分钟前)不应被 30 天窗口裁掉,实得 ${newRows}`)

    // C: 压缩 chunk 上的逐线裁剪(2026-10-30 回归,生产 DDL 同构):
    // 生产对 daq_samples/daq_rollup 挂 1 天列存压缩策略;旧实现 ctid 批删在压缩
    // chunk 上必报「transparent decompression only supports tableoid system column」
    // → sweep 整体失效、数据无限增长。测试表必须同样开压缩,否则与生产环境偏离。
    sh(`ALTER TABLE daq_samples SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id', timescaledb.compress_orderby = 'ts DESC')`)
    sh(`SELECT add_compression_policy('daq_samples', INTERVAL '1 day', if_not_exists => TRUE)`)
    sh(`INSERT INTO daq_samples (node_id, ts, value, state, line_id)
        SELECT 'dn-old', now() - interval '35 days' + (i * interval '1 hour'), 5 + i, 'ok', 'ln-old' FROM generate_series(0, 23) i`)
    await store.runRollup() // ln-old 先聚合出 1m 水位(F4 契约:未聚合不裁 raw)
    sh(`SELECT compress_chunk(i) FROM show_chunks('daq_samples', older_than => now() - interval '3 days') i`)
    sh(`INSERT INTO daq_rollup (line_id, node_id, res_ms, ts, product_id, recipe_id, run_id, avg, min, max, cnt)
        SELECT 'ln-old', 'dn-old', 60000, now() - interval '35 days', 'p', 'r', 'run-old', 5, 5, 5, 1`)
    sh(`SELECT compress_chunk(i) FROM show_chunks('daq_rollup', older_than => now() - interval '3 days') i`)
    const compressedChunks = Number(sh(
      `SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name IN ('daq_samples','daq_rollup') AND is_compressed`))
    assert.ok(compressedChunks >= 2, `前置:两个 hypertable 都应有已压缩 chunk,实得 ${compressedChunks}`)
    await store.setLineRetention('ln-old', { rawRetentionH: 720, minuteRetentionH: 24 })
    await store.sweepNow()
    const oldSamples = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-old'`))
    assert.equal(oldSamples, 0, `压缩 chunk 上 35 天前样本应被裁光(修复前 ctid 批删在此抛错),实得 ${oldSamples}`)
    const oldRollupMinute = Number(sh(`SELECT count(*) FROM daq_rollup WHERE line_id='ln-old' AND res_ms=60000`))
    assert.equal(oldRollupMinute, 0, `压缩 chunk 上过期 1m 聚合行应被裁光,实得 ${oldRollupMinute}`)
    const oldRollupHour = Number(sh(`SELECT count(*) FROM daq_rollup WHERE line_id='ln-old' AND res_ms=3600000`))
    assert.ok(oldRollupHour > 0, `1h 聚合(hourRetentionH=0 永久)不应被 minute 覆写误删,实得 ${oldRollupHour}`)
    // 长保留线不受误伤(压缩 + 裁剪并存语义)
    const keepAfter = Number(sh(`SELECT count(*) FROM daq_samples WHERE line_id='ln-keep'`))
    assert.equal(keepAfter, 9, `长保留线 35 天前样本在压缩后仍应保留 9 行,实得 ${keepAfter}`)
  }
  catch (error) {
    errors.push(error)
  }
  finally {
    try {
      await store?.close()
    }
    catch (error) {
      errors.push(error)
    }
    if (creationAttempted) {
      try {
        await cleanupContainer(docker, /^[a-f0-9]{64}$/.test(container ?? '') ? container! : name, name, owner, host, !/^[a-f0-9]{64}$/.test(container ?? ''))
      }
      catch (error) {
        errors.push(error)
      }
    }
  }
  combineErrors(errors)
})
