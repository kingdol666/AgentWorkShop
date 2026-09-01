#!/usr/bin/env node
// ============================================================
// AgentWorkShop CLI — npm bin 入口
// `npm i -g agentworkshop` 后，终端里 `aw` / `agentworkshop` 即指向本文件。
// ============================================================
try {
  const { main } = await import('../cli/aw.mjs')
  process.exitCode = await main()
}
catch (err) {
  console.error('[aw] 启动失败:', err)
  process.exitCode = 1
}
