/**
 * 运行结束后的清理(删测试频道/工作区)
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */
import { api, section } from './lib.mjs'
import { ctx } from './state.mjs'

// ════════════════════════════════════════════════════════════════
// 清理
// ════════════════════════════════════════════════════════════════
export async function cleanup() {
  section('清理')
  const t = ctx.token
  try {
    if (ctx.line?.id) await api('POST', `/api/workshop/dcw/lines/${ctx.line.id}/stop`, { body: {}, token: t }).catch(() => {})
    if (ctx.channelId) await api('DELETE', `/api/workshop/channels/${ctx.channelId}?purge=1`, { token: t }).catch(() => {})
    for (const n of Object.values(ctx.dcw)) if (n?.id) await api('DELETE', `/api/workshop/dcw/${n.id}`, { token: t }).catch(() => {})
    for (const n of Object.values(ctx.daq)) if (n?.id) await api('DELETE', `/api/workshop/daq/${n.id}`, { token: t }).catch(() => {})
    if (ctx.recipe?.id) await api('DELETE', `/api/workshop/dcw/recipes/${ctx.recipe.id}`, { token: t }).catch(() => {})
    if (ctx.product?.id) await api('DELETE', `/api/workshop/dcw/products/${ctx.product.id}`, { token: t }).catch(() => {})
    if (ctx.line?.id) await api('DELETE', `/api/workshop/dcw/lines/${ctx.line.id}`, { token: t }).catch(() => {})
    console.log('  · 测试夹具已清理')
  }
  catch (err) {
    console.log(`  · 清理异常(不影响结果): ${err.message}`)
  }
}
