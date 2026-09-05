/**
 * 模型目录冒烟:四引擎 provider/model 目录发现(含 effort 面)。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-catalog-smoke.ts
 */
async function main() {
  const m = await import('../server/services/workshop/agents/harness-models')
  const dsh = await m.harnessModelCatalog('dsh')
  console.log('dsh:', dsh.providers.map(p => `${p.id}(${p.models.length})`).join(','), '| mode:', dsh.effortMode)
  const omp = await m.harnessModelCatalog('omp')
  console.log('omp:', omp.providers.slice(0, 4).map(p => `${p.id}(${p.models.length})`).join(','), '| mode:', omp.effortMode)
  const ompZ = omp.providers.find(p => p.id === 'zhipu-coding-plan')
  console.log('omp zhipu sample:', ompZ?.models.slice(0, 3).map(x => `${x.id}[${x.efforts.join('/')}]`).join(', '))
  const oc = await m.harnessModelCatalog('opencode')
  console.log('opencode:', oc.providers.length, 'providers | mode:', oc.effortMode, '| note:', oc.note?.slice(0, 40))
  const cx = await m.harnessModelCatalog('codex')
  console.log('codex:', cx.providers.map(p => `${p.id}(${p.models.length})`).join(','), '| mode:', cx.effortMode)
  const cm = cx.providers[0]?.models[0]
  console.log('codex sample:', cm?.id, 'efforts:', cm?.efforts.join(','), 'default:', cm?.defaultEffort)
}
void main()
