/**
 * OPC UA 模拟器(dev)—— 真实 OPC UA 服务器,供驱动真连测试/演示。
 * 端点:opc.tcp://127.0.0.1:4840(仅本机回环)
 * 节点:ns=2;s=AW.Temp(模拟量,周期随机游走)/ ns=2;s=AW.SetTemp(可写设定值)
 * 注意:自定义命名空间 ns=2(ns=0 标准 / ns=1 服务器内部)
 */
import { OPCUAServer, Variant, DataType, StatusCodes } from 'node-opcua'

const PORT = Number(process.env.OPCUA_SIM_PORT ?? 4840)

const server = new OPCUAServer({
  port: PORT,
  hostname: '127.0.0.1',
  buildInfo: { productName: 'AgentWorkShop-OPCUA-Simulator' },
})

await server.initialize()
const addressSpace = server.engine.addressSpace
const ns = addressSpace.registerNamespace('AW-Sim')
const device = ns.addObject({
  organizedBy: addressSpace.rootFolder.objects,
  nodeId: 's=AW.Device',
  browseName: 'AWDevice',
})
const tempVar = ns.addVariable({
  componentOf: device,
  nodeId: 's=AW.Temp',
  browseName: 'Temp',
  dataType: 'Double',
  value: new Variant({ dataType: DataType.Double, value: 168.5 }),
})
ns.addVariable({
  componentOf: device,
  nodeId: 's=AW.SetTemp',
  browseName: 'SetTemp',
  dataType: 'Double',
  value: new Variant({ dataType: DataType.Double, value: 180 }),
})

await server.start()
console.log(`[opcua-sim] 端点 opc.tcp://127.0.0.1:${PORT}(AW-Sim 命名空间 ns=${ns.index})`)
console.log('[opcua-sim] 节点: ns=2;s=AW.Temp(采集) / ns=2;s=AW.SetTemp(设定,可写)')

// Temp 缓慢随机游走(仿真真实过程量)
let t = 168.5
setInterval(() => {
  t += (Math.random() - 0.48) * 0.8
  t = Math.max(150, Math.min(185, t))
  tempVar.setValueFromSource({ dataType: DataType.Double, value: Number(t.toFixed(2)) })
}, 1000)

// 优雅退出
process.on('SIGINT', async () => {
  await server.shutdown()
  process.exit(0)
})
void StatusCodes.Good
