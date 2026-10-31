#!/usr/bin/env node
/**
 * 2026-10-31 文档驱动虚拟验证用 MQTT mini-broker(复用 plc-node-simulator 的已验证实现)。
 * 只监听 127.0.0.1:18830,供 docs/audit/2026-10-31-doc-driven-virtual-validation.md 的
 * aw/proto/doc/env 多字段发布/订阅使用;不启动 PLC 模拟器其它协议端口。
 */
import { startBroker } from '../../plc-node-simulator/src/server/protocols/mqtt-broker.ts'

const port = Number(process.env.DOC_MQTT_PORT ?? 18830)
await startBroker(port, '127.0.0.1')
console.log(`[proto-doc-broker] ready mqtt://127.0.0.1:${port}`)
