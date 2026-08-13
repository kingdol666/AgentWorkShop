/**
 * CMDParser 协议解析测试 + MCP 接缝验证(node + tsx 直跑,无浏览器)
 *
 * 覆盖:
 *  1. 协议同步(assertProtocolSync):JSON 注册表 ↔ wire 类型键集合一致,example 自洽
 *  2. CMDParser.parseUplink:合法/空/坏JSON/缺字段/未知指令/无效枚举/越界值
 *  3. CMDParser.parseDownlink:合法 + 闭合结构(拒绝额外字段)
 *  4. toMcpTools:agentCallable=true 的 downlink 即工具集,description 非空
 *  5. GameSession.execDownlink:Agent 可调用指令注入成功,会话生命周期指令被 FORBIDDEN 拦截
 */
import {
  assertProtocolSync,
  CMDParser,
  PROTOCOL,
  toMcpTools,
} from '../shared/game-protocol'
import { gameSession } from '../server/services/game/session'
import type { ServerToClient } from '../server/types/game'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

/** 假 WS peer:捕获下行指令(结构兼容 h3 peer) */
class FakePeer {
  sent: ServerToClient[] = []

  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)))
  }

  close(): void {}
}

function testProtocolSync(): void {
  console.log('\n--- 1. 协议同步 ---')
  const report = assertProtocolSync()
  check('downlink 键集合无漂移', report.unsyncedDownlink.length === 0, JSON.stringify(report.downlink))
  check('uplink 键集合无漂移', report.unsyncedUplink.length === 0, JSON.stringify(report.uplink))
  check('所有 example 自洽', report.badExamples.length === 0)
  check('agentCallable 指令存在', report.downlink.some(k => PROTOCOL.downlink[k]?.agentCallable))
}

function testParseUplink(): void {
  console.log('\n--- 2. CMDParser.parseUplink ---')

  // 合法
  const ok = CMDParser.parseUplink('{"type":"input.move","payload":{"dx":1,"dy":0}}')
  check('合法 input.move 解析成功', ok.ok && ok.value.type === 'input.move')

  // 空字符串
  const empty = CMDParser.parseUplink('')
  check('空字符串 → BAD_MESSAGE', !empty.ok && empty.error.code === 'BAD_MESSAGE')

  // 坏 JSON
  const bad = CMDParser.parseUplink('{not json')
  check('坏 JSON → BAD_MESSAGE', !bad.ok && bad.error.code === 'BAD_MESSAGE')

  // 缺 payload
  const noPayload = CMDParser.parseUplink('{"type":"input.move","payload_dx":1}')
  check('缺 payload → BAD_MESSAGE', !noPayload.ok && noPayload.error.code === 'BAD_MESSAGE')

  // 未知指令
  const unknown = CMDParser.parseUplink('{"type":"foo.bar","payload":{}}')
  check('未知指令 → UNKNOWN_COMMAND', !unknown.ok && unknown.error.code === 'UNKNOWN_COMMAND')

  // 无效枚举
  const badEnum = CMDParser.parseUplink('{"type":"input.move","payload":{"dx":2,"dy":0}}')
  check('dx=2 越界枚举 → INVALID_PAYLOAD', !badEnum.ok && badEnum.error.code === 'INVALID_PAYLOAD',
    badEnum.ok ? '' : badEnum.error.path)

  // 缺必填
  const missing = CMDParser.parseUplink('{"type":"player.pos","payload":{"x":1,"y":2}}')
  check('缺 tileX/tileY → INVALID_PAYLOAD', !missing.ok && missing.error.code === 'INVALID_PAYLOAD')
}

function testParseDownlink(): void {
  console.log('\n--- 3. CMDParser.parseDownlink ---')

  const ok = CMDParser.parseDownlink('{"type":"agent.say","payload":{"text":"hi","ttlMs":1000}}')
  check('合法 agent.say 解析成功', ok.ok && ok.value.type === 'agent.say')

  // 闭合结构:拒绝额外字段
  const extra = CMDParser.parseDownlink('{"type":"agent.face","payload":{"dir":"down","extra":1}}')
  check('额外字段被拒绝(闭合 schema)', !extra.ok && extra.error.code === 'INVALID_PAYLOAD')

  // 对象类型指令:缺必填
  const missing = CMDParser.parseDownlink('{"type":"session.ready","payload":{"agentName":"x"}}')
  check('session.ready 缺 spawn → INVALID_PAYLOAD', !missing.ok && missing.error.code === 'INVALID_PAYLOAD')
}

function testMcpTools(): void {
  console.log('\n--- 4. MCP 工具词表 ---')
  const tools = toMcpTools()
  const names = tools.map(t => t.name)
  check('工具数 > 0', tools.length > 0, names.join(','))

  const allCallable = names.every(n => PROTOCOL.downlink[n]?.agentCallable === true)
  check('全部工具对应 agentCallable=true', allCallable)

  const allDescribed = tools.every(t => t.description.length > 0 && t.inputSchema.type === 'object')
  check('每个工具有 description + object inputSchema', allDescribed)

  // 关键 Agent 工具应在册
  check('agent.move 在工具集', names.includes('agent.move'))
  check('agent.say 在工具集', names.includes('agent.say'))
  check('dialog.open 在工具集', names.includes('dialog.open'))

  // 非工具:会话生命周期 + 协议内部指令不应可调用
  check('session.ready 不在工具集', !names.includes('session.ready'))
  check('dialog.advance 不在工具集', !names.includes('dialog.advance'))
  check('error 不在工具集', !names.includes('error'))
}

async function testExecDownlink(): Promise<void> {
  console.log('\n--- 5. GameSession.execDownlink(MCP 接缝) ---')
  const peer = new FakePeer()
  gameSession.connect(peer)
  // connect 后首两条为 session.ready / agent.state,execDownlink 的新指令在其后追加
  const baseline = peer.sent.length

  // Agent 可调用指令:注入成功 + 下行广播
  const res = gameSession.execDownlink('agent.say', { text: '来自 Agent', ttlMs: 1500 })
  check('execDownlink agent.say 成功', res.ok)
  check('agent.say 下发到 peer', peer.sent.length === baseline + 1
  && peer.sent[peer.sent.length - 1]!.type === 'agent.say', `sent=${peer.sent.length}`)

  // 非 agentCallable 指令:FORBIDDEN
  const forbidden = gameSession.execDownlink('session.ready', { agentName: 'x', spawn: { x: 0, y: 0 } })
  check('session.ready 被 FORBIDDEN 拦截', !forbidden.ok && forbidden.error.code === 'FORBIDDEN')

  // 无效 payload:校验失败
  const invalid = gameSession.execDownlink('agent.move', { dir: 'sideways', durationMs: 100 })
  check('agent.move 非法 dir → 校验失败', !invalid.ok && invalid.error.code === 'INVALID_PAYLOAD')
  gameSession.stop()
}

async function main(): Promise<void> {
  testProtocolSync()
  testParseUplink()
  testParseDownlink()
  testMcpTools()
  await testExecDownlink()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
