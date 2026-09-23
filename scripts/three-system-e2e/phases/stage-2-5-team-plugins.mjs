/**
 * Stage 2.5:团队插件链(建队勾选 → 团队开关 → 部署传导 → channel 工具过滤)—— 原 L464–540
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 */
import { api, envelopeData, invoke, ok, resultText, sleep } from '../lib.mjs'
import { getUserToken } from '../state.mjs'

export async function run() {
  console.log('\n── Stage 2.5 团队插件链(建队勾选/部署传导/按 Channel 过滤)──')

  const tplRes = await api('POST', '/api/workshop/agents', {
    token: getUserToken(),
    body: { name: `插件链执行器-${Date.now().toString(36)}`, harness: 'mock' },
  })
  const tplId = envelopeData(tplRes)?.id
  ok(Boolean(tplId), '成员 Agent 模板创建', tplId ?? JSON.stringify(tplRes.json).slice(0, 100))

  const teamName = `插件链团队-${Date.now().toString(36)}`
  const teamRes = await api('POST', '/api/workshop/teams', {
    token: getUserToken(),
    body: {
      name: teamName,
      plugins: [{ name: 'rag-bridge', enabled: false }, { name: 'diag-bridge', enabled: true }],
    },
  })
  const team = envelopeData(teamRes)
  ok(Boolean(team?.id), '建队带 plugins 勾选(POST /teams 落团队偏好)', team?.id ?? JSON.stringify(teamRes.json).slice(0, 120))

  if (team?.id) {
    await api('POST', `/api/workshop/teams/${team.id}/members`, { token: getUserToken(), body: { agentId: tplId, role: 'worker' } })
    // ① 团队插件视图(team 作用域端点)
    const tp = await api('GET', `/api/workshop/teams/${team.id}/plugins`, { token: getUserToken() })
    const tpRows = envelopeData(tp)?.plugins ?? []
    ok(envelopeData(tp)?.source === 'explicit'
      && tpRows.find(p => p.name === 'rag-bridge')?.enabled === false
      && tpRows.find(p => p.name === 'diag-bridge')?.enabled === true,
    'GET /teams/:id/plugins 显式视图(rag-bridge 关 / diag-bridge 开)', JSON.stringify(tpRows.map(p => [p.name, p.enabled])))

    // ② 部署到新 channel → 团队开关传导
    const chRes = await api('POST', '/api/workshop/channels', {
      token: getUserToken(),
      body: { name: `插件链频道-${Date.now().toString(36)}`, description: '三系统 e2e 团队插件链' },
    })
    const channelId = envelopeData(chRes)?.channelId ?? ''
    ok(Boolean(channelId), '空频道创建(部署目标)', channelId)
    if (channelId) {
      const dep = await api('POST', `/api/workshop/teams/${team.id}/deploy`, { token: getUserToken(), body: { channelId } })
      const depAgents = envelopeData(dep)?.agents ?? []
      ok(dep.status === 200 && depAgents.length > 0, '团队部署到频道(成员克隆)', `agents=${depAgents.length}`)
      const cp = await api('GET', `/api/workshop/channels/${channelId}/plugins`, { token: getUserToken() })
      const cpRows = envelopeData(cp)?.plugins ?? []
      ok(envelopeData(cp)?.source === 'explicit'
        && cpRows.find(p => p.name === 'rag-bridge')?.enabled === false,
      '团队插件开关随部署传导到 channel', JSON.stringify(cpRows.map(p => [p.name, p.enabled])))

      // ③ 工具清单过滤:kb_*(rag-bridge 关)不可见,diag_*(开)可见
      const member = depAgents[0]
      const list1 = await api('GET', `/api/workshop/agent-tools/list?agentId=${member.id}`, { agent: member })
      const names1 = (list1?.json?.data?.tools ?? list1?.json?.tools ?? []).map(t => t?.name)
      ok(!names1.includes('kb_search') && !names1.includes('kb_store') && !names1.includes('kb_index'),
        '关闭插件的工具不注入该团队(kb_* 从清单消失)')
      ok(names1.includes('diag_run') && names1.includes('diag_status'), '开启插件的工具正常注入(diag_*)')

      // ④ dispatch 同源拒绝:关掉的插件工具直调被拒
      const denied = await invoke(member, 'kb_search', { query: '不应执行' }, 30000)
      ok(resultText(denied).includes('未启用插件'), 'dispatch 层同源拒绝(团队未启用插件)', resultText(denied).slice(0, 60))

      // ⑤ channel 级反转:重新开启 rag-bridge → 工具即时回归(热通知)
      const put5 = await api('PUT', `/api/workshop/channels/${channelId}/plugins`, {
        token: getUserToken(),
        body: { plugins: [{ name: 'rag-bridge', enabled: true }, { name: 'diag-bridge', enabled: true }] },
      })
      ok(put5.status === 200, 'channel 级插件开关 PUT(rag-bridge 重开)')
      let back5 = false
      for (let i = 0; i < 8 && !back5; i++) {
        await sleep(1000)
        const list5 = await api('GET', `/api/workshop/agent-tools/list?agentId=${member.id}`, { agent: member })
        const names5 = (list5?.json?.data?.tools ?? list5?.json?.tools ?? []).map(t => t?.name)
        if (names5.includes('kb_search')) back5 = true
      }
      ok(back5, '重开后 kb_search 回归工具清单(热刷新 ≤ 数秒)')
    }
  }
}
