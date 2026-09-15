/**
 * api-0-preflight —— API 层门卫：登录实例并确认可写权限。
 * 失败时 api 层全部诚实跳过（run.mjs 依据 ctx.serverUp 裁决）。
 */
import { result, skip } from '../util.mjs'

const meta = { id: 'api-0-preflight', title: '实例连通与鉴权', tier: 'api', dims: [], weight: 0, requires: [] }

export default [{
  meta,
  async run(ctx) {
    const email = process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local'
    const password = process.env.AW_ADMIN_PASS ?? 'admin123'
    try {
      const r = await ctx.api.login(email, password)
      if (r.ok) {
        ctx.serverUp = true
        return result(meta.id, meta, 'pass', 1, { how: r.how, role: r.role }, [`登录成功（${r.how}，role=${r.role}）`], `实例 ${ctx.base} 可用`)
      }
      return skip(meta.id, meta, `实例可达但鉴权失败（${r.how}）——请设置 AW_ADMIN_EMAIL/AW_ADMIN_PASS`)
    } catch (err) {
      return skip(meta.id, meta, `实例 ${ctx.base} 不可达（${String(err?.cause?.code ?? err?.message ?? err)}）——先启动平台：pnpm start 或 aw start`)
    }
  },
}]
