/**
 * scripts/onboarding/test-connection.mjs —— 逐驱动连接性预检(skill 阶段2)。
 * 输入 JSON:
 * {
 *   "tests": [
 *     {"label":"机筒SP(modbus-tcp)", "driver":"modbus-tcp", "driverConfig":{...}},
 *     {"label":"冷却水(mqtt)",       "driver":"mqtt",       "driverConfig":{...}},
 *     {"label":"MES读点",            "driver":"mes-rest",   "driverConfig":{...}, "domain":{"min":0,"max":100}}
 *   ]
 * }
 * 全部 ok 才退出 0——任一失败即停(skill 规定:连通性未全绿不得进入供给阶段)。
 * 用法:node scripts/onboarding/test-connection.mjs <config.json|-> (默认读 stdin)
 */
import { api, login, ok, summary, readConfig } from './lib.mjs'

const cfg = await readConfig()
const tok = await login()
// 兼容 onboard 统一配置:顶层 tests 或 connectivity.tests;空测试集必须显式失败,
// 不得以 0 通过/0 失败“静默全绿”放行(2026-10-20 实测踩坑)
const tests = Array.isArray(cfg.tests) ? cfg.tests : (Array.isArray(cfg.connectivity?.tests) ? cfg.connectivity.tests : [])
if (tests.length === 0) {
  ok('连接性预检配置', false, '未找到 tests 或 connectivity.tests;拒绝以空测试集放行')
  summary('连接性预检')
}
for (const tt of tests) {
  const label = tt.label ?? tt.driver
  const isMes = tt.driver === 'mes-rest'
  const endpoint = isMes ? '/api/workshop/dcw/mes-test-read' : '/api/workshop/daq/test-driver'
  const body = isMes
    ? { driverConfig: tt.driverConfig, domain: tt.domain ?? { min: 0, max: 100 } }
    : { driver: tt.driver, driverConfig: tt.driverConfig ?? {} }
  const t0 = Date.now()
  let j
  try {
    j = await api('POST', endpoint, body, tok)
  }
  catch (e) {
    ok(`连通[${label}]`, false, String(e).slice(0, 120))
    continue
  }
  const d = j.data ?? {}
  const res = d.test ?? d // 新信封 {test:{ok,...}};旧信封直接平铺
  const okFlag = isMes ? res.ok === true : (res.ok === true || res.sampleValue !== undefined)
  ok(`连通[${label}](${tt.driver})`, okFlag === true,
    `latency=${res.latencyMs ?? Date.now() - t0}ms ${res.message ?? (res.sampleValue !== undefined ? `sample=${res.sampleValue}` : '')}`.slice(0, 140))
}

summary('连接性预检')
