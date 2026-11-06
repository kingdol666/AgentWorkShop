/**
 * P0 安全回归（2026-11-03 Project 层审计）：
 *  - spawn 启动面：非 admin 不得覆盖 command/args/cwd/env
 *  - Channel workspace：普通用户只能使用平台 data/workspaces 或 data/projects
 *  - 更新路径只对变化的启动键做授权
 *  - Agent 对外 DTO：永不返回 token，config 剔除启动键
 *
 * 纯函数测试，不依赖 DB；避免 nitro #imports 副作用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  assertChannelWorkspaceAllowed,
  assertSpawnConfigAllowed,
  assertSpawnConfigPatchAllowed,
  changedSpawnOverridesOf,
  spawnOverridesOf,
} from '../server/services/workshop/agents/harness-spawn-policy'
import { channelAgentSummary } from '../server/services/workshop/agents/agent-dto'
import { AppError } from '../server/utils/errors'

/** 平台工作根之外；用相对当前工作目录的父目录，避免 Windows/Linux 路径语义差异。 */
const OUTSIDE_CWD = resolve(process.cwd(), '..', '__aw_outside_cwd__')

function isAppErrorCode(code: string) {
  return (err: unknown) => err instanceof AppError && err.code === code
}

test('spawn policy: 非 admin 覆盖 command/args/cwd/env 一律拒绝', () => {
  for (const config of [
    { command: 'cmd.exe' },
    { args: ['/c', 'whoami'] },
    { cwd: 'C:\\Windows' },
    { env: { PATH: 'C:\\Windows' } },
  ]) {
    assert.throws(
      () => assertSpawnConfigAllowed('omp', config, { role: 'user' }),
      isAppErrorCode('HARNESS_SPAWN_FORBIDDEN'),
    )
  }
})

test('spawn policy: 空覆盖/平台默认不触发', () => {
  assert.doesNotThrow(() => assertSpawnConfigAllowed('omp', {}, { role: 'user' }))
  assert.doesNotThrow(() => assertSpawnConfigAllowed('omp', { command: '' }, { role: 'user' }))
  assert.deepEqual(spawnOverridesOf({ command: '', args: [], env: {} }), [])
})

test('spawn policy: admin 只允许引擎自身命令，拒绝通用解释器', () => {
  assert.doesNotThrow(() => assertSpawnConfigAllowed('omp', { command: 'omp' }, { role: 'admin' }))
  assert.throws(
    () => assertSpawnConfigAllowed('omp', { command: 'cmd.exe' }, { role: 'admin' }),
    isAppErrorCode('HARNESS_COMMAND_DENIED'),
  )
})

test('spawn policy: admin 也不得把 cwd 指到平台根之外', () => {
  assert.throws(
    () => assertSpawnConfigAllowed('omp', { cwd: OUTSIDE_CWD }, { role: 'admin' }),
    isAppErrorCode('HARNESS_CWD_DENIED'),
  )
})

test('spawn patch: 未变化的启动键不误报，变化的启动键非 admin 拒绝', () => {
  const current = { model: 'x', command: 'omp' }
  const unchanged = { model: 'y', command: 'omp' }
  assert.deepEqual(changedSpawnOverridesOf(current, unchanged), [])
  assert.doesNotThrow(() => assertSpawnConfigPatchAllowed('omp', current, unchanged, { role: 'user' }))

  const changed = { model: 'y', command: 'cmd.exe' }
  assert.deepEqual(changedSpawnOverridesOf(current, changed), ['command'])
  assert.throws(
    () => assertSpawnConfigPatchAllowed('omp', current, changed, { role: 'user' }),
    isAppErrorCode('HARNESS_SPAWN_FORBIDDEN'),
  )
})

test('channel workspace: 普通用户只能在 data/workspaces 或 data/projects 下', () => {
  assert.doesNotThrow(() =>
    assertChannelWorkspaceAllowed('data/workspaces/ch-1', { role: 'user' }))
  assert.doesNotThrow(() =>
    assertChannelWorkspaceAllowed('data/projects/p-1/control', { role: 'user' }))
  assert.throws(
    () => assertChannelWorkspaceAllowed('C:\\Windows', { role: 'user' }),
    isAppErrorCode('CHANNEL_WORKSPACE_DENIED'),
  )
  assert.throws(
    () => assertChannelWorkspaceAllowed('data/workspaces/other', { role: 'user' }, 'ch-1'),
    isAppErrorCode('CHANNEL_WORKSPACE_DENIED'),
  )
})

test('channel workspace: admin 仍受平台根限制', () => {
  assert.doesNotThrow(() => assertChannelWorkspaceAllowed('data/workspaces/ch-1', { role: 'admin' }))
  assert.throws(
    () => assertChannelWorkspaceAllowed(OUTSIDE_CWD, { role: 'admin' }),
    isAppErrorCode('CHANNEL_WORKSPACE_DENIED'),
  )
})

test('agent DTO: 不返回 token；config 剔除启动键', () => {
  const summary = channelAgentSummary({
    id: 'a-1',
    channelId: 'ch-1',
    name: 'lead',
    harness: 'omp',
    role: 'lead',
    enabled: 1,
    templateId: 't-1',
    token: 'secret-token',
    config: {
      model: 'x',
      command: 'omp',
      args: ['--x'],
      cwd: 'C:\\Windows',
      env: { A: 'B' },
    },
  } as never, { includeConfig: true })

  assert.equal((summary as Record<string, unknown>).token, undefined)
  assert.deepEqual(summary.config, { model: 'x' })
  assert.equal(summary.id, 'a-1')
})
