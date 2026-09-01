// ============================================================
// 指令:doctor — 环境与项目健康检查
// ============================================================
import { existsSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { color } from '../core/logger.mjs'
import { findRunningServer } from '../core/context.mjs'

export const meta = {
  name: 'doctor',
  aliases: ['dsk', 'check-env'],
  group: '诊断',
  summary: '环境 / 项目 / 配置健康检查',
  usage: 'aw doctor [--json]',
  needsProject: false,
}

export async function run(argv, ctx) {
  const checks = []
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail })

  // ── Node / 包管理器 ──
  const nodeMajor = Number(process.versions.node.split('.')[0])
  add('Node.js 版本', nodeMajor >= 20, `v${process.versions.node}${nodeMajor < 23.4 ? '（推荐 ≥23.4：node:sqlite）' : ''}`)
  const { spawnSync } = await import('node:child_process')
  // Windows 下 spawnSync 不带 shell 找不到 pnpm.cmd,按平台补探测
  const pmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const pm = spawnSync(pmBin, ['--version'], { encoding: 'utf8' })
  add('pnpm 可用', pm.status === 0, pm.status === 0 ? `v${pm.stdout.trim()}` : '未找到 pnpm')

  // ── AW Home（全局安装模式的配置中枢;两种模式都检查） ──
  const home = ctx.home
  add('AW Home 目录', existsSync(home), `${home}${existsSync(home) ? '' : '（aw home 可初始化）'}`)
  add('AW Home config.yml', existsSync(join(home, 'config.yml')), join(home, 'config.yml'))
  const homeEnv = join(home, '.env')
  add('AW Home .env 密钥', existsSync(homeEnv), existsSync(homeEnv) ? '已生成(含随机 session 密钥)' : '未生成(aw home 可初始化)')

  // ── 项目上下文 ──
  if (ctx.root) {
    add('项目检测', true, ctx.root)
    const cfg = ctx.config.load()
    add('config.yml 可解析', Boolean(cfg.descriptors.length), `${cfg.descriptors.length} 个设置项`)
    const v = ctx.config.validate()
    add('配置校验', v.ok, v.ok ? `runtime 覆盖 ${v.overridesChecked} 项` : Object.keys(v.keys).join(', '))

    // 数据目录可写
    const dataDir = join(ctx.root, 'data')
    try {
      accessSync(dataDir, constants.W_OK)
      add('data/ 可写', true, dataDir)
    }
    catch {
      add('data/ 可写', false, dataDir)
    }

    // 端口情形
    const eff = cfg.effective
    const devPort = eff['server.dev.port']
    const prodPort = eff['server.prod.port']
    const server = await findRunningServer(ctx.config, { timeoutMs: 600 })
    add('运行中服务', Boolean(server), server ? `检测到 ${server.port} 端口 /api/system/config 响应` : '无（dev/prod 均未运行）')
    const occupied = await checkPorts([devPort, prodPort].filter((p, i, a) => a.indexOf(p) === i))
    for (const occ of occupied) {
      add(`端口 ${occ.port}`, !occ.busy, occ.busy ? '已被占用' : '空闲')
    }

    // 生产密钥
    const sess = eff.security?.sessionPassword ?? ctx.env.NUXT_SESSION_PASSWORD
    const isDefault = /change-me|awshop-dev-secret/.test(String(sess))
    add('生产 session 密钥', !isDefault, isDefault ? '仍是默认值（生产部署前必须更换）' : '已自定义（或由 env 提供）')

    // 产物
    add('生产构建存在', existsSync(join(ctx.root, '.output', 'server', 'index.mjs')), existsSync(join(ctx.root, '.output', 'server', 'index.mjs')) ? '.output/server/index.mjs' : '尚未 aw build')
  }
  else {
    add('项目检测', false, '当前目录未找到 config.yml（可在项目目录运行，或 aw init 新建）')
  }

  // ── 指令注册表 ──
  const cmds = ctx.registry.list()
  const failed = ctx.registry.failures
  add('指令注册', failed.length === 0, `${cmds.length} 条指令${failed.length ? `，${failed.length} 个加载失败` : ''}`)
  for (const f of failed) checks.push({ name: `  加载失败: ${f.source}`, pass: false, detail: f.error })

  // ── 输出 ──
  if (ctx.json) {
    console.log(JSON.stringify({ ok: checks.every(c => c.pass), checks }, null, 2))
    return checks.every(c => c.pass) ? 0 : 1
  }
  console.log('')
  console.log(`${color.bold('AgentWorkShop doctor')}  ${color.dim('— 环境与项目健康检查')}`)
  console.log('')
  let fail = 0
  for (const c of checks) {
    if (!c.pass) fail++
    const icon = c.pass ? color.green('✔') : color.red('✖')
    console.log(`  ${icon} ${c.name.padEnd(22)} ${color.dim(c.detail ?? '')}`)
  }
  console.log('')
  console.log(fail === 0 ? `${color.green(`全部通过 (${checks.length} 项)`)}` : `${color.red(`发现 ${fail} 项异常`)}`)
  return fail ? 1 : 0
}

async function checkPorts(ports) {
  const { createConnection } = await import('node:net')
  return Promise.all(ports.map(port => new Promise((resolve2) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    let done = false
    const finish = (busy) => {
      if (!done) {
        done = true
        socket.destroy()
        resolve2({ port, busy })
      }
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    setTimeout(() => finish(false), 700)
  })))
}
