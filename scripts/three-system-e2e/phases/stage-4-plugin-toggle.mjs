/**
 * Stage 4:插件启停(热重载 → 工具与路由同时生灭)—— 原 L609–653
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, ROOT, api, envelopeData, ok, raw, sleep } from '../lib.mjs'
import { getChannelA, getLeadA, getUserToken } from '../state.mjs'

export async function run() {
  console.log('\n── Stage 4 插件启停 ──')
  const candidates = [join(ROOT, '.AgentWorkShop', 'plugins-state.json'), join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.AgentWorkShop', 'plugins-state.json')]
  const statePath = candidates.find(p => existsSync(p))
  ok(Boolean(statePath), '定位 plugins-state.json', statePath ?? '未找到')
  if (statePath && getLeadA()?.id) {
    const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
    const writeState = (obj) => {
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(obj, null, 2))
      renameSync(tmp, statePath)
    }
    const st0 = readState()
    const disabled0 = Array.isArray(st0.disabled) ? st0.disabled : []
    writeState({ ...st0, disabled: [...new Set([...disabled0, 'diag-bridge'])], updatedAt: new Date().toISOString() })
    // 热重载会停止并重建 agent 运行时,每轮重新取成员(拿最新 token)再断言
    const freshLead = async () => {
      const members = await api('GET', `/api/workshop/channels/${getChannelA()}/agents`, { token: getUserToken() })
      return (envelopeData(members) ?? []).find(m => m?.role === 'lead') ?? getLeadA()
    }
    let gone = false
    for (let i = 0; i < 40 && !gone; i++) { // 共享实例 agent 运行时重建慢,60s 窗
      await sleep(1500)
      const fl = await freshLead()
      const h = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: getUserToken() })
      const l = await api('GET', `/api/workshop/agent-tools/list?agentId=${fl.id}`, { agent: fl })
      const names4 = (l?.json?.data?.tools ?? l?.json?.tools ?? []).map(t => t?.name)
      gone = h.status === 404 && !names4.includes('diag_run')
    }
    ok(gone, '停用 diag-bridge → 路由 404 且 diag_run 从工具清单消失(热重载 + 工具注销)')

    writeState({ ...st0, disabled: disabled0, updatedAt: new Date().toISOString() })
    let back = false
    for (let i = 0; i < 25 && !back; i++) {
      await sleep(1500)
      const fl = await freshLead()
      const h = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: getUserToken() })
      const l = await api('GET', `/api/workshop/agent-tools/list?agentId=${fl.id}`, { agent: fl })
      const names4 = (l?.json?.data?.tools ?? l?.json?.tools ?? []).map(t => t?.name)
      back = h.status === 200 && names4.includes('diag_run')
    }
    ok(back, '重新启用 diag-bridge → 路由与工具恢复')
  }
}
