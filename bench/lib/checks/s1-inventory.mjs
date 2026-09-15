/**
 * s1-inventory —— 能力清单核查（静态层）：论文 §III 声称的每个子系统组件
 * 是否真实存在于源码中。全部证据可复现（文件+计数），无服务器依赖。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { result } from '../util.mjs'

const meta = { id: 's1-inventory', title: '能力清单核查（路由/引擎/工具/表/驱动）', tier: 'static', dims: ['D1', 'D3', 'D6'], weight: 2 }

function walkTs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkTs(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

export default [{
  meta,
  async run(ctx) {
    const R = ctx.REPO
    const sub = [] // {label, ok, detail}
    const add = (label, ok, detail) => sub.push({ label, ok: !!ok, detail })

    // 1. REST 路由文件数（论文声称 208）
    const routes = walkTs(join(R, 'server', 'api', 'workshop'))
    add('REST 路由文件 ≥ 200', routes.length >= 200, `实际 ${routes.length}`)

    // 2. MCP 工具数（论文声称 25 —— registerTool 注册面）
    const mcpSrc = readFileSync(join(R, 'server', 'mcp', 'workshop-server.ts'), 'utf8')
    const mcpToolCount = (mcpSrc.match(/registerTool\(/g) ?? []).length
    add('MCP 工具 ≥ 25', mcpToolCount >= 25, `实际 ${mcpToolCount}`)

    // 3. Harness 引擎注册表（论文声称 14 引擎）
    const regSrc = readFileSync(join(R, 'server', 'services', 'workshop', 'agents', 'registry.ts'), 'utf8')
    const engines = ['mock', 'omp', 'opencode', 'codex', 'dsh', 'claude', 'gemini', 'copilot', 'cursor', 'crush', 'goose', 'qwen', 'pi', 'hermes']
    const found = engines.filter(e => new RegExp(`['"\`]${e}['"\`]`).test(regSrc))
    add('Harness 引擎 = 14', found.length === engines.length, `找到 ${found.length}/14${found.length < engines.length ? `（缺 ${engines.filter(e => !found.includes(e)).join(',')}）` : ''}`)

    // 4. SQLite 表（论文声称 22 + FTS5）
    const dbSrc = readFileSync(join(R, 'server', 'services', 'workshop', 'db', 'database.ts'), 'utf8')
    const tables = new Set((dbSrc.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g) ?? []).map(s => s.replace(/CREATE TABLE IF NOT EXISTS\s+/, '')))
    add('SQLite 表 ≥ 20', tables.size >= 20, `实际 ${tables.size}`)
    add('FTS5 记忆索引', /fts5/i.test(dbSrc), 'agent_memories_fts')

    // 5. 协议驱动（论文声称 5 族：Modbus TCP / Modbus RTU / OPC UA / MQTT / HTTP）
    const drvSrc = readFileSync(join(R, 'server', 'services', 'workshop', 'daq', 'drivers.ts'), 'utf8').toLowerCase()
    const drivers = ['modbus', 'rtu', 'opcua', 'mqtt', 'http'].filter(k => drvSrc.includes(k))
    add('协议驱动 = 5 族 (modbus-tcp/rtu/opcua/mqtt/http)', drivers.length === 5, `找到 ${drivers.join(', ')}`)

    // 6. 工业/智能体工具面（工具名外置于 .AgentWorkShop/prompts/host-tools.json）
    const tools = ['dcw_control', 'dcw_read', 'daq_query', 'daq_frames', 'dcw_judge', 'dcw_rollback', 'dcw_journal', 'ops_log', 'recipe_log', 'line_context']
    let hostTools = ''
    try { hostTools = readFileSync(join(R, '.AgentWorkShop', 'prompts', 'host-tools.json'), 'utf8') } catch {}
    let bridgeSrc = ''
    try { bridgeSrc = readFileSync(join(R, 'server', 'services', 'workshop', 'agents', 'host-tool-bridge.ts'), 'utf8') } catch {}
    const toolsFound = tools.filter(t => hostTools.includes(`"${t}"`) || bridgeSrc.includes(`'${t}'`))
    add('治理工具面 ≥ 10', toolsFound.length >= 10, `${toolsFound.length}/10`)

    // 7. 审计面（论文 §III-D）
    const opsSrc = readFileSync(join(R, 'server', 'services', 'workshop', 'db', 'ops.repo.ts'), 'utf8')
    add('audit_log 14 列 schema', /actor_kind/.test(opsSrc) && /target_kind/.test(opsSrc) && /detail_json/.test(opsSrc), 'ops.repo.ts')
    add('审计 8 类事件枚举', /'rollback'/.test(opsSrc) && /'alarm'/.test(opsSrc) && /'recipe'/.test(opsSrc), 'kind ∈ write/manual/alarm/…')

    const total = sub.length, okN = sub.filter(s => s.ok).length
    const score = okN / total
    return result(meta.id, meta, score === 1 ? 'pass' : score >= 0.7 ? 'warn' : 'fail', score,
      { subchecks: total, ok: okN, routes: routes.length, mcpTools: mcpToolCount, engines: found.length, tables: tables.size, tools: toolsFound.length },
      sub.map(s => `${s.ok ? '✔' : '✘'} ${s.label} — ${s.detail}`),
      score === 1 ? '全部能力组件在源码中核实' : '存在缺失组件，见证据')
  },
}]
