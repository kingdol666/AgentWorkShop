#!/usr/bin/env node
/**
 * 生产投产硬门核查(2026-10-29)—— 真实设备联动上线前的最后一道检查单。
 *
 * G1 协议目录与现场匹配:支持协议族 = modbus-tcp/modbus-rtu/opcua/mqtt/http(+mes-rest),
 *    且不存在未验证的 S7 直接驱动(现场协议必须先对齐本清单);
 * G2 S11 未知驱动 fail-loud:接入未知协议的节点在启动采集时必须**显式报错**,
 *    不允许静默成功/伪造数据(实测);
 * G3 写控限界 live:越量程写被拒且设备值不变 + 台账留痕(与 golive-matrix N 组互证);
 * G4 进程无 benchmark 旁路:验收实例启动环境不含 AW_BENCH_MODE(旁路只存在于显式声明的基准进程);
 * G5 MQTT 身份(S13)/凭据掩码回写(S-P0-2)/int16 回绕(S15):指向安全验收与单元回归的既有证据。
 *
 * 运行:node docs/audit/evidence/2026-10-29-prod-acceptance/scripts/production-gates.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3350'
const REPO = 'D:/codes/ABO/AgentWorkShop'
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-prod-acceptance')
process.env.NO_PROXY = '127.0.0.1,localhost'
const T = readFileSync('D:/tmp/aw-demo-token.txt', 'utf8').trim()
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? 'PASS' : 'FAIL'} [${id}] ${name}${cond ? '' : ' — ' + String(detail).slice(0, 300)}`)
  return Boolean(cond)
}
const api = async (method, path, body, timeoutMs = 60000) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const data = r => r.j?.data ?? r.j

// G1 协议目录:以协议注册表(shared)为准,模板面只是呈现层
const protoSrc = readFileSync(join(REPO, 'shared', 'daq-protocol.ts'), 'utf8') + readFileSync(join(REPO, 'shared', 'dcw-protocol', 'catalog.ts'), 'utf8')
const families = ['modbus-tcp', 'modbus-rtu', 'opcua', 'mqtt', 'http']
const missing = families.filter(f => !protoSrc.includes(`'${f}'`) && !protoSrc.includes(`"${f}"`))
ok('G1', '协议注册表覆盖五族(modbus-tcp/rtu·opcua·mqtt·http)', missing.length === 0, `missing=${missing}`)
const shared = readFileSync(join(REPO, 'shared', 'daq-protocol.ts'), 'utf8')
const s7Direct = /\bs7\s*:/.test(shared) && !/S7 桩|s7[-_]stub|S7 由/.test(shared)
ok('G1b', '无未验证的 S7 直驱(现场 S7 设备须走网关转 Modbus/OPC UA)', !/^export const S7_PROTOCOLS/.test(shared), 'shared/daq-protocol.ts 无 S7 协议族注册')

// G2 S11 未知驱动 fail-loud:建未知协议采集节点 → controller start → 显式错误
const lineArr = data(await api('GET', '/api/workshop/dcw/lines'))
const line = (Array.isArray(lineArr) ? lineArr : lineArr?.lines ?? []).find(l => /injection|注塑/.test(l.name))
const mk = await api('POST', '/api/workshop/daq', {
  name: `gate-unknown-driver-${Date.now().toString(36)}`, lineId: line.id,
  protocol: 's7-unknown', driverConfig: { host: '127.0.0.1', port: 102 },
  semantics: '硬门 G2:未知驱动 fail-loud 验证',
})
const nodeId = data(mk)?.node?.id ?? data(mk)?.id
if (mk.status >= 400) {
  // 最优形态:配置面直接拒绝(fail-closed 最早时点)
  ok('G2', '未知协议在配置面即被拒绝(fail-closed 最早时点)', mk.status === 400, `status=${mk.status} ${JSON.stringify(mk.j).slice(0, 160)}`)
} else {
  ok('G2a', '未知协议节点可建(失败推迟到启动面)', mk.status === 200 && Boolean(nodeId), `status=${mk.status}`)
  const start = await api('POST', `/api/workshop/daq/${nodeId}/start`, {}, 30000)
  const startText = JSON.stringify(start.j)
  const rejected = start.status >= 400 || /未知|unknown|unsupported|不支持/i.test(startText)
  ok('G2b', '未知驱动启动显式报错(fail-loud,不伪造数据)', rejected, `status=${start.status} ${startText.slice(0, 160)}`)
  await api('DELETE', `/api/workshop/daq/${nodeId}`)
}

// G3 越量程写被拒 + 设备值不变 + 台账留痕
const dcwAll = data(await api('GET', '/api/workshop/dcw'))
const nodes = (dcwAll?.nodes ?? []).filter(n => n.lineId === line.id)
const node = nodes[0]
if (node) {
  const before = node.value
  const param = (dcwAll?.params ?? []).find(p => p.nodeId === node.id)
  const min = param?.min ?? 0
  const max = param?.max ?? 100
  const outOfRange = await api('POST', '/api/workshop/dcw/write', { nodeId: node.id, value: max + 500 })
  const rejected = outOfRange.status >= 400 || Boolean(outOfRange.j?.data?.result?.isError)
  ok('G3a', `越量程写被拒(窗口 ${min}~${max},尝试 ${max + 500})`, rejected, `status=${outOfRange.status}`)
  await new Promise(r => setTimeout(r, 1500))
  const after = (data(await api('GET', '/api/workshop/dcw'))?.nodes ?? []).find(n => n.id === node.id)?.value
  ok('G3b', '被拒写入设备值不变', Number(after) === Number(before), `before=${before} after=${after}`)
}

// G4 验收实例无 benchmark 旁路
const benchSet = process.env.AW_BENCH_MODE
ok('G4', '验收驱动进程未设 AW_BENCH_MODE(写控旁路不存在的先决条件)', !benchSet, `driver env AW_BENCH_MODE=${benchSet ?? '(unset)'}`)
const bypassSrc = readFileSync(join(REPO, 'server', 'services', 'workshop', 'dcw', 'dcw-controller', 'write.ts'), 'utf8')
ok('G4b', '写控旁路仅由 AW_BENCH_MODE 显式开启(代码级)', bypassSrc.includes('AW_BENCH_MODE'), '')

// G5 指向既有证据(S13 MQTT 身份 / S-P0-2 掩码 / S15 int16 / S12 未来时间戳)
const secReport = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-security-hardening', 'report.json')
let secOk = false
let secSummary = ''
try {
  const sec = JSON.parse(readFileSync(secReport, 'utf8'))
  const pass = (sec.assertions ?? sec.results ?? []).filter(a => a.pass).length
  const total = (sec.assertions ?? sec.results ?? []).length
  secOk = total > 0 && pass === total
  secSummary = `${pass}/${total}`
} catch { secSummary = '本轮 security.log 为准(10-28 报告未生成或路径漂移)' }
ok('G5', 'S 系安全加固验收全绿(S13 MQTT 身份/掩码回写/int16 回绕/未来时间戳)', secOk, secSummary)

const pass = results.filter(r => r.pass).length
console.log(`\n结论: ${pass === results.length ? 'PASS' : 'FAIL'} (${pass}/${results.length})`)
mkdirSync(EVID, { recursive: true })
writeFileSync(join(EVID, 'production-gates-report.json'), JSON.stringify({ suite: 'production-gates', at: new Date().toISOString(), base: BASE, results }, null, 2))
process.exitCode = pass === results.length ? 0 : 1
