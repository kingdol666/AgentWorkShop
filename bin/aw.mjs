#!/usr/bin/env node
// ============================================================
// AgentWorkShop CLI — npm bin 入口
// `npm i -g agentworkshop` 后，终端里 `aw` / `agentworkshop` 即指向本文件。
// ============================================================
// 必须 process.exit(code) 而不是 process.exitCode = await main():
// stdout/stderr 是管道(重定向 / CI / 父进程 spawn 捕获)时,句柄会保活事件循环,
// Node 在顶层 await 下会以 **退出码 13**(ERR_UNSETTLED_TOP_LEVEL_AWAIT)收场,
// 把 `aw --help` 这类纯诊断指令的成功退出写成 13 且输出为空。
// process.exit 会同步 flush 已排队的 stdio 写入(writev 直写 fd)。
try {
  const { main } = await import('../cli/aw.mjs')
  process.exit(await main())
}
catch (err) {
  console.error('[aw] 启动失败:', err)
  process.exit(1)
}
