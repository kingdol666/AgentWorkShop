/**
 * 前端契约守卫(2026-11-10 审计 B2/B5)。
 *
 * B2:4 个高危写在开启双人复核时返回 202 `{pending:true, requestId}`,前端旧实现
 *     把它当成功(删节点本地 splice / 读 run.results TypeError / 控制网关静默无操作)。
 * B5:apiFetch 的 401 只抛 ApiError,不像 axios 那样清登录态 + 弹登录框;
 *     65 处调用点在凭据过期时不自愈。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isPendingApproval } from '../app/utils/pending-approval'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

test('B2: isPendingApproval 只认显式 pending===true', () => {
  assert.equal(isPendingApproval({ pending: true, requestId: 'ap-1' }), true)
  assert.equal(isPendingApproval({ pending: false }), false)
  assert.equal(isPendingApproval({ pending: 'true' }), false, '字符串真值不算(防契约漂移)')
  assert.equal(isPendingApproval({ results: [] }), false)
  assert.equal(isPendingApproval(null), false)
  assert.equal(isPendingApproval(undefined), false)
  assert.equal(isPendingApproval([]), false)
})

test('B2: 四个 202 端点消费点都判 pending,不再当成功', () => {
  const stream = read('app/composables/workshop/useDcwStream.ts')
  // removeNode / startStop / rollbackOptimization 三处
  const rejectCalls = stream.match(/rejectPending\(data\)/g) ?? []
  assert.ok(rejectCalls.length >= 3, `useDcwStream 必须有 ≥3 处 pending 判定,实际 ${rejectCalls.length}`)
  assert.match(stream, /function rejectPending/, '统一判定函数缺失')
  assert.match(stream, /APPROVAL_PENDING/, '待批核必须以可读错误上抛,不能静默成功')

  const recipes = read('app/pages/dcw/composables/useDcwRecipes.ts')
  assert.match(recipes, /isPendingApproval\(run\)/, '整批下发必须先判 pending,否则读 run.results 会 TypeError')
})

test('B5: apiFetch 与 axios 共用 401 收尾，浏览器凭据由 HttpOnly session 承载', () => {
  const client = read('app/composables/workshop/apiClient.ts')
  assert.match(client, /handleAuthExpired\(\)/, 'apiFetch 401 必须触发统一收尾')
  assert.match(client, /readAuthToken\(\)/, 'apiFetch 必须与显式 API token 读取同源')

  const http = read('app/plugins/http.ts')
  assert.match(http, /handleAuthExpired\(\)/, 'axios 侧应复用同一收尾(避免两份实现漂移)')
  assert.match(http, /readAuthToken\(\)/, 'axios 侧应复用显式 API token 读取')

  const util = read('app/utils/auth-session.ts')
  const apiToken = read('app/utils/api-token.ts')
  assert.doesNotMatch(util, /localStorage\.getItem\(['"]aw\.token['"]\)/, '浏览器长期 Bearer 不得从 localStorage 恢复')
  assert.match(apiToken, /__awApiToken/, '显式 API token 只能驻留内存')
  assert.match(util, /openLogin\('expired'\)/, '401 收尾必须给登录入口')
})

test('B3: 会话清单用 Summary 类型(列表只回 4 字段),详情才用完整 brief', () => {
  const api = read('app/composables/workshop/useWorkshopApi.ts')
  assert.match(api, /interface ChannelSessionSummaryDto/, '必须拆出列表行类型')
  assert.match(api, /listChannelSessions: \(id: string\) => http\.get<\{ data: ChannelSessionSummaryDto\[\] \}>/, '列表必须用 Summary 类型')
})

test('B4: /workshop/plugins 已收口信封,前端不再双形状兼容', () => {
  const srv = read('server/api/workshop/plugins/index.get.ts')
  assert.match(srv, /defineApiHandler/, '端点必须走统一信封')
  assert.ok(!/defineEventHandler/.test(srv), '不得保留裸 defineEventHandler')

  const admin = read('app/composables/workshop/usePluginAdmin.ts')
  assert.ok(!/res\?\.plugins \?\?/.test(admin), '不得再保留非信封兜底分支')
  const page = read('app/pages/plugins/index.vue')
  assert.match(page, /d\.data\?\.plugins/, '消费方必须读信封的 data')
})

test('H10/H9: agent.block 前端面与文本孪生同组可见 + 组件侧载荷防御', () => {
  const store = read('app/stores/workshop/events.ts')
  assert.match(
    store,
    /messages: \[[^\]]*'agent\.block'[^\]]*\]/,
    '「消息」过滤必须收录 agent.block(与文本孪生 agent.status.message 同组,过滤面不对称=工具帧消失)',
  )
  const tool = read('app/components/workshop/blocks/ClusterTool.vue')
  assert.match(tool, /isAgentToolBlock\(/, '结构块渲染前必须过 isAgentToolBlock(回放路径载荷原样进组件)')
  assert.match(tool, /#shared\/agent-blocks/, '防御判别必须从 shared 协议模块导入(与服务端同源)')
})
