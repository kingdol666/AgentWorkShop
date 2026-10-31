/**
 * 测试总入口 —— 顺序跑引擎自测 + 四协议自测(无子进程,动态 import 串行执行)。
 * 协议测试前置:模拟器运行中(4010)且已应用 film-line 预设。
 */
let failed = 0
const SUITES = [
  './engine-signals.test.ts',
  './plant-model.test.ts',
  './biax-model.test.ts',
  './scenario-models.test.ts',
  './protocol-modbus.test.ts',
  './protocol-opcua.test.ts',
  './protocol-mqtt.test.ts',
  './protocol-http.test.ts',
] as const

for (const s of SUITES) {
  console.log(`\n━━━ ${s} ━━━`)
  process.exitCode = 0
  try {
    await import(/* @vite-ignore */ s)
    if (process.exitCode !== 0) failed++
  }
  catch (err) {
    console.error(`套件异常: ${(err as Error).message}`)
    failed++
  }
}
console.log(failed === 0 ? '\n全部自测通过 ✅' : `\n${failed} 个套件失败 ❌`)
process.exitCode = failed > 0 ? 1 : 0
export {}
