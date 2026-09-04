/**
 * registry 冒烟:全部 harness 注册与能力面(调试脚本)。
 * 运行:npx tsx scripts/_dbg-registry-smoke.ts
 */
async function main() {
  const m = await import('../server/services/workshop/agents/registry')
  const metas = m.harnessMetas()
  console.log('harnesses:', metas.map(h => h.id).join(','))
  for (const h of metas) {
    console.log(`  ${h.id}: caps=${JSON.stringify(h.capabilities)}`)
  }
  void main
}
void main()
