// ============================================================
// 指令:mcp — 工业 MCP stdio 服务(自动发现运行实例端口)
// ------------------------------------------------------------
// 面向外部 skill / MCP 客户端 / 工程师工作台:把平台 REST 的关键方法
// (产线/节点绑定/参数映射/频道与优化闭环/插件管理)暴露为 MCP 工具,
// 自动读取锁文件 .AgentWorkShop/.runtime/aw.lock 等发现真实端口并保活重连。
//   aw mcp                 启动 stdio 服务(供 MCP 客户端作为子进程拉起)
//   aw mcp --doctor        诊断:发现过程/健康/鉴权状态一次讲清
//   aw mcp --print-config  打印 MCP 客户端配置 JSON(claude/codex 等通用)
// 环境变量:AW_BASE_URL / AW_PORT / AW_HOME / AW_TOKEN / AW_EMAIL / AW_PASSWORD
// ============================================================
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { color } from '../core/logger.mjs'

/** 本文件位于 <packageRoot>/cli/commands/,故包根 = 上两级 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER_SCRIPT = join(PACKAGE_ROOT, 'mcp', 'aw-mcp-server.mjs')

export const meta = {
  name: 'mcp',
  aliases: ['mcps'],
  group: '扩展',
  summary: '工业 MCP stdio 服务(自动发现实例端口;skill/Agent 集成入口)',
  usage: 'aw mcp [--doctor] [--print-config] [--base <url>] [--port <n>]',
  short: {},
  description: [
    '把平台关键 REST 方法(产线/节点绑定/参数映射/配方开跑/优化闭环频道/插件)',
    '暴露为 35 个 MCP 工具;自动从锁文件/惯例端口/config.yml 发现运行实例并保活重连。',
    '鉴权:AW_TOKEN 或 AW_EMAIL+AW_PASSWORD 环境变量,或客户端在会话里调 aw_login 工具。',
    'skills/:aw-node-bind / aw-opt-channel / aw-plugin-dev 三个技能均以本服务为执行底座。',
  ],
  needsProject: false,
}

async function doctor() {
  const { discoverWithReport, readMcpEnabled } = await import('../../mcp/discovery.mjs')
  const enabled = readMcpEnabled({ cwd: process.cwd(), env: process.env })
  const report = await discoverWithReport({ cwd: process.cwd(), env: process.env })

  console.log('')
  console.log(color.bold('aw mcp 诊断') + color.dim('  —— 集成开关 → 实例发现 → 健康 → 鉴权'))
  console.log('')
  console.log(`  ${enabled ? color.green('✔ MCP 集成开关:已启用') : color.yellow('· MCP 集成开关:停用')}  ${color.dim('(系统设置 → MCP 集成 → 启动 MCP 集成;env AW_MCP_ENABLED 可覆盖)')}`)
  if (!enabled) console.log(`    ${color.dim('停用期间除 aw_status 外的所有 MCP 工具调用都会被拒绝')}`)
  console.log('')
  if (!report.hit) {
    console.log(`  ${color.red('✖ 未发现运行实例')}(探测记录如下)`)
  }
  else {
    const h = report.hit.health
    console.log(`  ${color.green('✔ 实例')}  ${color.cyan(report.hit.base)}  ${color.dim(`经 ${report.hit.source}`)}`)
    console.log(`  ${color.cyan('健康')}    app=${h.app} version=${h.version} mode=${h.mode} workshop=${h.workshop} uptime=${Math.round((h.uptimeMs ?? 0) / 1000)}s`)
  }
  for (const c of report.candidates) {
    const mark = c.ok ? color.green('✔') : color.dim('·')
    console.log(`    ${mark} ${c.base.padEnd(26)} ${c.source}`)
  }
  console.log('')

  if (report.hit) {
    const token = process.env.AW_TOKEN
    const email = process.env.AW_EMAIL
    const password = process.env.AW_PASSWORD
    if (token || (email && password)) {
      try {
        const headers = token ? { authorization: `Bearer ${token}` } : { 'content-type': 'application/json' }
        let res
        if (token) {
          res = await fetch(`${report.hit.base}/api/users/me`, { headers, signal: AbortSignal.timeout(5000) })
        }
        else {
          res = await fetch(`${report.hit.base}/api/users/login`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ email, password }),
            signal: AbortSignal.timeout(5000),
          })
        }
        const json = await res.json().catch(() => null)
        if (res.ok) {
          console.log(`  ${color.green('✔ 鉴权')}  ${json?.data?.user ? `user=${json.data.user.name}(${json.data.user.role})` : 'token 有效'}`)
        }
        else {
          console.log(`  ${color.red('✖ 鉴权失败')}  HTTP ${res.status}: ${json?.message ?? res.statusText}`)
          process.exitCode = 1
        }
      }
      catch (err) {
        console.log(`  ${color.red('✖ 鉴权探测异常')}  ${err.message}`)
        process.exitCode = 1
      }
    }
    else {
      console.log(`  ${color.yellow('· 鉴权')}   未配置(AW_TOKEN 或 AW_EMAIL+AW_PASSWORD)。MCP 会话内可用 aw_login 工具补齐;`)
      console.log('           实例从未初始化管理员时,先在 Web /setup 注册(首注册即 admin)。')
    }
  }
  else {
    process.exitCode = 1
    console.log(`  ${color.dim('提示')}  aw start 启动实例后重试;或 AW_BASE_URL=http://127.0.0.1:<端口> 显式指定。`)
  }
  console.log('')
}

function printConfig(flags) {
  const env = {}
  if (flags.base) env.AW_BASE_URL = flags.base
  if (flags.port) env.AW_PORT = String(flags.port)
  if (process.env.AW_HOME) env.AW_HOME = process.env.AW_HOME
  if (process.env.AW_TOKEN) env.AW_TOKEN = process.env.AW_TOKEN
  if (process.env.AW_EMAIL) env.AW_EMAIL = process.env.AW_EMAIL
  if (process.env.AW_PASSWORD) env.AW_PASSWORD = process.env.AW_PASSWORD
  const config = {
    mcpServers: {
      aw: {
        command: 'node',
        args: [SERVER_SCRIPT],
        env,
      },
    },
  }
  console.log('')
  console.log(color.bold('MCP 客户端配置') + color.dim('  —— 粘贴到 claude_desktop_config.json / codex config.toml 对应段'))
  console.log('')
  console.log(JSON.stringify(config, null, 2))
  console.log('')
  console.log(color.dim(`服务脚本: ${SERVER_SCRIPT}${existsSync(SERVER_SCRIPT) ? '' : color.red('(缺失!)')}`))
  console.log(color.dim('codex 等价写法: [mcp_servers.aw] command="node" args=["<上述脚本>"]'))
  console.log('')
}

export async function run(argv) {
  const { flags } = argv
  if (!existsSync(SERVER_SCRIPT)) {
    console.error(color.red(`✖ MCP 服务脚本缺失: ${SERVER_SCRIPT}`))
    return 1
  }
  if (flags.doctor) {
    await doctor()
    return process.exitCode ?? 0
  }
  if (flags['print-config']) {
    printConfig(flags)
    return 0
  }
  // 旗标 → 环境变量后进入 stdio 主循环
  if (flags.base) process.env.AW_BASE_URL = flags.base
  if (flags.port) process.env.AW_PORT = String(flags.port)
  const { runStdio } = await import('../../mcp/aw-mcp-server.mjs')
  runStdio()
  return 0
}
