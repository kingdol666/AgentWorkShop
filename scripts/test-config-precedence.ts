/**
 * 配置驱动回归:优先级链(env > runtime-settings > config.yml > 描述符默认)+
 * 历史别名兼容 + 项目级(.AgentWorkShop)优先/用户级(~/.AgentWorkShop)兜底的路径判定。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-config-precedence.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const root = mkdtemp()
function mkdtemp(): string {
  return rm0(join(tmpdir(), 'aw-cfg-prec-'))
  function rm0(p: string): string {
    const dir = `${p}${Math.random().toString(36).slice(2, 8)}`
    mkdirSync(dir, { recursive: true })
    return dir
  }
}

const engine = await import('../shared/config/engine.mjs')
const { loadDescriptors, envOverridesFromEnv, loadEffective } = engine as unknown as {
  loadDescriptors: () => Array<Record<string, unknown>>
  envOverridesFromEnv: (env: Record<string, string | undefined>, d?: unknown) => Record<string, unknown>
  loadEffective: (o: { configPath?: string, settingsPath?: string, env?: Record<string, string | undefined> }) => { effective: Record<string, unknown>, sources: Record<string, string> }
}

// ===== 1. 描述符完整性:每个键都有 default + labelKey;别名唯一 =====
{
  const descs = loadDescriptors() as Array<{ key: string, default?: unknown, labelKey?: string, aliases?: string[] }>
  check(`描述符规模(≥62 键,当前 ${descs.length})`, descs.length >= 62)
  check('全部键带 default 与 labelKey', descs.every(d => d.default !== undefined && !!d.labelKey))
  const seen = new Map<string, string>()
  let dup = ''
  for (const d of descs) {
    for (const a of [d.key, ...(d.aliases ?? [])].map(x => x.toUpperCase())) {
      if (seen.has(a) && seen.get(a) !== d.key) dup = `${a}:${seen.get(a)}&${d.key}`
      seen.set(a, d.key)
    }
  }
  check('键+别名无冲突', dup === '')
  // 新迁移组抽查
  const keys = new Set(descs.map(d => d.key))
  for (const k of ['memory.inject_total', 'omp.compact_enabled', 'dcw.rollback_stale_ms', 'backup.keep', 'retention.audit_days', 'log.level', 'daq.mqtt.qos', 'daq.frameRetentionH', 'security.hitl_timeout_ms', 'workshop.idle_grace_ms']) {
    if (!keys.has(k)) {
      check(`迁移键 ${k} 已注册`, false)
      failures++
    }
  }
  check('迁移键抽查全部注册', true)
}

// ===== 2. env 覆盖:AW_<KEY> 自动名 + 历史别名 =====
{
  const o = envOverridesFromEnv({
    AW_MEMORY_INJECT_TOTAL: '800',
    DAQ_FRAME_RETENTION_H: '999', // 历史别名(无 AW_ 前缀)
    RETENTION_DISABLED: '1', // 历史别名(boolean "1")
    AWSHOP_LOG_LEVEL: 'warn',
  })
  check('AW_<KEY> 自动名覆盖', o['memory.inject_total'] === 800)
  check('历史别名:DAQ_FRAME_RETENTION_H', o['daq.frameRetentionH'] === 999)
  check('历史别名 boolean "1"', o['retention.disabled'] === true)
  check('历史别名:AWSHOP_LOG_LEVEL', o['log.level'] === 'warn')
}

// ===== 3. 完整优先级链:env > runtime-settings > config.yml > 描述符默认 =====
{
  const configPath = join(root, 'config.yml')
  const settingsPath = join(root, 'runtime-settings.json')
  writeFileSync(configPath, [
    'memory:',
    '  primer_tokens: 111',
    'backup:',
    '  keep: 5',
    'log:',
    '  level: warn',
  ].join('\n'))
  writeFileSync(settingsPath, JSON.stringify({ version: 1, overrides: { 'memory.primer_tokens': 222 } }))
  const eff = loadEffective({ configPath, settingsPath, env: { AW_MEMORY_INJECT_TOTAL: '800', BACKUP_KEEP: '3' } })
  check('env 胜 runtime(memory.inject_total=800)', eff.effective['memory.inject_total'] === 800 && eff.sources['memory.inject_total'] === 'env')
  check('runtime 胜 config.yml(memory.primer_tokens=222)', eff.effective['memory.primer_tokens'] === 222 && eff.sources['memory.primer_tokens'] === 'runtime')
  check('config.yml 胜默认(log.level=warn)', eff.effective['log.level'] === 'warn' && eff.sources['log.level'] === 'config.yml')
  check('描述符默认兜底(dcw.rollback_cooldown_ms=300000)', eff.effective['dcw.rollback_cooldown_ms'] === 300000)
  check('别名 env 胜 config.yml(backup.keep=3)', eff.effective['backup.keep'] === 3 && eff.sources['backup.keep'] === 'env')
}

// ===== 4. 项目级优先 / 用户级兜底(resolveRunMode 路径判定) =====
{
  const home = await import('../shared/config/home.mjs') as unknown as {
    resolveRunMode: (o: { cwd: string, packageRoot?: string, env?: Record<string, string | undefined> }) => { mode: string, configRoot: string, dataDir: string, configPath: string, settingsPath: string }
    awHome: (env?: Record<string, string | undefined>) => string
    ensureDataDir: (cwd?: string, env?: Record<string, string | undefined>) => string
  }
  // ④a 项目级:cwd 下存在 .AgentWorkShop → 用它(最高优先)
  const proj = join(root, 'proj')
  mkdirSync(join(proj, '.AgentWorkShop'), { recursive: true })
  const m1 = home.resolveRunMode({ cwd: proj, packageRoot: join(root, 'pkg') })
  check('④项目级 .AgentWorkShop 优先', m1.mode === 'repo' && m1.configRoot === join(proj, '.AgentWorkShop'), m1.configRoot)

  // ④b 用户级兜底:检出内无 ./.AgentWorkShop → 数据落 ~/.AgentWorkShop(AW_HOME 可重定向)
  const fakeHome = join(root, 'fake-home')
  const m2 = home.resolveRunMode({ cwd: join(root, 'empty-cwd'), packageRoot: join(root, 'pkg'), env: { AW_HOME: fakeHome } })
  check('④无项目根 → 用户级兜底 ~/.AgentWorkShop(AW_HOME)', m2.configRoot === fakeHome, m2.configRoot)
  mkdirSync(fakeHome, { recursive: true })
  const dataDir = home.ensureDataDir(join(root, 'empty-cwd'), { AW_HOME: fakeHome })
  check('④ensureDataDir 初始化创建 <home>/data', dataDir === join(fakeHome, 'data'), dataDir)

  // ④c home 模式(AW_MODE=home,全局安装载荷):强制用户级
  const m3 = home.resolveRunMode({ cwd: proj, packageRoot: join(root, 'pkg'), env: { AW_MODE: 'home', AW_HOME: fakeHome } })
  check('④AW_MODE=home 强制用户级(项目 .AgentWorkShop 不采用)', m3.mode === 'home' && m3.configRoot === fakeHome)

  // ④d 默认 awHome = ~/.AgentWorkShop
  check('④awHome 默认 ~/.AgentWorkShop', /AgentWorkShop$/.test(home.awHome({})) === true, home.awHome({}))
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nCONFIG-PRECEDENCE ALL PASS' : `\nCONFIG-PRECEDENCE FAILED(${failures})`)
process.exit(failures === 0 ? 0 : 1)
