/**
 * OPC UA 服务器 —— node-opcua,与主项目 dev-opcua-simulator 同构。
 *   - 自定义命名空间(默认第一个自定义 ns = index 2,与主项目 nodeId 'ns=2;s=…' 约定一致)
 *   - 变量节点周期刷新信号值;可写变量(setpoint)被 DCW session.write 写入后回灌信号
 *   - 可选 username/password 认证(SecurityPolicy None + UserPassword;证书模式留待后续)
 */
import type { DeviceNode } from '../../shared/types'
import type { ProtocolHandle } from './registry'
import { applyWriteback } from '../engine/signals'
import { saveConfig } from '../store'

const DATA_TYPE_MAP: Record<string, string> = {
  Double: 'Double', Float: 'Float', Int16: 'Int16', UInt16: 'UInt16', Int32: 'Int32', UInt32: 'UInt32', Boolean: 'Boolean',
}

export async function startOpcUa(node: DeviceNode): Promise<ProtocolHandle> {
  const { OPCUAServer, Variant, DataType } = await import('node-opcua')
  const port = node.config.port ?? 4840
  const hostname = node.config.host ?? '127.0.0.1'
  const vars = node.config.opcVars ?? []

  const userManager = node.config.username
    ? {
        isValidUser: (userName: string, password: string) => userName === node.config.username && password === (node.config.password ?? ''),
      }
    : undefined

  const server = new OPCUAServer({
    port,
    hostname,
    // 模拟器会被多个客户端(主项目连接池/测试/探针)反复拨入,默认每端点上限(10)会被
    // 残留半开连接顶爆(表现为 "maximum number of connection has been reached"),放宽
    maxConnectionsPerEndpoint: 256,
    // 会话上限同步放宽(engine.serverCapabilities.maxSessions,默认很小,多客户端轮询即 BadTooManySessions)
    serverCapabilities: { maxSessions: 512 } as never,
    buildInfo: { productName: `PLC-Simulator:${node.name}` },
    ...(userManager ? { userManager: userManager as never } : {}),
  })
  await server.initialize()
  const addressSpace = server.engine.addressSpace
  const ns = addressSpace!.registerNamespace(node.config.namespaceUri ?? 'PLC-Simulator')
  const device = ns.addObject({
    organizedBy: addressSpace!.rootFolder.objects,
    nodeId: `s=${node.name}.Device`,
    browseName: node.name.slice(0, 32),
  })

  const variables: Array<{ varNode: { setValueFromSource: (v: { dataType: unknown, value: unknown }) => void, on: (ev: string, fn: (dv: { value: { value: unknown } }) => void) => void }, signalId: string, dt: string }> = []
  for (const v of vars) {
    const sig = (node.signals ?? []).find(s => s.id === v.signalId)
    const dtName = DATA_TYPE_MAP[v.dataType] ?? 'Double'
    const varNode = ns.addVariable({
      componentOf: device,
      // 用户 nodeId 'ns=2;s=Foo' → 注册 's=Foo'(namespace index 由 registerNamespace 决定)
      nodeId: v.nodeId.includes(';') ? v.nodeId.split(';')[1]! : v.nodeId,
      browseName: (sig?.name ?? v.nodeId).slice(0, 32),
      dataType: dtName as never,
      value: new Variant({ dataType: DataType[dtName as keyof typeof DataType], value: sig?.runtime?.value ?? 0 }),
      ...(v.writable ? { accessLevel: 'CurrentRead | CurrentWrite' as never, userAccessLevel: 'CurrentRead | CurrentWrite' as never } : {}),
    })
    variables.push({ varNode: varNode as never, signalId: v.signalId, dt: dtName })
  }

  // value_changed 监听:外部写 → 回灌(先注册,再启动 server 与刷新定时器——
  // 若 start 抛错(端口占用),无定时器泄漏)
  for (const v of variables) {
    v.varNode.on('value_changed', (dv) => {
      const sig = (node.signals ?? []).find(s => s.id === v.signalId)
      const m = vars.find(x => x.signalId === v.signalId)
      if (!sig?.runtime || !m?.writable) return
      const incoming = dv.value.value as number
      // 自己刷新的值与 runtime.value 相同 → 忽略;不同 → 外部写,回灌
      if (typeof incoming === 'number' && Math.abs(incoming - sig.runtime.value) > 1e-9) {
        applyWriteback(sig, incoming)
        // External PLC writes are part of the simulator's durable field state.
        // Persist the setpoint strategy so a simulator restart cannot roll the
        // protocol node back to its stale blueprint value.
        saveConfig()
      }
    })
  }

  await server.start()

  // 周期刷新:信号值 → 变量
  const refresh = setInterval(() => {
    for (const v of variables) {
      const sig = (node.signals ?? []).find(s => s.id === v.signalId)
      if (!sig?.runtime) continue
      v.varNode.setValueFromSource({ dataType: DataType[v.dt as keyof typeof DataType], value: sig.runtime.value })
    }
  }, Math.max(node.tickMs, 500))

  const endpoint = `opc.tcp://${hostname}:${port}`
  const handle: ProtocolHandle = {
    close: async () => {
      clearInterval(refresh)
      await server.shutdown()
    },
    summary: () => ({ protocol: 'opcua', endpoint, namespace: ns.index, vars: vars.length, signals: node.signals.length }),
  }
  return handle
}
