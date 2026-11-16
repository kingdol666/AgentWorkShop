/**
 * 协议自测 —— OPC UA(真实 node-opcua 客户端,与主项目驱动同栈)。
 * 覆盖:session.read 变量值 / session.write 可写 setpoint → 回读一致(回灌语义)。
 */
import { OPCUAClient, AttributeIds, DataType } from 'node-opcua'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const client = OPCUAClient.create({ endpointMustExist: false })
await client.connect('opc.tcp://127.0.0.1:5840')
check('OPC UA 连接 5840', true)
const session = await client.createSession()

const readNode = async (nodeId: string): Promise<number> => {
  const dv = await session.read({ nodeId, attributeId: AttributeIds.Value })
  return dv.value.value as number
}

const temp = await readNode('ns=2;s=AW.Temp')
check('read AW.Temp(周期刷新值)', Number.isFinite(temp), `value=${Number(temp).toFixed(1)}℃`)

// DCW 语义:写可写 setpoint → 回读一致
const target = 175
const writeStatus = await session.write({
  nodeId: 'ns=2;s=AW.SetTemp',
  attributeId: AttributeIds.Value,
  value: { value: { dataType: DataType.Double, value: target } },
})
check('write AW.SetTemp=175 状态 Good', writeStatus.isGoodish(), String(writeStatus))
const readback = await readNode('ns=2;s=AW.SetTemp')
check('回读 SetTemp 一致(回灌语义)', Math.abs(readback - target) < 0.01, `readback=${readback}`)

await session.close()
await client.disconnect()
console.log(`\nopcua 自测: ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
