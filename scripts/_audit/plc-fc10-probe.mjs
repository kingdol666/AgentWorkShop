/**
 * plc-fc10-probe.mjs —— FC10 写入后把寄存器窗口整段 dump 出来,看数据实际落在哪里
 */
import ModbusRTU from 'modbus-serial'

const PORT = Number(process.argv[2] ?? 15041)
const c = new ModbusRTU()
await c.connectTCP('127.0.0.1', { port: PORT })
c.setID(1)

const dump = async (label) => {
  const r = (await c.readHoldingRegisters(16, 12)).data
  console.log(label)
  for (let i = 0; i < 12; i++) {
    const off = 16 + i
    console.log(`   off ${String(off).padStart(2)} = 0x${r[i].toString(16).padStart(4, '0')}  (${r[i]})`)
  }
}

await dump('① FC10 写入前 off16..27')
// 用可识别的图案:0xAAAA 0xBBBB 写在 off20/21
await c.writeRegisters(20, [0xAAAA, 0xBBBB])
await dump('② writeRegisters(20, [0xAAAA, 0xBBBB]) 之后')

// 对照:FC06 单写
await c.writeRegister(22, 0xCCCC)
const r = (await c.readHoldingRegisters(22, 1)).data
console.log(`③ writeRegister(22, 0xCCCC) → 0x${r[0].toString(16).padStart(4, '0')}`)

c.close(() => {})
