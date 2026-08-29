/** 产线审计夹具:创建产线 → start/stop/cleanup(逐产线 API)。各 _dbg 脚本共用。 */

/**
 * 创建一条审计产线。
 * @returns {{ line: {id: string, name: string, color: string}, start: Function, stop: Function, cleanup: Function }}
 */
export async function makeLineFixture(ROOT, H, name = '审计产线') {
  const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
  const jdel = u => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
  const created = await jpost('/api/workshop/dcw/lines', { name })
  if (!created.data?.line) throw new Error(`makeLineFixture: 创建产线失败 ${JSON.stringify(created).slice(0, 120)}`)
  const line = created.data.line
  return {
    line,
    /** 开跑本产线(配方须挂本产线产品) */
    start: recipeId => jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId }),
    stop: () => jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {}),
    /** 停线 + 删线(节点/产品/配方自动解挂,不删数据) */
    cleanup: async () => {
      await jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {}).catch(() => {})
      await jdel(`/api/workshop/dcw/lines/${line.id}`)
    },
  }
}
